import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  CircleCheck,
  Ticket,
  TicketCheck,
  GitPullRequest,
  GitPullRequestArrow,
  GitMerge,
  Rocket,
  FlaskConical,
  ScanSearch,
  FileText,
  Hand,
  LogOut,
  Cpu,
  Bot,
  TriangleAlert,
  Info,
  Search,
  type LucideIcon,
} from 'lucide-react'
import { activityTone } from '../../lib/badges'
import { badgeClasses } from '../../components/ui'
import { navigateTo } from '../../lib/nav'
import type { Tab, TabContext, ActivityEvent, ActivityKind } from '../../lib/types'

// Decide where clicking an activity row should take you. Priority:
//   runId  → Runs tab + pre-select that run
//   ref.pr → MRs tab (no payload — the tab opens to its own selection)
//   ref.ticket present + kind starts with 'ticket' → Tickets tab
async function navForEvent(ev: ActivityEvent): Promise<void> {
  if (ev.runId) return navigateTo('runs', { runId: ev.runId })
  if (ev.ref?.pr) return navigateTo('mrs', { iid: ev.ref.pr })
  if (ev.ref?.ticket) {
    // Look up the slug by ticket id — tickets:list is cheap (single file read).
    try {
      const tickets = await window.gt.tickets.list()
      const match = tickets.find((t) => Number(t.id) === ev.ref!.ticket)
      if (match) return navigateTo('tickets', { slug: match.slug })
    } catch {
      /* fall through */
    }
    return navigateTo('tickets')
  }
}

const ICON: Record<ActivityKind, LucideIcon> = {
  'session-start': Cpu,
  'session-end': LogOut,
  'ticket-filed': Ticket,
  'ticket-closed': TicketCheck,
  'pr-opened': GitPullRequestArrow,
  'pr-verdict': GitPullRequest,
  'pr-merged': GitMerge,
  deploy: Rocket,
  'tests-pass': FlaskConical,
  'tests-fail': FlaskConical,
  check: ScanSearch,
  doc: FileText,
  'agent-run': Bot,
  'task-complete': CircleCheck,
  blocked: Hand,
  error: TriangleAlert,
  info: Info,
}

const KIND_LABEL: Record<ActivityKind, string> = {
  'session-start': 'session',
  'session-end': 'session end',
  'ticket-filed': 'ticket',
  'ticket-closed': 'closed',
  'pr-opened': 'opened',
  'pr-verdict': 'review',
  'pr-merged': 'merged',
  deploy: 'deploy',
  'tests-pass': 'tests',
  'tests-fail': 'tests',
  check: 'check',
  doc: 'doc',
  'agent-run': 'agent',
  'task-complete': 'task',
  blocked: 'blocked',
  error: 'error',
  info: 'info',
}

function reltime(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 10) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Day bucket label for the timeline dividers (Today / Yesterday / weekday / date).
function dayLabel(ts: number): string {
  const d = new Date(ts)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Group the (already newest-first) events into consecutive day buckets.
function groupByDay(events: ActivityEvent[]): { label: string; items: ActivityEvent[] }[] {
  const groups: { label: string; items: ActivityEvent[] }[] = []
  for (const e of events) {
    const label = dayLabel(e.ts)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(e)
    else groups.push({ label, items: [e] })
  }
  return groups
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
        active
          ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
          : 'border-[var(--gt-border)] text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}

type Scope = 'all' | 'repo' | 'session'

function ActivityTab({ ctx }: { ctx: TabContext }) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [scope, setScope] = useState<Scope>('all')
  const [kindFilter, setKindFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [, force] = useState(0) // re-tick relative times
  const newest = useRef<string>('') // id of the most recent event, for the live flash

  useEffect(() => {
    // viewing the feed clears the unseen-high-signal tab badge
    localStorage.setItem('gt.activity.lastSeen', String(Date.now()))
    window.gt.activity.list().then((e) => {
      setEvents(e)
      newest.current = e[0]?.id || ''
    })
    const off = window.gt.activity.onEvent((ev) => {
      newest.current = ev.id
      setEvents((prev) => [ev, ...prev].slice(0, 1000))
    })
    const t = setInterval(() => force((n) => n + 1), 30_000) // refresh "Nm ago"
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const scoped = events.filter((e) =>
    scope === 'all'
      ? true
      : scope === 'repo'
        ? e.repoRoot === ctx.repoRoot
        : e.sessionId === ctx.sessionId,
  )
  // kind chips reflect what's actually present in the current scope
  const kindsPresent = [...new Set(scoped.map((e) => e.kind))].sort()
  const q = query.trim().toLowerCase()
  const shown = scoped.filter(
    (e) =>
      (kindFilter === 'all' || e.kind === kindFilter) &&
      (!q || `${e.title} ${e.detail || ''} ${e.repo || ''}`.toLowerCase().includes(q)),
  )

  const clear = async () => {
    await window.gt.activity.clear()
    setEvents([])
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gt-bg)]">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--gt-border)] px-4 py-2">
        <Activity size={14} strokeWidth={2} className="text-[var(--gt-accent-2)]" />
        <span className="mr-1 text-[12px] font-semibold text-zinc-200">Activity</span>
        <span className="inline-flex items-center gap-1 text-[10px] text-zinc-600">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--gt-green)] gt-pulse" />
          live
        </span>
        <span className="mx-1 text-zinc-700">·</span>
        <Chip active={scope === 'all'} onClick={() => setScope('all')}>
          all repos
        </Chip>
        <Chip active={scope === 'repo'} onClick={() => setScope('repo')}>
          this repo
        </Chip>
        <Chip active={scope === 'session'} onClick={() => setScope('session')}>
          this session
        </Chip>
        <div className="flex-1" />
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="cursor-pointer rounded-md border border-[var(--gt-border)] bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none focus:border-[var(--gt-accent)]/60"
        >
          <option value="all">all kinds</option>
          {kindsPresent.map((k) => (
            <option key={k} value={k} className="bg-[var(--gt-panel)]">
              {KIND_LABEL[k as ActivityKind] || k}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search
            size={11}
            strokeWidth={2}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-zinc-600"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search…"
            className="w-28 rounded-md border border-[var(--gt-border)] bg-black/30 py-0.5 pl-5 pr-1.5 text-[11px] text-zinc-200 outline-none focus:w-40 focus:border-[var(--gt-accent)]/60"
          />
        </div>
        <span className="text-[11px] tabular-nums text-zinc-600">{shown.length}</span>
        <button
          onClick={clear}
          className="rounded-md px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
        >
          clear
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <div className="p-6 text-[12px] text-zinc-600">
            {events.length === 0
              ? 'No activity yet. Session starts, tickets, PRs, reviews, test runs, checks, docs, and agent runs show up here (and as macOS notifications).'
              : 'No activity matches the current filters.'}
          </div>
        ) : (
          groupByDay(shown).map((g) => (
            <div key={g.label}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--gt-bg)]/90 px-4 py-1.5 backdrop-blur">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  {g.label}
                </span>
                <span className="text-[10px] tabular-nums text-zinc-700">{g.items.length}</span>
                <div className="h-px flex-1 bg-[var(--gt-border)]/50" />
              </div>
              {g.items.map((e) => {
                const Icon = ICON[e.kind] || Info
                const tone = activityTone(e.kind)
                const isNew = e.id === newest.current
                const hasNav = !!(e.runId || e.ref?.pr || e.ref?.ticket)
                return (
                  <div
                    key={e.id}
                    onClick={hasNav ? () => navForEvent(e) : undefined}
                    role={hasNav ? 'button' : undefined}
                    title={
                      hasNav
                        ? e.runId
                          ? 'Jump to this run'
                          : e.ref?.pr
                            ? 'Open this PR/MR'
                            : 'Open this ticket'
                        : undefined
                    }
                    className={`group relative flex gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.03] ${
                      isNew ? 'gt-pop-in' : ''
                    } ${hasNav ? 'cursor-pointer' : ''}`}
                  >
                    {/* timeline rail: a continuous line with the kind node sitting on it */}
                    <div className="relative flex w-5 shrink-0 justify-center">
                      <span className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-[var(--gt-border)]/70" />
                      <span
                        className={`relative z-10 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border bg-[var(--gt-bg)] ${badgeClasses(
                          tone,
                        )} ${isNew ? 'gt-pulse' : ''}`}
                      >
                        <Icon size={11} strokeWidth={2.25} />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{e.title}</span>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-600">
                          {reltime(e.ts)}
                        </span>
                      </div>
                      {e.detail && (
                        <div className="truncate text-[11.5px] text-zinc-500" title={e.detail}>
                          {e.detail}
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-full border px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide ${badgeClasses(
                            tone,
                          )}`}
                        >
                          {KIND_LABEL[e.kind] || e.kind}
                        </span>
                        {e.repo && scope === 'all' && (
                          <span className="truncate font-mono text-[10px] text-zinc-600">{e.repo}</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const tab: Tab = {
  id: 'activity',
  title: 'Activity',
  icon: Activity,
  order: 5,
  appliesTo: () => true, // global feed, always available
  // badge = unseen high-signal events (errors, blockers, test fails) since last view
  badge: async (gt) => {
    const seen = Number(localStorage.getItem('gt.activity.lastSeen') || 0)
    const hi = new Set(['error', 'blocked', 'tests-fail'])
    return (await gt.activity.list()).filter((e) => e.ts > seen && hi.has(e.kind)).length
  },
  Component: ActivityTab,
}
export default tab

import { useEffect, useState } from 'react'
import { Layers, Ticket, GitPullRequest, ArrowUpRight, GitBranch } from 'lucide-react'
import { Badge } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import { sessionStatusTone } from '../../lib/badges'
import { fmtAgo } from '../../lib/format'
import type { Tab, TabContext, ProjectSession } from '../../lib/types'

const STATUSES = ['active', 'closed', 'abandoned']

// Use the canonical, tested formatter so sub-minute timestamps read "just now"
// instead of "0m ago", consistent with the rest of the app.
function reldate(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (isNaN(t)) return iso
  return fmtAgo(t)
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
        active
          ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
          : 'border-[var(--gt-border)] text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}

function SessionsTab({ ctx }: { ctx: TabContext }) {
  const [list, setList] = useState<ProjectSession[] | null>(null)
  const [sel, setSel] = useState<ProjectSession | null>(null)
  const [fStatus, setFStatus] = useState('all')

  const load = () => window.gt.projectSessions().then(setList)
  useEffect(() => {
    load()
  }, [ctx.sessionId])

  const open = async (slug: string) => setSel(await window.gt.getProjectSession(slug))
  const shown = (list || []).filter((s) => fStatus === 'all' || s.status === fStatus)
  const activeCount = (list || []).filter((s) => s.status === 'active').length

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gt-bg)]">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--gt-border)] px-4 py-2">
        <span className="mr-1 text-[12px] font-semibold text-zinc-200">
          Sessions {list ? `(${list.length})` : ''}
        </span>
        {activeCount > 0 && <Badge tone="green">{activeCount} active</Badge>}
        <span className="mx-1 text-zinc-700">·</span>
        <Chip active={fStatus === 'all'} onClick={() => setFStatus('all')}>
          all
        </Chip>
        {STATUSES.map((s) => (
          <Chip key={s} active={fStatus === s} onClick={() => setFStatus(s)}>
            {s}
          </Chip>
        ))}
        <span className="truncate text-[11px] text-zinc-600">{ctx.repoPath}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-[42%] min-w-[280px] overflow-y-auto border-r border-[var(--gt-border)]">
          {list === null ? (
            <div className="p-6 text-[12px] text-zinc-600">Loading…</div>
          ) : shown.length === 0 ? (
            <div className="p-6 text-[12px] leading-relaxed text-zinc-600">
              No session docs in <span className="font-mono">sessions/</span> yet. Start one with{' '}
              <span className="font-mono text-zinc-400">/session-start</span> in the terminal.
            </div>
          ) : (
            shown.map((s) => (
              <button
                key={s.slug}
                onClick={() => open(s.slug)}
                className={`block w-full border-b border-[var(--gt-border)]/60 px-4 py-2.5 text-left hover:bg-white/5 ${
                  sel?.slug === s.slug ? 'bg-white/5' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-zinc-600">{s.anchor || `#${s.id}`}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{s.title}</span>
                  <Badge tone={sessionStatusTone(s.status)}>{s.status}</Badge>
                </div>
                <div className="mt-0.5 flex items-center gap-2 truncate text-[11px] text-zinc-600">
                  {s.tickets.length > 0 && (
                    <span className="inline-flex items-center gap-0.5">
                      <Ticket size={11} strokeWidth={2} />
                      {s.tickets.length}
                    </span>
                  )}
                  {s.prs.length > 0 && (
                    <span className="inline-flex items-center gap-0.5">
                      <GitPullRequest size={11} strokeWidth={2} />
                      {s.prs.length}
                    </span>
                  )}
                  <span>{reldate(s.ended || s.started)}</span>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {!sel ? (
            <div className="flex h-full items-center justify-center text-[12px] text-zinc-600">
              Select a session.
            </div>
          ) : (
            <div className="p-5">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-600">
                <span className="font-mono">{sel.anchor || `#${sel.id}`}</span>
                <Badge tone={sessionStatusTone(sel.status)}>{sel.status}</Badge>
                {sel.started && <span>started {reldate(sel.started)}</span>}
                {sel.ended && <span>ended {reldate(sel.ended)}</span>}
              </div>
              <h1 className="mb-2 text-lg font-bold text-zinc-100">{sel.title}</h1>
              {sel.goal && (
                <div className="mb-3 rounded-lg border border-[var(--gt-border)] bg-[var(--gt-panel)] p-2.5 text-[12px] text-zinc-300">
                  <span className="text-zinc-500">goal: </span>
                  {sel.goal}
                </div>
              )}
              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                {sel.tickets.length > 0 && <span>tickets {sel.tickets.join(', ')}</span>}
                {sel.branches.length > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <GitBranch size={11} strokeWidth={2} />
                    {sel.branches.join(', ')}
                  </span>
                )}
                {sel.prs.map((p) => (
                  <button
                    key={p}
                    onClick={() => window.gt.openExternal(p)}
                    className="inline-flex items-center gap-0.5 text-[var(--gt-accent-2)] hover:underline"
                  >
                    {p.replace(/^https?:\/\/[^/]+\//, '').replace(/\/-\/merge_requests\//, ' !')}
                    <ArrowUpRight size={11} strokeWidth={2} />
                  </button>
                ))}
              </div>
              {sel.body ? (
                <Markdown>{sel.body}</Markdown>
              ) : (
                <div className="text-[12px] italic text-zinc-600">No body.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const tab: Tab = {
  id: 'sessions',
  title: 'Sessions',
  icon: Layers,
  order: 6,
  // Always available for a repo (peer to Tickets & MRs); shows the repo's
  // sessions/ docs, with an empty state until /session-start creates one.
  appliesTo: (ctx) => ctx.hasSessions || !!ctx.repoRoot,
  Component: SessionsTab,
}
export default tab

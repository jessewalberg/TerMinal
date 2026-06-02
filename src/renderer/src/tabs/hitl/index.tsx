import { useEffect, useState } from 'react'
import { Hand, Check, Trash2, RotateCcw, ListChecks, Repeat, Ticket as TicketIcon } from 'lucide-react'
import { Badge } from '../../components/ui'
import type { BadgeTone } from '../../components/ui'
import { navigateTo } from '../../lib/nav'
import { groupHitlByRepo } from '../../lib/hitlGrouping'
import type { Tab, TabContext, HitlItem } from '../../lib/types'

// Derive the Tickets-tab slug (file basename without extension) from a ticket
// path. Cron-failure HITLs pair with a ticket whose path looks like
// `…/backlog/0123-cron-fail-foo.md` — the slug is `0123-cron-fail-foo`.
function ticketSlugFromPath(path: string): string {
  const base = path.split('/').pop() || ''
  return base.replace(/\.md$/, '')
}

// Human-in-the-loop: a GLOBAL, cross-repo inbox of TRUE human-needs — decisions,
// approvals, creds, a failed cron job. NOT per-repo backlog tickets, and NOT
// review request-changes (those are iterative workflow). Filing one pings Telegram;
// the tab shows a red count of open items.
const SOURCE_TONE: Record<string, BadgeTone> = {
  'cron-fail': 'red',
  agent: 'blue',
  factory: 'accent',
  skill: 'blue',
  manual: 'mute',
}

function reltime(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function HitlTab(_props: { ctx: TabContext }) {
  const [items, setItems] = useState<HitlItem[] | null>(null)
  const [showResolved, setShowResolved] = useState(false)

  const reload = () => window.gt.hitl.list().then(setItems)
  useEffect(() => {
    reload()
    // pick up newly auto-filed items (e.g. a failed cron) live
    const off = window.gt.activity.onEvent((ev) => {
      if (ev.kind === 'blocked') reload()
    })
    const t = setInterval(reload, 15_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const open = (items || []).filter((h) => h.status === 'open')
  const resolved = (items || []).filter((h) => h.status === 'resolved')
  const shown = showResolved ? resolved : open

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gt-bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gt-border)] px-4 py-2">
        <Hand size={14} strokeWidth={2} className="text-[var(--gt-red)]" />
        <span className="text-[12px] font-semibold text-zinc-200">Human-in-the-loop</span>
        <span className="text-[11px] text-zinc-600">one global inbox · everything that needs you</span>
        <div className="flex-1" />
        <button
          onClick={() => setShowResolved((v) => !v)}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
            showResolved
              ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
              : 'border-[var(--gt-border)] text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {showResolved ? `resolved (${resolved.length})` : `open (${open.length})`}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items === null ? (
          <div className="p-3 text-[12px] text-zinc-600">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="p-3 text-[12px] text-zinc-600">
            {showResolved
              ? 'Nothing resolved yet.'
              : 'Nothing needs you. True human-needs (decisions, approvals, creds, failed cron runs) land here from any repo — and ping Telegram.'}
          </div>
        ) : (
          <div className="space-y-5">
            {groupHitlByRepo(shown).map((g) => (
              <div key={g.repoRoot || g.repo || 'none'}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                    {g.repo}
                  </span>
                  <span className="text-[10px] tabular-nums text-zinc-600">{g.items.length}</span>
                  {g.recurring.length > 0 && (
                    <span
                      title={`"${g.recurring[0].title}" recurred ${g.recurring[0].count}×`}
                      className="inline-flex items-center gap-1 rounded-full border border-[var(--gt-yellow)]/30 bg-[var(--gt-yellow)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--gt-yellow)]"
                    >
                      <Repeat size={10} strokeWidth={2.5} />
                      {g.recurring[0].count}× recurring
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {g.items.map((h) => (
              <div
                key={h.id}
                className={`rounded-xl border bg-[var(--gt-panel)] p-3 ${
                  h.status === 'open' ? 'border-[var(--gt-red)]/30' : 'border-[var(--gt-border)] opacity-70'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-semibold text-zinc-100">{h.title}</span>
                      <Badge tone={SOURCE_TONE[h.source] || 'mute'}>{h.source}</Badge>
                      {h.repo && <span className="font-mono text-[10px] text-zinc-600">{h.repo}</span>}
                      <span className="text-[10px] text-zinc-600">· {reltime(h.createdAt)}</span>
                    </div>
                    {h.action && <div className="mt-1 text-[12px] text-[var(--gt-accent-light)]">{h.action}</div>}
                    {h.detail && <div className="mt-0.5 text-[11.5px] leading-snug text-zinc-500">{h.detail}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {h.runId && (
                      <button
                        onClick={() => navigateTo('runs', { runId: h.runId })}
                        title="Jump to the run that filed this HITL"
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-100"
                      >
                        <ListChecks size={11} strokeWidth={2} />
                        View run
                      </button>
                    )}
                    {h.ticketPath && (
                      <button
                        onClick={() =>
                          navigateTo('tickets', { slug: ticketSlugFromPath(h.ticketPath!) })
                        }
                        title="Jump to the backlog ticket auto-filed alongside this HITL"
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-100"
                      >
                        <TicketIcon size={11} strokeWidth={2} />
                        View ticket
                      </button>
                    )}
                    {h.status === 'open' ? (
                      <button
                        onClick={async () => {
                          await window.gt.hitl.resolve(h.id, true)
                          reload()
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-300 hover:border-[var(--gt-green)]/60 hover:text-[var(--gt-green)]"
                      >
                        <Check size={12} strokeWidth={2.5} />
                        Resolve
                      </button>
                    ) : (
                      <button
                        onClick={async () => {
                          await window.gt.hitl.resolve(h.id, false)
                          reload()
                        }}
                        title="Reopen"
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
                      >
                        <RotateCcw size={11} strokeWidth={2} />
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        if (!confirm('Remove this HITL item?')) return
                        await window.gt.hitl.remove(h.id)
                        reload()
                      }}
                      title="Remove"
                      className="inline-flex items-center justify-center rounded-md border border-[var(--gt-border)] px-1.5 py-1 text-zinc-500 hover:border-[var(--gt-red)]/60 hover:text-[var(--gt-red)]"
                    >
                      <Trash2 size={11} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const tab: Tab = {
  id: 'hitl',
  title: 'HITL',
  icon: Hand,
  order: 4,
  appliesTo: () => true, // global inbox — always available
  badge: async (gt) => (await gt.hitl.list()).filter((h) => h.status === 'open').length,
  Component: HitlTab,
}
export default tab

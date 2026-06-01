import { useEffect, useState } from 'react'
import { GitPullRequestArrow, RefreshCw, CheckCircle2 } from 'lucide-react'
import { Badge, Empty } from '../../components/ui'
import type { Tab, FleetMrSummary } from '../../lib/types'

// Cross-repo PR/MR triage: "which PRs are ready vs need changes across every
// repo" in one place — the one fleet-grain view the per-active-repo MRs tab
// can't give. Backed by fleet:mrs (60s-cached mrSummary per known repo),
// fetched on demand (the forge CLI is slow to fan out), never polled.

// Most-actionable first: high-risk open PRs, then ready-to-merge, then changes-requested.
const rank = (r: FleetMrSummary) =>
  r.riskHigh * 10_000 + r.approve * 1000 + r.changes * 10 + r.open

function TriageTab() {
  const [rows, setRows] = useState<FleetMrSummary[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = () => {
    setLoading(true)
    window.gt
      .fleetMrs()
      .then((r) => setRows([...r].sort((a, b) => rank(b) - rank(a))))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const totalReady = (rows || []).reduce((n, r) => n + r.approve, 0)
  const totalOpen = (rows || []).reduce((n, r) => n + r.open, 0)

  return (
    <div className="flex h-full flex-col bg-[var(--gt-bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gt-border)] px-4 py-2.5">
        <GitPullRequestArrow size={15} strokeWidth={2} className="text-[var(--gt-accent-2)]" />
        <span className="text-[13px] font-bold text-zinc-100">PR Triage</span>
        <span className="text-[11px] text-zinc-600">
          {rows ? `${totalOpen} open across ${rows.length} repo${rows.length === 1 ? '' : 's'}` : '…'}
          {totalReady > 0 && ` · ${totalReady} ready to merge`}
        </span>
        <div className="flex-1" />
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[10.5px] text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-200 disabled:opacity-50"
        >
          <RefreshCw size={11} strokeWidth={2} className={loading ? 'animate-spin' : ''} /> refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!rows ? (
          <div className="text-[12px] text-zinc-500">Scanning known repos…</div>
        ) : rows.length === 0 ? (
          <Empty>No open PRs across your known repos. 🎉</Empty>
        ) : (
          <div className="space-y-1.5">
            {rows.map((r) => (
              <div
                key={r.repoRoot}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 ${
                  r.approve > 0
                    ? 'border-[var(--gt-green)]/30 bg-[var(--gt-green)]/5'
                    : 'border-[var(--gt-border)] bg-[var(--gt-panel)]'
                }`}
              >
                {r.approve > 0 && (
                  <CheckCircle2 size={14} strokeWidth={2.25} className="shrink-0 text-[var(--gt-green)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100">{r.repo}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-600">
                  {r.open} {r.label}
                  {r.open === 1 ? '' : 's'}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {r.riskHigh > 0 && <Badge tone="bad">🔴 {r.riskHigh} high</Badge>}
                  {r.riskMedium > 0 && <Badge tone="warn">🟡 {r.riskMedium} medium</Badge>}
                  {r.riskUnscored > 0 && <Badge tone="mute">— {r.riskUnscored} unscored</Badge>}
                  {r.approve > 0 && <Badge tone="ok">{r.approve} ready</Badge>}
                  {r.changes > 0 && <Badge tone="bad">{r.changes} changes</Badge>}
                  {r.needsReview > 0 && <Badge tone="mute">{r.needsReview} review</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[10px] text-zinc-600">
          Covers repos with open sessions or schedules. Open a repo's session to merge from its MRs tab.
        </p>
      </div>
    </div>
  )
}

const tab: Tab = {
  id: 'triage',
  title: 'Triage',
  icon: GitPullRequestArrow,
  order: 3.65, // beside the Factory (3.6) fleet-grain cluster
  appliesTo: () => true, // global
  Component: TriageTab,
}
export default tab

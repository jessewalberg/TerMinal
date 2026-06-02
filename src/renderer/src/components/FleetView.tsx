import { useEffect, useState } from 'react'
import { LayoutDashboard, X, Plus, GitBranch, EyeOff, Eye, CalendarClock } from 'lucide-react'
import { Gauge } from './ui'
import { fmtTokens } from '../lib/format'
import type { FleetSession, RepoInventory } from '../lib/types'

const shortModel = (m: string) =>
  m.replace('claude-', '').replace(/-(\d+)-(\d+)/, '-$1.$2').replace(/\[1m\]/, ' 1M')

// Cross-session command center: every live session at a glance.
export function FleetView({
  sessions,
  activeKey,
  onPick,
  onClose,
  onNew,
}: {
  sessions: FleetSession[]
  activeKey: string | null
  onPick: (key: string) => void
  onClose: () => void
  onNew: () => void
}) {
  const working = sessions.filter((s) => s.status === 'working').length
  const needsMe = sessions.filter((s) => s.status === 'awaiting').length
  return (
    <div className="flex h-full flex-col bg-[var(--gt-bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gt-border)] px-4 py-2.5">
        <LayoutDashboard size={15} strokeWidth={2} className="text-[var(--gt-accent-2)]" />
        <span className="text-[13px] font-bold text-zinc-100">Fleet</span>
        <span className="text-[11px] text-zinc-600">
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
          {working > 0 && ` · ${working} working`}
        </span>
        {needsMe > 0 && (
          <span className="rounded-md border border-[var(--gt-yellow)]/30 bg-[var(--gt-yellow)]/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--gt-yellow)]">
            {needsMe} needs you
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={onNew}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2.5 py-1 text-[11px] font-medium text-zinc-300 hover:border-[var(--gt-accent)]/60 hover:text-white"
        >
          <Plus size={13} strokeWidth={2.5} />
          New session
        </button>
        <button
          onClick={onClose}
          className="flex items-center rounded-md p-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
        >
          <X size={15} strokeWidth={2} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {sessions.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-zinc-600">
            No live sessions.
          </div>
        ) : (
          // Group by repo so the Fleet view matches the workspace mental
          // model — one card group per project, sessions inside.
          (() => {
            const byRepo = new Map<string, FleetSession[]>()
            for (const s of sessions) {
              const r = s.repo || '(no repo)'
              if (!byRepo.has(r)) byRepo.set(r, [])
              byRepo.get(r)!.push(s)
            }
            const groups = [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            return (
              <div className="space-y-5">
                {groups.map(([repo, list]) => (
                  <div key={repo}>
                    <div className="mb-2 flex items-baseline gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                        {repo.replace(/\/$/, '').split('/').pop() || repo}
                      </span>
                      <span className="text-[10px] tabular-nums text-zinc-600">
                        {list.length} session{list.length === 1 ? '' : 's'}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-700">{repo}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 2xl:grid-cols-3">
                      {list.map((s) => {
              const on = s.key === activeKey
              const wk = s.status === 'working'
              const aw = s.status === 'awaiting'
              return (
                <button
                  key={s.key}
                  onClick={() => onPick(s.key)}
                  className={`flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors ${
                    on
                      ? 'border-[var(--gt-accent)]/60 bg-[var(--gt-accent)]/10'
                      : aw
                        ? 'border-[var(--gt-yellow)]/50 bg-[var(--gt-yellow)]/5 hover:bg-[var(--gt-yellow)]/10'
                        : 'border-[var(--gt-border)] bg-[var(--gt-panel)] hover:border-[var(--gt-accent)]/40 hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        aw ? 'bg-[var(--gt-yellow)] gt-pulse' : wk ? 'bg-[var(--gt-green)] gt-pulse' : 'bg-zinc-600'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100">
                      {s.name}
                    </span>
                    <span
                      className={`shrink-0 text-[9.5px] uppercase tracking-wide ${
                        aw ? 'font-semibold text-[var(--gt-yellow)]' : 'text-zinc-600'
                      }`}
                    >
                      {aw ? 'needs you' : wk ? 'working' : 'idle'}
                    </span>
                  </div>

                  <div className="line-clamp-2 min-h-[2.2em] text-[11.5px] leading-snug text-zinc-400">
                    {s.aiTitle || <span className="italic text-zinc-600">untitled session</span>}
                  </div>

                  {wk && s.lastAction && (
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--gt-accent-2)] gt-pulse" />
                      <span className="font-medium text-zinc-300">{s.lastAction.tool}</span>
                      {s.lastAction.detail && (
                        <span className="min-w-0 truncate">{s.lastAction.detail}</span>
                      )}
                    </div>
                  )}

                  {s.contextLimit > 0 && (
                    <div>
                      <div className="mb-1 flex items-baseline justify-between text-[10px] text-zinc-600">
                        <span className="tabular-nums text-zinc-400">{s.contextPct.toFixed(0)}% ctx</span>
                        <span className="tabular-nums">{fmtTokens(s.contextTokens)}</span>
                      </div>
                      <Gauge pct={s.contextPct} />
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-600">
                    <span className="text-zinc-500">{shortModel(s.model)}</span>
                    {s.branch && (
                      <span className="inline-flex items-center gap-0.5">
                        <GitBranch size={10} strokeWidth={2} />
                        {s.branch}
                      </span>
                    )}
                    <span className="tabular-nums">{s.turns} turns</span>
                    <span className="min-w-0 flex-1 truncate text-right font-mono text-zinc-700">
                      {s.repo}
                    </span>
                  </div>
                </button>
              )
            })}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()
        )}
        <RepoInventorySection />
      </div>
    </div>
  )
}

const BUCKET_META: Record<RepoInventory['bucket'], { label: string; dot: string }> = {
  active: { label: 'Active', dot: 'bg-[var(--gt-green)]' },
  dormant: { label: 'Dormant', dot: 'bg-[var(--gt-yellow)]' },
  dead: { label: 'Dead', dot: 'bg-zinc-600' },
}

// Cross-repo inventory: every git repo under the projects dir, bucketed by
// last-activity age — surfaces dormant/dead repos that have no live session and
// so never appear above. Ticket #14. Self-fetches so the parent stays untouched.
function RepoInventorySection() {
  const [repos, setRepos] = useState<RepoInventory[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.gt.fleetRepos().then((r) => {
      setRepos(r)
      setLoaded(true)
    })
  }, [])

  const toggleHidden = async (path: string, hidden: boolean) => {
    setRepos(await window.gt.setRepoHidden(path, hidden))
  }

  if (!loaded || repos.length === 0) return null
  const counts = { active: 0, dormant: 0, dead: 0 }
  for (const r of repos) counts[r.bucket]++
  const hiddenCount = repos.filter((r) => r.hidden).length
  const visible = repos.filter((r) => showHidden || !r.hidden)

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-400">Repos</span>
        <span className="text-[10px] tabular-nums text-zinc-600">
          {counts.active} active · {counts.dormant} dormant · {counts.dead} dead
        </span>
        <div className="flex-1" />
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            {showHidden ? <Eye size={11} /> : <EyeOff size={11} />}
            {showHidden ? 'hide' : `show ${hiddenCount} hidden`}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--gt-border)]">
        {visible.map((r) => (
          <div
            key={r.path}
            className={`flex items-center gap-2 border-b border-[var(--gt-border)]/50 px-3 py-1.5 last:border-b-0 ${
              r.hidden ? 'opacity-40' : ''
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${BUCKET_META[r.bucket].dot}`} />
            <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{r.name}</span>
            {r.hasSchedule && (
              <CalendarClock size={11} className="shrink-0 text-[var(--gt-accent-2)]" />
            )}
            <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
              {r.ageDays < 0 ? 'no commits' : `${r.ageDays}d`}
            </span>
            <button
              onClick={() => toggleHidden(r.path, !r.hidden)}
              title={r.hidden ? 'Unhide' : 'Hide from inventory'}
              className="shrink-0 text-zinc-600 hover:text-zinc-300"
            >
              {r.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { ListChecks, RefreshCw, FolderOpen, X, Search, Play, StopCircle, Trash2 } from 'lucide-react'
import { Badge, ForceChip } from '../../components/ui'
import type { BadgeTone } from '../../components/ui'
import { EngineLogo } from '../../components/EngineLogo'
import { onNavigate } from '../../lib/nav'
import type { Tab, TabContext, UnifiedRun } from '../../lib/types'
import { sanitizeLog as stripAnsi } from '../../lib/sanitizeLog'
import { findRerunTarget, rerunSuccessMessage, type RerunResult } from './rerunState'
import { shouldRefreshRunsFallback } from './runRefresh'
import { useRepoScope } from '../../lib/useRepoScope'

// One global view across every run TerMinal has fired — cron (launchd, via
// bin/terminal-cron) AND in-process (Run button on Agents/Tickets/PRs). The
// per-agent and per-schedule run views in Agents / Schedules stay as scoped
// drill-downs; this tab is the unified picture.

const statusTone = (s: string): BadgeTone =>
  s === 'done' || s === 'pass'
    ? 'green'
    : s === 'failed' || s === 'fail'
      ? 'red'
      : s === 'running'
        ? 'blue'
        : s === 'canceled' || s === 'interrupted'
          ? 'yellow'
          : 'mute'

const sourceTone = (s: 'cron' | 'agent'): BadgeTone => (s === 'cron' ? 'accent' : 'blue')

function fmtWhen(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`
}
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

// Module-scope so its identity is stable across RunsTab re-renders. Defining it
// inside the component body gave it a new identity every render, so the 5s
// cost-refresh remounted the <select> and slammed any open dropdown shut — the
// "filter closes on me randomly / can't pick all repos" bug. It only reads its
// props, so hoisting is a pure move.
function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-[var(--gt-border)] bg-black/30 px-1.5 py-0.5 text-[10.5px] text-zinc-300 outline-none"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function RunsTab({ ctx }: { ctx: TabContext }) {
  const [runs, setRuns] = useState<UnifiedRun[] | null>(null)
  const [source, setSource] = useState<'all' | 'cron' | 'agent'>('all')
  const [status, setStatus] = useState<string>('all')
  // Default to the window's repo; persisted "all repos" opt-out sticks. See useRepoScope.
  const { repo, setRepo, currentRepo } = useRepoScope(ctx.repoRoot, 'runs.repoFilter')
  const [agentFilter, setAgentFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [log, setLog] = useState<{ runId: string; text: string } | null>(null)
  const [logQuery, setLogQuery] = useState('')
  const [rerunBusy, setRerunBusy] = useState(false)
  const [rerunError, setRerunError] = useState<string | null>(null)
  const [rerunNotice, setRerunNotice] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const rerunPollRef = useRef(0)
  const runsRef = useRef<UnifiedRun[] | null>(null)
  const fallbackTickRef = useRef(0)

  const applyRuns = (nextRuns: UnifiedRun[]) => {
    runsRef.current = nextRuns
    setRuns(nextRuns)
    return nextRuns
  }
  const reload = async () => {
    const nextRuns = await window.gt.agents.allRuns()
    return applyRuns(nextRuns)
  }
  // Cost per runId from the AI ledger — joined into each row so the operator
  // sees "this run cost $X" without flipping tabs.
  const [costByRunId, setCostByRunId] = useState<Map<string, number>>(new Map())
  const reloadCosts = async () => {
    try {
      const ai = await window.gt.observability.runs(500)
      const m = new Map<string, number>()
      for (const a of ai) if (a.runId) m.set(a.runId, (m.get(a.runId) || 0) + a.costUsd)
      setCostByRunId(m)
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    let alive = true
    const reloadIfAlive = async () => {
      const nextRuns = await window.gt.agents.allRuns()
      if (alive) applyRuns(nextRuns)
    }
    void reloadIfAlive()
    reloadCosts()
    const offRunsChanged = window.gt.agents.onRunsChanged((nextRuns) => {
      if (!alive) return
      applyRuns(nextRuns)
      reloadCosts()
    })
    // Auto-refresh while at least one run is running. Cheap polling — the
    // list itself is in-memory + tiny files on disk. This remains as a
    // fallback for missed file-watch events or app sleep/wake gaps.
    const t = setInterval(() => {
      fallbackTickRef.current += 1
      if (shouldRefreshRunsFallback(runsRef.current, fallbackTickRef.current, 6)) void reloadIfAlive()
      reloadCosts()
    }, 5000)
    return () => {
      alive = false
      offRunsChanged()
      clearInterval(t)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const fmtUsd = (n: number) => {
    if (n >= 10) return `$${n.toFixed(2)}`
    if (n >= 0.01) return `$${n.toFixed(3).replace(/0$/, '')}`
    if (n > 0) return `$${n.toFixed(4)}`
    return '—'
  }

  // Cross-tab nav: when another tab calls navigateTo('runs', { runId }) we
  // pre-select that run + scroll the list to it.
  useEffect(
    () =>
      onNavigate((ev) => {
        if (ev.tabId !== 'runs') return
        const runId = (ev.payload?.runId as string) || ''
        if (runId) setSel(runId)
      }),
    [],
  )

  // Filter chip options derived from loaded data.
  // Always include the current repo so the default filter is a real option even
  // before any of its runs have loaded (otherwise the <select> shows a value
  // with no matching <option> and silently displays the placeholder instead).
  const repoOptions = useMemo(() => {
    const labels = (runs || []).map((r) => r.repoLabel)
    return [...new Set([...labels, currentRepo].filter(Boolean))].sort()
  }, [runs, currentRepo])
  const agentOptions = useMemo(() => {
    if (!runs) return []
    return [...new Set(runs.map((r) => r.agentId))].sort()
  }, [runs])
  const statusOptions = useMemo(() => {
    if (!runs) return []
    return [...new Set(runs.map((r) => r.status))].sort()
  }, [runs])

  const filtered = useMemo(() => {
    if (!runs) return null
    const q = search.trim().toLowerCase()
    return runs.filter((r) => {
      if (source !== 'all' && r.source !== source) return false
      if (status !== 'all' && r.status !== status) return false
      if (repo && r.repoLabel !== repo) return false
      if (agentFilter && r.agentId !== agentFilter) return false
      if (!q) return true
      return (
        r.agentTitle.toLowerCase().includes(q) ||
        r.agentId.toLowerCase().includes(q) ||
        r.branch.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      )
    })
  }, [runs, source, status, repo, agentFilter, search])

  const selectedRun = (runs || []).find((r) => r.id === sel) || null

  // Lazy-load + live-tail the log when a run is selected. Polls every 1.5s
  // while the underlying run is still running so the operator sees streaming
  // claude/codex output without manual reloads.
  useEffect(() => {
    if (!selectedRun) {
      setLog(null)
      return
    }
    let alive = true
    const fetch = async () => {
      const text = await window.gt.agents.runLog(selectedRun.source, selectedRun.id)
      if (alive) setLog({ runId: selectedRun.id, text })
    }
    fetch()
    if (selectedRun.status !== 'running') return () => {
      alive = false
    }
    const t = setInterval(fetch, 1500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [selectedRun?.id, selectedRun?.status])

  // Re-run dispatch lives behind runs:rerun so main can route against the run's
  // own repo. When launchd starts a schedule asynchronously, poll briefly for
  // the new cron-run record so the detail pane visibly moves to it.
  const handleRerun = async (run: UnifiedRun) => {
    const requestedAt = Date.now()
    const pollId = ++rerunPollRef.current
    setRerunBusy(true)
    setRerunError(null)
    setRerunNotice(null)
    try {
      const res = await window.gt.agents.rerun(run)
      if ('error' in res) {
        setRerunError(res.error)
        return
      }
      setRerunNotice(rerunSuccessMessage(res))
      const nextRuns = await reload()
      const target = findRerunTarget(run, res, nextRuns, requestedAt)
      if (target) {
        setSel(target)
        return
      }
      if (!res.runId) void pollForDetachedRerun(run, res, requestedAt, pollId)
    } catch (err) {
      setRerunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRerunBusy(false)
    }
  }

  const pollForDetachedRerun = async (
    run: UnifiedRun,
    res: RerunResult,
    requestedAt: number,
    pollId: number,
  ) => {
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (rerunPollRef.current !== pollId) return
      const nextRuns = await reload()
      const target = findRerunTarget(run, res, nextRuns, requestedAt)
      if (target) {
        setSel(target)
        return
      }
    }
  }

  // Log search — filter the log to lines matching the query, with neighbour
  // lines for context. Cheap to do client-side; logs are kilobytes.
  const visibleLog = useMemo(() => {
    const raw = stripAnsi(log?.text || '')
    if (!raw) return ''
    const q = logQuery.trim().toLowerCase()
    if (!q) return raw
    const lines = raw.split('\n')
    const keep = new Set<number>()
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(q)) {
        keep.add(i)
        if (i > 0) keep.add(i - 1)
        if (i + 1 < lines.length) keep.add(i + 1)
      }
    })
    const indices = [...keep].sort((a, b) => a - b)
    const out: string[] = []
    let prev = -2
    for (const i of indices) {
      if (i > prev + 1) out.push('…')
      out.push(lines[i])
      prev = i
    }
    return out.join('\n') || `(no lines match "${logQuery}")`
  }, [log?.text, logQuery])

  const counts = useMemo(() => {
    if (!runs) return { running: 0, done: 0, failed: 0 }
    return {
      running: runs.filter((r) => r.status === 'running').length,
      done: runs.filter((r) => r.status === 'done').length,
      failed: runs.filter((r) => r.status === 'failed').length,
    }
  }, [runs])

  return (
    <div className="flex h-full min-h-0 bg-[var(--gt-bg)]">
      {/* List */}
      <div className="flex w-[58%] min-w-[420px] shrink-0 flex-col border-r border-[var(--gt-border)]">
        {/* Header */}
        <div className="shrink-0 space-y-1.5 border-b border-[var(--gt-border)] bg-[var(--gt-panel)]/40 p-2.5">
          <div className="flex items-center gap-2">
            <ListChecks size={14} strokeWidth={2} className="text-[var(--gt-accent-light)]" />
            <span className="text-[12px] font-semibold text-zinc-200">All runs</span>
            <span className="text-[10.5px] text-zinc-600">
              {filtered ? `${filtered.length} / ${runs?.length || 0}` : '…'}
            </span>
            <span className="ml-2 inline-flex items-center gap-1.5 text-[10.5px]">
              {counts.running > 0 && (
                <Badge tone="blue">
                  <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current gt-pulse" />
                  {counts.running} running
                </Badge>
              )}
              <Badge tone="green">{counts.done} done</Badge>
              {counts.failed > 0 && <Badge tone="red">{counts.failed} failed</Badge>}
            </span>
            <div className="flex-1" />
            <button
              onClick={reload}
              title="Reload runs"
              className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            >
              <RefreshCw size={11} strokeWidth={2} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agent / branch / id…"
              className="min-w-[140px] flex-1 rounded-md border border-[var(--gt-border)] bg-black/30 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-[var(--gt-accent)]/60 focus:outline-none"
            />
            <div className="flex items-center gap-0.5 rounded-md border border-[var(--gt-border)] p-0.5">
              {(['all', 'cron', 'agent'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  className={`rounded-sm px-1.5 py-0.5 text-[10px] capitalize ${
                    source === s ? 'bg-[var(--gt-accent)]/20 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <FilterSelect value={status} onChange={(v) => setStatus(v || 'all')} options={statusOptions} placeholder="all status" />
            <FilterSelect value={repo} onChange={setRepo} options={repoOptions} placeholder="all repos" />
            <FilterSelect value={agentFilter} onChange={setAgentFilter} options={agentOptions} placeholder="all agents" />
          </div>
        </div>

        {/* Rows */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs === null ? (
            <div className="p-4 text-[12px] text-zinc-600">Loading runs…</div>
          ) : filtered && filtered.length === 0 ? (
            <div className="p-4 text-[12px] text-zinc-600">No runs match these filters.</div>
          ) : (
            (filtered || []).map((r) => {
              const dur = r.endedAt
                ? fmtDuration(r.endedAt - r.startedAt)
                : r.status === 'running'
                  ? 'running…'
                  : '—'
              const selectedHere = sel === r.id
              return (
                <button
                  key={r.id}
                  onClick={() => setSel(r.id)}
                  className={`flex w-full items-center gap-2 border-b border-[var(--gt-border)]/40 px-3 py-2 text-left ${
                    selectedHere ? 'bg-[var(--gt-accent)]/15' : 'hover:bg-white/5'
                  }`}
                >
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  <Badge tone={sourceTone(r.source)}>{r.source}</Badge>
                  {r.force && <ForceChip />}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{r.agentTitle}</span>
                  <span className="shrink-0 font-mono text-[9.5px] text-zinc-600">{r.repoLabel}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] uppercase text-zinc-600">
                    <EngineLogo engine={r.engine} size={10} />
                    {r.engine}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-[10px] text-zinc-500">{dur}</span>
                  <span
                    className="w-14 shrink-0 text-right font-mono tabular-nums text-[10px] text-[var(--gt-accent-light)]"
                    title="Cost from the AI fleet ledger (joined by runId)"
                  >
                    {fmtUsd(costByRunId.get(r.id) || 0)}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">{fmtWhen(r.startedAt)}</span>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* Detail */}
      <section className="flex min-w-0 flex-1 flex-col">
        {!selectedRun ? (
          <div className="flex h-full items-center justify-center text-[12px] text-zinc-600">
            Pick a run on the left.
          </div>
        ) : (
          <>
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gt-border)] px-5 py-2.5">
              <Badge tone={statusTone(selectedRun.status)}>{selectedRun.status}</Badge>
              <Badge tone={sourceTone(selectedRun.source)}>{selectedRun.source}</Badge>
              {selectedRun.force && <ForceChip size="md" />}
              <span className="text-[13px] font-semibold text-zinc-100">{selectedRun.agentTitle}</span>
              <span className="inline-flex items-center gap-1 text-[10px] uppercase text-zinc-600">
                <EngineLogo engine={selectedRun.engine} size={11} />
                {selectedRun.engine}
              </span>
              <span className="font-mono text-[10.5px] text-zinc-600">{selectedRun.branch}</span>
              <div className="flex-1" />
              <span className="text-[10.5px] text-zinc-500">
                started {fmtWhen(selectedRun.startedAt)}
                {selectedRun.endedAt && (
                  <> · {fmtDuration(selectedRun.endedAt - selectedRun.startedAt)}</>
                )}
              </span>
              {selectedRun.worktree && (
                <button
                  onClick={() => window.gt.openExternal(`file://${selectedRun.worktree}`)}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10.5px] text-zinc-300 hover:border-[var(--gt-accent)]/60"
                >
                  <FolderOpen size={10} strokeWidth={2} />
                  Worktree
                </button>
              )}
              {/* Cancel: only works for in-process runs (cron runs spawn from
                  launchd in a different process tree; agents.cancel can't
                  reach them). Showing the button conditionally avoids the
                  "why does this do nothing" UX trap. */}
              {selectedRun.status === 'running' && selectedRun.source === 'agent' && (
                <button
                  onClick={async () => {
                    if (!confirm('Cancel this run? The agent will be SIGTERM-ed.')) return
                    await window.gt.agents.cancel(selectedRun.id)
                    await reload()
                  }}
                  title="SIGTERM this in-process run"
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-red)]/40 bg-[var(--gt-red)]/10 px-1.5 py-0.5 text-[10.5px] text-[var(--gt-red)] hover:border-[var(--gt-red)]/60"
                >
                  <StopCircle size={10} strokeWidth={2} />
                  Cancel
                </button>
              )}
              {/* Remove worktree: post-run cleanup for in-process runs. Cron
                  worktrees live in ~/.config/TerMinal/cron-worktrees/ and are
                  managed by the runner. */}
              {selectedRun.source === 'agent' &&
                selectedRun.status !== 'running' &&
                selectedRun.worktree && (
                  <button
                    onClick={async () => {
                      if (!confirm('Remove this run\'s worktree? Uncommitted changes will be lost.')) return
                      await window.gt.agents.removeWorktree(selectedRun.id)
                      await reload()
                    }}
                    title="git worktree remove (and rm -rf the directory)"
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10.5px] text-zinc-400 hover:border-[var(--gt-red)]/60 hover:text-[var(--gt-red)]"
                  >
                    <Trash2 size={10} strokeWidth={2} />
                    Remove worktree
                  </button>
                )}
              <button
                onClick={() => handleRerun(selectedRun)}
                disabled={rerunBusy || selectedRun.status === 'running'}
                title={
                  selectedRun.status === 'running'
                    ? 'Already running'
                    : selectedRun.source === 'cron' && selectedRun.scheduleId
                      ? 'Re-run this schedule'
                      : 'Re-run this agent'
                }
                className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-accent)]/40 bg-[var(--gt-accent)]/15 px-1.5 py-0.5 text-[10.5px] text-zinc-100 hover:border-[var(--gt-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play size={10} strokeWidth={2} />
                {rerunBusy ? 'starting…' : 'Re-run'}
              </button>
              {rerunError && (
                <span className="text-[10.5px] text-[var(--gt-red)]" title={rerunError}>
                  {rerunError}
                </span>
              )}
              {!rerunError && rerunNotice && (
                <span className="text-[10.5px] text-[var(--gt-accent-light)]" title={rerunNotice}>
                  {rerunNotice}
                </span>
              )}
              <button
                onClick={() => setSel(null)}
                title="Close detail"
                className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
              >
                <X size={11} strokeWidth={2} />
              </button>
            </header>
            {selectedRun.error && (
              <div className="shrink-0 border-b border-[var(--gt-border)]/60 bg-[var(--gt-red)]/10 px-5 py-2 text-[11.5px] text-[var(--gt-red)]">
                {selectedRun.error}
              </div>
            )}
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gt-border)]/40 bg-[var(--gt-panel)]/30 px-3 py-1.5">
              <Search size={11} strokeWidth={2} className="text-zinc-500" />
              <input
                value={logQuery}
                onChange={(e) => setLogQuery(e.target.value)}
                placeholder="Filter log lines (case-insensitive)…"
                className="flex-1 rounded-md bg-transparent px-1 py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
              />
              {logQuery && (
                <button
                  onClick={() => setLogQuery('')}
                  className="rounded-md p-0.5 text-zinc-500 hover:text-zinc-200"
                  title="Clear filter"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              )}
            </div>
            <pre
              ref={logRef}
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[#0c0c11] p-4 font-mono text-[11px] leading-relaxed text-zinc-300"
            >
              {visibleLog || '…'}
            </pre>
          </>
        )}
      </section>
    </div>
  )
}

const tab: Tab = {
  id: 'runs',
  title: 'Runs',
  icon: ListChecks,
  order: 3.45, // between Agents (3) and Schedules (3.5)
  appliesTo: () => true,
  badge: async (gt) => {
    try {
      const rs = await gt.agents.allRuns()
      return rs.filter((r) => r.status === 'running').length
    } catch {
      return 0
    }
  },
  Component: RunsTab,
}
export default tab

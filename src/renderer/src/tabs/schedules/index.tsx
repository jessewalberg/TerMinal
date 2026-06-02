import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  Plus,
  Play,
  Pause,
  Trash2,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  FileText,
  X,
  ListChecks,
} from 'lucide-react'
import { Badge } from '../../components/ui'
import { EngineLogo } from '../../components/EngineLogo'
import { EngineModelPicker } from '../../components/EngineModelPicker'
import { navigateTo } from '../../lib/nav'
import { BashHighlight } from '../../components/BashHighlight'
import { SkillHint } from '../../components/SkillHint'
import { useRepoScope } from '../../lib/useRepoScope'
import type { BadgeTone } from '../../components/ui'
import type { Tab, TabContext, Agent, Schedule, ScheduleSpec, CronRun, Engine } from '../../lib/types'

const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const FIELD =
  'rounded-lg border border-[var(--gt-border)] bg-black/30 px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-[var(--gt-accent)]/60'

function fmtWhen(ts?: number | null): string {
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
function reltime(ts?: number): string {
  if (!ts) return ''
  const s = (Date.now() - ts) / 1000
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function untilFire(ts?: number | null): string {
  if (!ts) return ''
  const s = (ts - Date.now()) / 1000
  if (s <= 0) return 'now'
  if (s < 60) return `in ${Math.floor(s)}s`
  if (s < 3600) return `in ${Math.floor(s / 60)}m`
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `in ${Math.floor(s / 86400)}d`
}
const statusTone = (s?: string): BadgeTone =>
  s === 'done' ? 'green' : s === 'failed' ? 'red' : s === 'running' ? 'blue' : 'mute'

// The structured + advanced-cron builder. Produces a ScheduleSpec.
function ScheduleForm({
  agents,
  onCancel,
  onSave,
  onCustomSpawned,
}: {
  agents: Agent[]
  onCancel: () => void
  onSave: (
    agentId: string,
    engine: Engine,
    spec: ScheduleSpec,
    model?: string,
    env?: Record<string, string>,
  ) => Promise<void>
  onCustomSpawned: () => void
}) {
  // Plaintext describe-it-in-words is the primary path; the deterministic
  // Form remains available behind the toggle for power users.
  const [mode, setMode] = useState<'form' | 'custom'>('custom')
  const [customText, setCustomText] = useState('')
  const [customBusy, setCustomBusy] = useState(false)
  const [customErr, setCustomErr] = useState('')
  const [agentId, setAgentId] = useState(agents[0]?.id || '')
  const [engine, setEngine] = useState<Engine>('claude')
  const [model, setModel] = useState('')
  useEffect(() => {
    window.gt.settings.get().then((s) => setEngine(s.defaultEngine))
  }, [])
  // Pre-fill model from the selected agent's default whenever the agent changes.
  useEffect(() => {
    const a = agents.find((x) => x.id === agentId)
    setModel(a?.model || '')
  }, [agentId, agents])
  const [kind, setKind] = useState<'interval' | 'calendar' | 'cron'>('calendar')
  const [everyN, setEveryN] = useState(1)
  const [unit, setUnit] = useState<'minutes' | 'hours'>('hours')
  const [time, setTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [cron, setCron] = useState('30 9 * * 1-5')
  // Per-schedule env vars — one KEY=value per line. Sanitized + uppercased by
  // the main-side IPC; only POSIX-shaped names survive (`[A-Z_][A-Z0-9_]*`).
  // Optional; the common case is empty.
  const [envText, setEnvText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const toggleWd = (d: number) =>
    setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort((a, b) => a - b)))

  const buildSpec = (): ScheduleSpec => {
    if (kind === 'interval') return { kind: 'interval', everyMinutes: Math.max(1, unit === 'hours' ? everyN * 60 : everyN) }
    if (kind === 'cron') return { kind: 'cron', expr: cron.trim() }
    const [h, m] = time.split(':').map(Number)
    return { kind: 'calendar', minute: m || 0, hour: h || 0, weekdays: weekdays.length ? weekdays : undefined }
  }

  // Parse the env textarea into a Record. Lines starting with `#` are comments;
  // blank lines are ignored; everything else is split on the FIRST `=` so values
  // can contain `=` themselves. Malformed lines are dropped silently — the
  // main-side IPC re-sanitizes before persisting, so this is just for the
  // common case.
  const parseEnv = (raw: string): Record<string, string> | undefined => {
    const out: Record<string, string> = {}
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (!key) continue
      out[key] = value
    }
    return Object.keys(out).length ? out : undefined
  }

  const submit = async () => {
    if (!agentId) return
    setBusy(true)
    setErr('')
    try {
      await onSave(agentId, engine, buildSpec(), model.trim() || undefined, parseEnv(envText))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitCustom = async () => {
    const t = customText.trim()
    if (!t) return
    setCustomBusy(true)
    setCustomErr('')
    const r = await window.gt.schedules.design(t, engine)
    setCustomBusy(false)
    if (r && 'error' in r) {
      setCustomErr(r.error)
      return
    }
    onCustomSpawned()
  }

  return (
    <div className="space-y-3">
      <SkillHint>
        You can also schedule from the terminal with{' '}
        <code className="font-mono text-zinc-300">/new-schedule "Run docs every Monday at 9am"</code> in Claude
        or <code className="font-mono text-zinc-300">$new-schedule "Run docs every Monday at 9am"</code> in
        Codex.
      </SkillHint>
      {/* Form / Custom toggle — same UX as the agents tab's new-agent flow. */}
      <div className="flex items-center gap-0.5 rounded-md border border-[var(--gt-border)] p-0.5">
        {(['form', 'custom'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-sm px-2 py-0.5 text-[11px] capitalize ${
              mode === m ? 'bg-[var(--gt-accent)]/20 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {m === 'form' ? 'Form' : 'Describe in plain text'}
          </button>
        ))}
      </div>

      {mode === 'custom' && (
        <div className="space-y-2">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitCustom()
            }}
            rows={3}
            autoFocus
            placeholder='e.g. "Run the docs agent every Monday at 9am" — reference any existing agent by name.'
            className={`${FIELD} resize-y w-full`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              engine + model
              <EngineModelPicker
                engine={engine}
                model={model || undefined}
                onChange={(e, m) => {
                  setEngine(e)
                  setModel(m || '')
                }}
                size="sm"
              />
            </label>
            {customErr && <span className="text-[11px] text-[var(--gt-red)]">{customErr}</span>}
            <div className="ml-auto flex items-center gap-2">
              <button onClick={onCancel} className="rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5">
                cancel
              </button>
              <button
                onClick={submitCustom}
                disabled={!customText.trim() || customBusy}
                className="rounded-md bg-[var(--gt-accent)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
              >
                {customBusy ? 'Spawning…' : `Design with ${engine}`}
              </button>
            </div>
          </div>
          <div className="text-[10.5px] text-zinc-600">
            ⌘↵ to submit · the designer reads your agent list + existing schedules, parses the cadence, and writes the new entry directly. After it finishes the app reconciles launchd so the schedule becomes real.
          </div>
        </div>
      )}

      {mode === 'form' && (
      <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-zinc-500">Run</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={FIELD}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-zinc-500">via</span>
        <EngineModelPicker
          engine={engine}
          model={model || undefined}
          onChange={(e, m) => {
            setEngine(e)
            setModel(m || '')
          }}
          size="sm"
        />
      </div>

      <div className="flex items-center gap-1">
        {(['calendar', 'interval', 'cron'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] capitalize ${
              kind === k
                ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
                : 'border-[var(--gt-border)] text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {k === 'calendar' ? 'at a time' : k === 'interval' ? 'every N' : 'cron'}
          </button>
        ))}
      </div>

      {kind === 'interval' && (
        <div className="flex items-center gap-2 text-[12px] text-zinc-400">
          every
          <input
            type="number"
            min={1}
            value={everyN}
            onChange={(e) => setEveryN(Math.max(1, Number(e.target.value)))}
            className={`${FIELD} w-16`}
          />
          <select value={unit} onChange={(e) => setUnit(e.target.value as 'minutes' | 'hours')} className={FIELD}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </div>
      )}
      {kind === 'calendar' && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-zinc-400">
          at
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={FIELD} />
          <span className="text-zinc-600">on</span>
          {WD.map((w, i) => (
            <button
              key={w}
              onClick={() => toggleWd(i)}
              className={`h-6 w-7 rounded text-[10px] ${
                weekdays.includes(i)
                  ? 'bg-[var(--gt-accent)]/25 text-zinc-100'
                  : 'border border-[var(--gt-border)] text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {w}
            </button>
          ))}
          <span className="text-[10px] text-zinc-600">{weekdays.length ? '' : '(every day)'}</span>
        </div>
      )}
      {kind === 'cron' && (
        <div className="space-y-1">
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="min hour dom month dow  (e.g. 30 9 * * 1-5)"
            className={`${FIELD} w-full font-mono`}
          />
          <div className="text-[10px] text-zinc-600">5-field cron — ranges/lists/steps ok (e.g. */15, 1-5, 9,17).</div>
        </div>
      )}

      {/* Optional per-schedule env vars. Power-user surface: most schedules
          have zero. The cron runner spreads these into the spawned agent's
          env after the standard TERMINAL_* keys, so e.g. a "(bolt)" Beacon
          schedule can pin BEACON_PROJECT=bolt and the agent prompt's
          `$BEACON_PROJECT` substitution resolves to bolt instead of the
          global config default. */}
      <details className="rounded-md border border-[var(--gt-border)] bg-black/20 px-2 py-1">
        <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">
          Env vars <span className="text-zinc-700">(optional · KEY=value, one per line)</span>
        </summary>
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          rows={3}
          placeholder={`BEACON_PROJECT=bolt\nBEACON_SECRET=sec_…`}
          className={`${FIELD} mt-1.5 resize-y w-full font-mono text-[11px]`}
        />
        <div className="mt-1 text-[10px] text-zinc-600">
          Keys must match <span className="font-mono">[A-Z_][A-Z0-9_]*</span>. Comments (<span className="font-mono">#…</span>) and blank lines ignored.
        </div>
      </details>

      {err && <div className="text-[11px] text-[var(--gt-red)]">{err}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || !agentId}
          className="rounded-lg bg-[var(--gt-accent)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Schedule it'}
        </button>
        <button onClick={onCancel} className="rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5">
          cancel
        </button>
      </div>
      </div>
      )}
    </div>
  )
}

function SchedulesTab({ ctx }: { ctx: TabContext }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [runs, setRuns] = useState<CronRun[]>([])
  const [log, setLog] = useState<{ runId: string; text: string } | null>(null)
  const [msg, setMsg] = useState('')
  // Default to the window's repo; "All repos" opt-out persists. See useRepoScope.
  const { repo, setRepo, currentRepo } = useRepoScope(ctx.repoRoot, 'schedules.repoFilter')
  // Tick the relative "fires in 12m" labels every minute. The Schedule.nextRun
  // value is already on each record (computed by readSchedules); this just
  // forces the count-down strings to refresh in place.
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setClockTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  const [disabled, setDisabledIds] = useState<Set<string>>(new Set())
  // Lazy-loaded bash bodies, keyed by agentId. Same cache pattern as the Agents tab.
  const [scriptByAgent, setScriptByAgent] = useState<Record<string, { path: string; body: string } | null>>({})

  const reload = () => window.gt.schedules.list().then(setSchedules)
  const reloadDisabled = () => window.gt.schedules.disabledList().then((ids) => setDisabledIds(new Set(ids)))
  useEffect(() => {
    reload()
    reloadDisabled()
    window.gt.agents.list().then(setAgents)
  }, [ctx.sessionId])

  // Listen for the design-schedule run completing — when the spawn finishes
  // writing to schedules.json, reconcile launchd so the new entry becomes a
  // real LaunchAgent without the user having to click Reconcile.
  useEffect(() => {
    const off = window.gt.agents.onStatus(async (run) => {
      if (run.agentId !== 'design-schedule' || run.status !== 'done') return
      await window.gt.schedules.reconcile()
      reload()
      flash('schedule designed · launchd reconciled')
    })
    return () => off()
  }, [])

  // Live log tail while a running cron job's log is open. Polls every 1.5s and
  // updates the inline log pane so the operator sees output as `script -q`
  // streams claude/codex stdout, instead of having to re-click "log".
  useEffect(() => {
    if (!log) return
    const targetRun = runs.find((r) => r.id === log.runId)
    if (!targetRun || targetRun.status !== 'running') return
    let alive = true
    const tick = async () => {
      const text = await window.gt.schedules.runLog(log.runId)
      if (alive && text !== log.text) setLog({ runId: log.runId, text })
    }
    const id = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [log?.runId, log?.text, runs])

  // Options span every repo that has a schedule, plus the current repo so the
  // default filter is always selectable. (Run-only repos appear in the Runs tab.)
  const repoOptions = useMemo(() => {
    const set = new Set<string>()
    for (const s of schedules || []) if (s.repoLabel) set.add(s.repoLabel)
    if (currentRepo) set.add(currentRepo)
    return [...set].sort()
  }, [schedules, currentRepo])
  const shownSchedules = (schedules || []).filter((s) => !repo || s.repoLabel === repo)

  const openRuns = async (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      return
    }
    setExpanded(id)
    setLog(null)
    setRuns(await window.gt.schedules.runs(id))
    // Lazy-fetch the script body for the schedule's agent so it renders above
    // the run history. Cache including null so we don't re-hit IPC.
    const sched = (schedules || []).find((s) => s.id === id)
    if (sched && !(sched.agentId in scriptByAgent)) {
      window.gt.agents
        .script(sched.agentId)
        .then((r) => setScriptByAgent((m) => ({ ...m, [sched.agentId]: r })))
    }
  }

  const save = async (
    agentId: string,
    engine: Engine,
    spec: ScheduleSpec,
    model?: string,
    env?: Record<string, string>,
  ) => {
    const r = await window.gt.schedules.save({ agentId, engine, spec, model, env })
    if (r && 'error' in r) throw new Error(r.error)
    setCreating(false)
    reload()
  }
  const flash = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(''), 5000)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gt-bg)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gt-border)] px-4 py-2">
        <CalendarClock size={14} strokeWidth={2} className="text-[var(--gt-accent-2)]" />
        <span className="text-[12px] font-semibold text-zinc-200">Schedules</span>
        <button
          onClick={() => navigateTo('runs')}
          title="See every run (cron + in-process) in the Runs tab"
          className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10.5px] text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-200"
        >
          <ListChecks size={10} strokeWidth={2} />
          All runs → Runs tab
        </button>
        <select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          title="Filter by repo"
          className="rounded-md border border-[var(--gt-border)] bg-black/30 px-1.5 py-1 text-[11px] text-zinc-300 outline-none"
        >
          <option value="">All repos</option>
          {repoOptions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        {/* Pause-all / Resume-all. The runner re-reads the disabled list on
            every fire, so the kill-switch takes effect on the next launchd
            tick — no reconcile/restart needed. Useful for travel, slow
            networks, or debugging without un-scheduling everything. */}
        {(() => {
          const total = (schedules || []).length
          const pausedCount = (schedules || []).filter((s) => disabled.has(s.id)).length
          const allPaused = total > 0 && pausedCount === total
          return (
            total > 0 && (
              <button
                onClick={async () => {
                  await window.gt.schedules.disabledAll(!allPaused)
                  reloadDisabled()
                  flash(allPaused ? `resumed ${total} schedules` : `paused ${total} schedules`)
                }}
                title={
                  allPaused
                    ? 'Resume every schedule (re-enable launchd firing)'
                    : 'Pause every schedule (no fires until you resume)'
                }
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                  allPaused
                    ? 'border-[var(--gt-green)]/40 bg-[var(--gt-green)]/10 text-[var(--gt-green)]'
                    : pausedCount > 0
                      ? 'border-[var(--gt-yellow)]/40 bg-[var(--gt-yellow)]/10 text-[var(--gt-yellow)]'
                      : 'border-[var(--gt-border)] text-zinc-400 hover:border-[var(--gt-accent)]/60'
                }`}
              >
                {allPaused ? <Play size={11} strokeWidth={2.5} /> : <Pause size={11} strokeWidth={2.5} />}
                {allPaused
                  ? `Resume all (${total})`
                  : pausedCount > 0
                    ? `Pause all (${pausedCount}/${total} paused)`
                    : `Pause all (${total})`}
              </button>
            )
          )
        })()}
        <button
          onClick={async () => {
            const r = await window.gt.schedules.reconcile()
            flash(`reconciled · ${r.loaded} loaded, ${r.removed} orphans removed`)
            reload()
          }}
          title="Re-sync launchd with the schedule list (removes orphans)"
          className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-400 hover:border-[var(--gt-accent)]/60"
        >
          <RefreshCw size={11} strokeWidth={2} />
          Reconcile
        </button>
        <button
          onClick={() => {
            setCreating(true)
            setExpanded(null)
          }}
          className="inline-flex items-center gap-1 rounded-lg bg-[var(--gt-accent)] px-3 py-1 text-[12px] font-semibold text-white"
        >
          <Plus size={13} strokeWidth={2.5} />
          New schedule
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {msg && <div className="px-1 text-[11px] text-[var(--gt-green)]">{msg}</div>}
        {schedules === null ? (
          <div className="p-3 text-[12px] text-zinc-600">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="p-3 text-[12px] text-zinc-600">
            No schedules yet. “New schedule” registers a real macOS launchd job that runs an agent on your
            cadence — even when TerMinal is closed.
          </div>
        ) : shownSchedules.length === 0 ? (
          <div className="p-3 text-[12px] text-zinc-600">No schedules for {repo}.</div>
        ) : (
          shownSchedules.map((s) => (
            <div key={s.id} className="rounded-xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-3">
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-zinc-100">{s.agentTitle}</span>
                    <Badge tone="blue">{s.describe || ''}</Badge>
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase text-zinc-600">
                      <EngineLogo engine={s.engine} size={10} />
                      {s.engine}
                    </span>
                    {s.lastStatus && s.lastStatus !== 'never' && (
                      <Badge tone={statusTone(s.lastStatus)}>{s.lastStatus}</Badge>
                    )}
                    {disabled.has(s.id) && (
                      <button
                        onClick={async () => {
                          await window.gt.schedules.disabledToggle(s.id, false)
                          reloadDisabled()
                          flash(`${s.agentTitle} · re-enabled`)
                        }}
                        title="Auto-disabled by the circuit-breaker after consecutive failures. Click to re-enable."
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--gt-red)]/60 bg-[var(--gt-red)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--gt-red)] hover:bg-[var(--gt-red)]/20"
                      >
                        kill-switch · re-enable
                      </button>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {s.repoLabel} · next {fmtWhen(s.nextRun)}
                    {s.nextRun && !disabled.has(s.id) && (
                      <span className="ml-1 text-zinc-400">({untilFire(s.nextRun)})</span>
                    )}
                    {s.lastRun ? ` · last ${reltime(s.lastRun)}` : ''}
                  </div>
                </div>
                {/* iOS-style pill switch — clearer at a glance than a checkbox */}
                <button
                  onClick={async () => {
                    await window.gt.schedules.toggle(s.id, !s.enabled)
                    reload()
                  }}
                  title={s.enabled ? 'enabled — click to pause' : 'paused — click to enable'}
                  className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                    s.enabled ? 'bg-[var(--gt-green)]/70' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
                      s.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              {/* Actions strip — icon buttons with consistent hover affordance. */}
              <div className="mt-2 flex items-center gap-1 text-[11px]">
                <button
                  onClick={() => openRuns(s.id)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                >
                  {expanded === s.id ? (
                    <ChevronDown size={12} strokeWidth={2} />
                  ) : (
                    <ChevronRight size={12} strokeWidth={2} />
                  )}
                  runs
                </button>
                <button
                  onClick={async () => {
                    await window.gt.schedules.runNow(s.id)
                    flash(`${s.agentTitle} started — see runs / Activity`)
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-zinc-500 hover:bg-white/5 hover:text-[var(--gt-accent-light)]"
                >
                  <Play size={11} strokeWidth={2.5} />
                  run now
                </button>
                <div className="flex-1" />
                <button
                  onClick={async () => {
                    await window.gt.schedules.remove(s.id)
                    reload()
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-zinc-600 hover:bg-white/5 hover:text-[var(--gt-red)]"
                  title="Remove this schedule"
                >
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </div>

              {expanded === s.id && (
                <div className="mt-2 space-y-1 border-t border-[var(--gt-border)]/50 pt-2">
                  {/* Script preview — show the bash body the runner will exec, or the
                      legacy prompt fallback if no .agents/<id>.sh exists yet. Helps
                      the operator confirm what's about to fire before opening logs. */}
                  {scriptByAgent[s.agentId] !== undefined && (
                    <div className="mb-2 space-y-1">
                      <div className="flex items-center gap-1.5 px-1 text-[10px]">
                        {scriptByAgent[s.agentId] ? (
                          <>
                            <Badge tone="blue">bash script</Badge>
                            <span className="min-w-0 flex-1 truncate font-mono text-zinc-600">
                              {scriptByAgent[s.agentId]!.path}
                            </span>
                            <button
                              onClick={() => window.gt.openInEditor(scriptByAgent[s.agentId]!.path)}
                              className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-200"
                              title="Open in your configured editor"
                            >
                              edit
                            </button>
                          </>
                        ) : (
                          <>
                            <Badge tone="mute">prompt</Badge>
                            <span className="text-zinc-700">
                              legacy prompt — runs as a single claude/codex call
                            </span>
                          </>
                        )}
                      </div>
                      {scriptByAgent[s.agentId] && (
                        <BashHighlight code={scriptByAgent[s.agentId]!.body} className="max-h-56" />
                      )}
                    </div>
                  )}
                  {runs.length === 0 ? (
                    <div className="py-2 text-center text-[11px] text-zinc-600">
                      No runs yet. Try “run now” above to fire one.
                    </div>
                  ) : (
                    runs.map((r) => {
                      const open = log?.runId === r.id
                      const dur =
                        r.endedAt && r.startedAt
                          ? fmtDuration(r.endedAt - r.startedAt)
                          : r.status === 'running'
                            ? 'running…'
                            : '—'
                      return (
                        <div key={r.id}>
                          <button
                            onClick={async () =>
                              setLog(
                                open
                                  ? null
                                  : { runId: r.id, text: await window.gt.schedules.runLog(r.id) },
                              )
                            }
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-[11px] text-left ${
                              open ? 'bg-white/5' : 'hover:bg-white/5'
                            }`}
                          >
                            <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                            <span className="text-zinc-500">{fmtWhen(r.startedAt)}</span>
                            <span className="text-zinc-700">·</span>
                            <span className="font-mono tabular-nums text-zinc-500">{dur}</span>
                            <span className="text-zinc-700">·</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600">
                              {r.branch}
                            </span>
                            <FileText
                              size={11}
                              strokeWidth={2}
                              className={open ? 'text-[var(--gt-accent-light)]' : 'text-zinc-600'}
                            />
                          </button>
                          {open && log && (
                            <div className="mt-1 rounded-lg border border-[var(--gt-border)] bg-[#0c0c11]">
                              <div className="flex items-center justify-between border-b border-[var(--gt-border)]/60 px-2 py-1">
                                <span className="text-[10px] uppercase tracking-wider text-zinc-600">log</span>
                                <button
                                  onClick={() => setLog(null)}
                                  className="rounded text-zinc-600 hover:bg-white/5 hover:text-zinc-300"
                                  title="Close log"
                                >
                                  <X size={11} strokeWidth={2} />
                                </button>
                              </div>
                              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[10.5px] leading-relaxed text-zinc-300">
                                {log.text || '… (no output yet)'}
                              </pre>
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setCreating(false)}
        >
          <div
            className="max-h-[86vh] w-[720px] overflow-y-auto rounded-2xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-zinc-100">New schedule</h2>
              <button
                onClick={() => setCreating(false)}
                className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/5"
              >
                cancel
              </button>
            </div>
            {agents.length ? (
              <ScheduleForm
                agents={agents}
                onCancel={() => setCreating(false)}
                onSave={save}
                onCustomSpawned={() => {
                  setCreating(false)
                  flash('designer spawned · schedule will appear when the run completes')
                }}
              />
            ) : (
              <div className="rounded-lg border border-[var(--gt-border)] p-3 text-[12px] text-zinc-600">
                No agents in this repo to schedule.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const tab: Tab = {
  id: 'schedules',
  title: 'Schedules',
  icon: CalendarClock,
  order: 3.5, // right after Agents — the software-factory backbone
  appliesTo: () => true,
  // Intentionally no badge. The Runs tab badge already surfaces "running
  // now" + failures from the unified view; a schedules count next to the
  // tab is noise (there's almost always >0 schedules).
  Component: SchedulesTab,
}
export default tab

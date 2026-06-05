import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Play,
  BookText,
  ScanSearch,
  ListChecks,
  TestTube2,
  ShieldAlert,
  Gauge,
  PackageCheck,
  Eraser,
  Square,
  Trash2,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Pencil,
  RotateCcw,
  Plus,
  MessageSquare,
  ClipboardList,
  Footprints,
  Swords,
  Telescope,
  Target,
  Lock,
  Languages,
  ScrollText,
  Scissors,
  MessageCircleQuestion,
  Recycle,
  Library,
  Newspaper,
  Factory,
  Wrench,
  Workflow,
  RadioTower,
  AlertOctagon,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { Badge, ForceChip } from '../../components/ui'
import { EnginePicker } from '../../components/EnginePicker'
import { EngineLogo } from '../../components/EngineLogo'
import { EngineModelPicker } from '../../components/EngineModelPicker'
import { BashHighlight } from '../../components/BashHighlight'
import { SkillHint } from '../../components/SkillHint'
import type { BadgeTone } from '../../components/ui'
import { navigateTo } from '../../lib/nav'
import type { Tab, TabContext, Agent, AgentRun, Engine, EnginePick } from '../../lib/types'
import { sanitizeLog as stripAnsi } from '../../lib/sanitizeLog'
import { seedRunOutput, seedRunOutputs } from './agentRunOutputState'
import { agentDotState } from './agentDotState'
import { useRepoScope } from '../../lib/useRepoScope'

function fmtRelative(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

const AGENT_ICON: Record<string, LucideIcon> = {
  BookText,
  ScanSearch,
  ListChecks,
  TestTube2,
  ShieldAlert,
  Gauge,
  PackageCheck,
  Eraser,
  Factory,
  Wrench,
  MessageSquare,
  ClipboardList,
  Footprints,
  Swords,
  Telescope,
  Target,
  Lock,
  Languages,
  ScrollText,
  Scissors,
  MessageCircleQuestion,
  Recycle,
  Library,
  Newspaper,
  Workflow,
  RadioTower,
  AlertOctagon,
  Undo2,
  Bot,
}
const statusTone = (s: string): BadgeTone =>
  s === 'done'
    ? 'green'
    : s === 'failed'
      ? 'red'
      : s === 'interrupted'
        ? 'yellow'
        : s === 'canceled'
          ? 'mute'
          : 'blue'
const repoOf = (root: string) => root.split('/').filter(Boolean).pop() || root

function reltime(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

const SOURCE: Record<string, { label: string; tone: BadgeTone }> = {
  default: { label: 'default', tone: 'mute' },
  override: { label: 'customized', tone: 'yellow' },
  repo: { label: 'custom', tone: 'accent' },
  global: { label: 'global', tone: 'blue' },
}
// How the engine wraps the prompt at run time (worktree filled in per run).
const runsAs = (engine: Engine): string =>
  engine === 'claude'
    ? "claude -p '<prompt>' --dangerously-skip-permissions"
    : "codex exec -s danger-full-access -C <worktree> '<prompt>'"

const FIELD =
  'w-full rounded-lg border border-[var(--gt-border)] bg-black/30 px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-[var(--gt-accent)]/60'

// Add / edit an agent. Saving writes <repo>/.agents/agents.json (overriding a
// built-in default = same id). The id is immutable once set.
function AgentDesigner({
  onClose,
  onSpawned,
  onAdvanced,
}: {
  onClose: () => void
  onSpawned: (run: AgentRun) => void
  onAdvanced: () => void
}) {
  const [text, setText] = useState('')
  const [engine, setEngine] = useState<Engine>('claude')
  const [model, setModel] = useState<string | undefined>(undefined)
  const [scope, setScope] = useState<'repo' | 'global'>('repo')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    window.gt.settings.get().then((s) => setEngine(s.defaultEngine))
  }, [])

  const submit = async () => {
    const t = text.trim()
    if (!t) return
    setBusy(true)
    setErr('')
    const r = await window.gt.agents.design(t, engine, scope, model)
    setBusy(false)
    if (r && 'error' in r) {
      setErr(r.error)
      return
    }
    onSpawned(r as AgentRun)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-[640px] flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Bot size={16} strokeWidth={2} className="text-[var(--gt-accent-light)]" />
          <h2 className="text-sm font-bold text-zinc-100">New agent</h2>
          <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-zinc-500">
            Describe what it does —
            <EngineLogo engine={engine} size={11} />
            {engine} writes the prompt + saves it
          </span>
        </div>
        <SkillHint>
          You can also ask from the terminal with{' '}
          <code className="font-mono text-zinc-300">/new-agent "Create me an agent that …"</code> in Claude or{' '}
          <code className="font-mono text-zinc-300">$new-agent "Create me an agent that …"</code> in Codex.
        </SkillHint>
        <label className="flex flex-col gap-1">
          <div className="flex items-end justify-between">
            <span className="text-[10.5px] uppercase tracking-wider text-zinc-500">Description</span>
            {/* Templates — single click prefills the textarea with a starting
                description that nudges the designer toward a specific shape. */}
            <div className="flex items-center gap-1 text-[10px] text-zinc-600">
              <span>start from:</span>
              {(
                [
                  {
                    label: 'precheck + escalate',
                    text:
                      'A scheduled agent that runs a deterministic precheck first (tsc, tests, lint) and only escalates to an LLM when something fails. On failure, diagnose the failures and apply a small surgical fix if safe, else file a backlog ticket. Default model: haiku.',
                  },
                  {
                    label: 'single LLM call',
                    text: 'A simple agent that runs a single claude prompt to … (fill in the task). Opens a PR with the result. Default model: sonnet.',
                  },
                  {
                    label: 'pure deterministic',
                    text: 'A pure shell agent (no LLM) that runs … (fill in the check), files a HITL via terminal-cli only if a probe fails, and emits an activity event with the summary on success.',
                  },
                ] as const
              ).map((t) => (
                <button
                  key={t.label}
                  onClick={() => setText(t.text)}
                  className="rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 hover:border-[var(--gt-accent)]/60 hover:text-zinc-300"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
            rows={5}
            autoFocus
            placeholder={
              "e.g. An agent that scans the repo for any TODO/FIXME older than 90 days, files a ticket per cluster, and opens a PR only if it can safely clean up the matching comments without changing behavior. Run weekly."
            }
            className="resize-none rounded-md border border-[var(--gt-border)] bg-black/30 px-3 py-2 text-[12.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-[var(--gt-accent)]/60 focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] uppercase tracking-wider text-zinc-500">Scope</span>
            <div className="flex items-center gap-0.5 rounded-md border border-[var(--gt-border)] p-0.5">
              {(
                [
                  { id: 'repo', label: 'This repo' },
                  { id: 'global', label: 'Global' },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setScope(s.id)}
                  title={
                    s.id === 'repo'
                      ? "Save to this repo's .agents/agents.json"
                      : 'Save to the global registry (~/.config/TerMinal/agents/global.json)'
                  }
                  className={`rounded-sm px-2 py-1 text-[11px] ${
                    scope === s.id
                      ? 'bg-[var(--gt-accent)]/20 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] uppercase tracking-wider text-zinc-500">Engine + model</span>
            <EngineModelPicker engine={engine} model={model} onChange={(e, m) => { setEngine(e); setModel(m) }} size="sm" />
          </label>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onAdvanced}
              className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
              title="Skip the designer and write the agent JSON yourself"
            >
              Advanced…
            </button>
            <button
              onClick={onClose}
              className="rounded-md border border-[var(--gt-border)] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!text.trim() || busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--gt-accent)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
            >
              {busy ? <Bot size={12} strokeWidth={2.5} /> : <EngineLogo engine={engine} size={12} />}
              {busy ? 'Spawning…' : `Design with ${engine}`}
            </button>
          </div>
        </div>

        {err && <div className="text-[11px] text-[var(--gt-red)]">{err}</div>}
        <div className="text-[10.5px] text-zinc-600">
          ⌘↵ to submit · the designer reads CLAUDE.md, <span className="font-mono">.agents/forge.md</span>, and
          existing agent specs before writing your agent's prompt so it follows this project's MR + ticket conventions
          (worktree, auto-mergeable label, sole-writer scope, depends_on).
        </div>
      </div>
    </div>
  )
}

function AgentEditor({
  agent,
  onClose,
  onSaved,
}: {
  agent: Agent | 'new'
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = agent === 'new'
  const a = isNew ? null : (agent as Agent)
  const [id, setId] = useState(a?.id || '')
  const [title, setTitle] = useState(a?.title || '')
  const [description, setDescription] = useState(a?.description || '')
  const [engine, setEngine] = useState<Engine>(a?.engine || 'claude')
  const [model, setModel] = useState(a?.model || '')
  const [opensPr, setOpensPr] = useState(!!a?.opensPr)
  const [prompt, setPrompt] = useState(a?.prompt || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    setBusy(true)
    setErr('')
    const r = await window.gt.agents.save({
      id: id.trim(),
      title: title.trim(),
      description: description.trim(),
      engine,
      model: model.trim() || undefined,
      opensPr,
      prompt,
    })
    setBusy(false)
    if (r && 'error' in r) setErr(r.error)
    else onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-[640px] flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-zinc-100">{isNew ? 'New agent' : `Edit · ${a?.title}`}</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/5">
            cancel
          </button>
        </div>
        {isNew && (
          <SkillHint>
            You can also create one from the terminal with{' '}
            <code className="font-mono text-zinc-300">/new-agent "Create me an agent that …"</code> or{' '}
            <code className="font-mono text-zinc-300">$new-agent "Create me an agent that …"</code>.
          </SkillHint>
        )}
        {!isNew && a?.source !== 'repo' && (
          <p className="text-[11px] text-[var(--gt-yellow)]">
            Editing a built-in default — saving writes an override to{' '}
            <span className="font-mono">.agents/agents.json</span>; “Reset” reverts to the default.
          </p>
        )}
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          disabled={!isNew}
          placeholder="id (kebab-case, e.g. triage-issues)"
          className={`${FIELD} font-mono ${isNew ? '' : 'opacity-50'}`}
        />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={FIELD} />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description (optional)"
          className={FIELD}
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
            />
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-zinc-300">
            <input type="checkbox" checked={opensPr} onChange={(e) => setOpensPr(e.target.checked)} />
            opens a PR
          </label>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={12}
          placeholder="The full prompt the agent runs (what it should do, what to file/open, how to finish)…"
          className={`${FIELD} resize-y font-mono leading-relaxed`}
        />
        {err && <p className="text-[11px] text-[var(--gt-red)]">{err}</p>}
        <button
          onClick={save}
          disabled={busy || !id.trim() || !title.trim() || !prompt.trim()}
          className="self-start rounded-lg bg-[var(--gt-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save agent'}
        </button>
      </div>
    </div>
  )
}

function AgentsTab({ ctx }: { ctx: TabContext }) {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [outputs, setOutputs] = useState<Record<string, string>>({})
  const [sel, setSel] = useState<string | null>(null)
  const [picking, setPicking] = useState<{ id: string; title: string } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<Agent | 'new' | null>(null)
  // Persist UI position across reloads so coming back to the tab lands on the
  // same agent/filter/search. Cheap localStorage; the values are tiny strings.
  const [agentFilter, setAgentFilter] = useState<'all' | 'generic' | 'per-repo'>(
    () => (localStorage.getItem('gt.agents.filter') as 'all' | 'generic' | 'per-repo') || 'all',
  )
  const [agentSearch, setAgentSearch] = useState<string>(
    () => localStorage.getItem('gt.agents.search') || '',
  )
  const [selAgentId, setSelAgentId] = useState<string | null>(
    () => localStorage.getItem('gt.agents.sel') || null,
  )
  useEffect(() => {
    localStorage.setItem('gt.agents.filter', agentFilter)
  }, [agentFilter])
  useEffect(() => {
    localStorage.setItem('gt.agents.search', agentSearch)
  }, [agentSearch])
  useEffect(() => {
    if (selAgentId) localStorage.setItem('gt.agents.sel', selAgentId)
    else localStorage.removeItem('gt.agents.sel')
  }, [selAgentId])
  const [designerOpen, setDesignerOpen] = useState(false)
  const [scripts, setScripts] = useState<Record<string, { path: string; body: string } | null>>({})
  const logRef = useRef<HTMLPreElement>(null)

  const reloadAgents = () => window.gt.agents.list().then(setAgents)
  // Lazy-load the bash script body the first time we need it; cache the
  // result (including null when definitively no script exists) so we don't
  // re-hit IPC. Triggered on agent select (new master-detail layout) and on
  // expand toggle (legacy paths).
  const loadScript = (id: string) => {
    if (id in scripts) return
    window.gt.agents.script(id).then((r) => setScripts((m) => ({ ...m, [id]: r })))
  }
  // Auto-load script when an agent is selected so the right pane's Script
  // section can show "Loading…" → bash / prompt without a manual click.
  useEffect(() => {
    if (selAgentId) loadScript(selAgentId)
  }, [selAgentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-source last-run status per agent. We already have in-process runs
  // in `runs`; for cron runs, fetch via the unified endpoint so the left rail
  // also covers schedule-fired runs. Refresh on activity:event so a freshly
  // finished cron run updates the status dot immediately.
  const [allRuns, setAllRuns] = useState<
    { id: string; agentId: string; status: string; startedAt: number; endedAt?: number; repoRoot: string }[]
  >([])
  // Per-agent week-spend from the AI ledger (#0001). Joined into the
  // Recent-runs header so the operator sees "Sonnet eats $4 this week"
  // without flipping to the Spend tab.
  const [agentSpendWeek, setAgentSpendWeek] = useState<
    Record<string, { runs: number; usd: number }>
  >({})
  useEffect(() => {
    const load = () =>
      window.gt.observability.byAgent('week').then((rows) => {
        const m: Record<string, { runs: number; usd: number }> = {}
        for (const r of rows) m[r.agentId] = { runs: r.runs, usd: r.usd }
        setAgentSpendWeek(m)
      })
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const load = () => window.gt.agents.allRuns().then(setAllRuns)
    load()
    // The activity firehose can fire many events for a single fs-watch tick
    // (drainTail broadcasts every new line), which previously meant one
    // allRuns() IPC per line. Coalesce a burst into one trailing reload.
    let timer: ReturnType<typeof setTimeout> | null = null
    const debouncedLoad = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        load()
      }, 250)
    }
    const off = window.gt.activity.onEvent(debouncedLoad)
    const t = setInterval(load, 30_000)
    return () => {
      off()
      clearInterval(t)
      if (timer) clearTimeout(timer)
    }
  }, [])
  // The rail lists THIS repo's agents, so its run status must come from THIS
  // repo's runs too — otherwise a same-named agent running in another repo
  // would colour the dot here. allRuns spans every repo + cron + in-process.
  const lastRunByAgent = useMemo(() => {
    const here = repoOf(ctx.repoRoot)
    const m = new Map<string, { status: string; startedAt: number }>()
    // allRuns is already startedAt-desc; first hit per agent wins.
    for (const r of allRuns) {
      if (repoOf(r.repoRoot) !== here) continue
      if (!m.has(r.agentId)) m.set(r.agentId, { status: r.status, startedAt: r.startedAt })
    }
    return m
  }, [allRuns, ctx.repoRoot])

  // Per-(repo, agent) state sidecar. Surfaced in the right pane so the
  // operator can see "last scanned X ago" without `cat`-ing the JSON.
  // Re-fetched on select + after a successful run completes (the agent
  // would normally call `terminal-cli state mark-main` at exit).
  const [state, setState] = useState<{
    path: string
    exists: boolean
    state: Record<string, unknown>
  } | null>(null)
  const reloadState = (id: string | null) => {
    if (!id) return setState(null)
    window.gt.agents.state(id).then(setState)
  }
  useEffect(() => {
    reloadState(selAgentId)
  }, [selAgentId])
  // Bump the state view when ANY run for the selected agent finishes — the
  // run almost certainly wrote a new lastScannedSha/lastRunAt.
  //
  // onStatus only fires for IN-PROCESS runs (Run button on this tab, on
  // Tickets, on PRs). Cron runs fire from launchd; their completion never
  // reaches the renderer that way. We ALSO listen on activity:event because
  // every cron run's `check`/`run-failed` activity emit lands here regardless
  // of who started it. The state IPC is one file read — re-running it on
  // every activity tick is dirt-cheap.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const debouncedReload = () => {
      if (!selAgentId || timer) return
      timer = setTimeout(() => {
        timer = null
        reloadState(selAgentId)
      }, 250)
    }
    const offStatus = window.gt.agents.onStatus((run) => {
      const r = run as { agentId?: string; status?: string }
      if (r.agentId === selAgentId && (r.status === 'done' || r.status === 'failed')) {
        reloadState(selAgentId)
      }
    })
    // Coalesce the firehose: one trailing state read per burst, not one per event.
    const offAct = window.gt.activity.onEvent(debouncedReload)
    return () => {
      offStatus()
      offAct()
      if (timer) clearTimeout(timer)
    }
  }, [selAgentId])
  const toggleExpand = (id: string) => {
    loadScript(id)
    setExpanded((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  useEffect(() => {
    window.gt.agents.list().then(setAgents)
    window.gt.agents.runs().then((rs) => {
      setRuns(rs)
      setOutputs((o) => seedRunOutputs(o, rs))
      if (rs[0]) setSel((s) => s ?? rs[0].id)
    })
    const offStatus = window.gt.agents.onStatus((run) => {
      setRuns((prev) => {
        const i = prev.findIndex((r) => r.id === run.id)
        if (i < 0) return [run, ...prev]
        const next = [...prev]
        next[i] = run
        return next
      })
      setOutputs((o) => seedRunOutput(o, run))
      setSel((s) => s ?? run.id)
      // When a designer run finishes, reload the agents list so the newly-
      // saved entry shows up without a manual refresh — then auto-expand
      // the new agent and load its script so the bash body is immediately
      // visible (closes the loop on the "describe it → see the script" flow).
      if (
        (run.agentId === 'design-repo' || run.agentId === 'design-global') &&
        run.status === 'done'
      ) {
        const priorIds = new Set((agents || []).map((a) => a.id))
        window.gt.agents.list().then((next) => {
          setAgents(next)
          const fresh = next.find((a) => !priorIds.has(a.id))
          if (!fresh) return
          setExpanded((s) => new Set([...s, fresh.id]))
          window.gt.agents
            .script(fresh.id)
            .then((r) => setScripts((m) => ({ ...m, [fresh.id]: r })))
        })
      }
    })
    const offOutput = window.gt.agents.onOutput(({ runId, chunk }) => {
      setOutputs((o) => ({ ...o, [runId]: (o[runId] || '') + chunk }))
    })
    return () => {
      offStatus()
      offOutput()
    }
  }, [ctx.sessionId])

  // The rail lists this repo's agents, so its Runs panel defaults to this repo
  // too (the "all repos" opt-out persists). See useRepoScope.
  const { repo: repoFilter, setRepo: setRepoFilter, currentRepo } = useRepoScope(
    ctx.repoRoot,
    'agents.runsRepoFilter',
  )
  const selectedRun = runs.find((r) => r.id === sel) || null
  // Busy = a run in progress for THIS repo. Derived from allRuns (not the
  // in-process `runs` map) so it also surfaces cron/launchd runs and self-
  // corrects: allRuns refetches on every activity event + every 30s, and the
  // main process reaps orphaned 'running' state, so a stuck pulse can't linger.
  const runningByAgent = useMemo(() => {
    const here = repoOf(ctx.repoRoot)
    return new Set(
      allRuns.filter((r) => r.status === 'running' && repoOf(r.repoRoot) === here).map((r) => r.agentId),
    )
  }, [allRuns, ctx.repoRoot])
  // Runs are global across every repo; the filter just narrows the list.
  const repoOptions = useMemo(
    () => [...new Set([...runs.map((r) => repoOf(r.repoRoot)), currentRepo].filter(Boolean))].sort(),
    [runs, currentRepo],
  )
  const shownRuns = repoFilter ? runs.filter((r) => repoOf(r.repoRoot) === repoFilter) : runs
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sel, selectedRun && outputs[selectedRun.id]])

  const run = async (id: string, engine: EnginePick, persona: string, pipeline: string, model?: string) => {
    const r = await window.gt.agents.run(id, engine, persona, pipeline, model)
    if ('error' in r) {
      setOutputs((o) => ({ ...o, __err: r.error }))
      return
    }
    setRuns((prev) => [r, ...prev.filter((x) => x.id !== r.id)])
    setOutputs((o) => seedRunOutput(o, r))
    setSel(r.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--gt-bg)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gt-border)] px-4 py-2">
        <Bot size={14} strokeWidth={2} className="text-zinc-400" />
        <span className="text-[12px] font-semibold text-zinc-200">Agents</span>
        <span className="text-[11px] text-zinc-600">
          own worktree · opens a PR · {ctx.repoPath || ctx.repoRoot.replace(/^.*\//, '')}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ━━ LEFT RAIL: narrow agents list (search + filter + click-to-select) ━━ */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--gt-border)] bg-[var(--gt-panel)]/30">
          <div className="shrink-0 space-y-1.5 border-b border-[var(--gt-border)] p-2">
            <div className="flex items-center gap-1.5">
              <input
                value={agentSearch}
                onChange={(e) => setAgentSearch(e.target.value)}
                placeholder="Search agents…"
                className="min-w-0 flex-1 rounded-md border border-[var(--gt-border)] bg-black/30 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-[var(--gt-accent)]/60 focus:outline-none"
              />
              <button
                onClick={() => setDesignerOpen(true)}
                title="Design a new agent — describe what it does, claude/codex writes the bash"
                className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-accent)]/40 bg-[var(--gt-accent)]/10 px-2 py-1 text-[11px] font-semibold text-[var(--gt-accent-light)] hover:bg-[var(--gt-accent)]/20"
              >
                <Plus size={12} strokeWidth={2.5} />
                New
              </button>
            </div>
            <div className="flex items-center gap-0.5 rounded-md border border-[var(--gt-border)] p-0.5">
              {(['all', 'generic', 'per-repo'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setAgentFilter(f)}
                  className={`flex-1 rounded-sm px-1.5 py-0.5 text-[10px] capitalize ${
                    agentFilter === f
                      ? 'bg-[var(--gt-accent)]/20 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {f === 'per-repo' ? 'per-repo' : f}
                </button>
              ))}
            </div>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto">
            {agents === null ? (
              <div className="p-3 text-[12px] text-zinc-600">Loading…</div>
            ) : (
              (() => {
                const q = agentSearch.trim().toLowerCase()
                const list = agents
                  .filter((a) => {
                    if (agentFilter === 'generic') return a.source === 'default'
                    if (agentFilter === 'per-repo') return a.source === 'override' || a.source === 'repo'
                    return true
                  })
                  .filter(
                    (a) =>
                      !q ||
                      a.id.toLowerCase().includes(q) ||
                      a.title.toLowerCase().includes(q) ||
                      (a.description || '').toLowerCase().includes(q),
                  )
                if (list.length === 0)
                  return <div className="p-3 text-[11px] text-zinc-600">No agents match.</div>
                return list.map((a) => {
                  const Icon = AGENT_ICON[a.icon || ''] || Bot
                  const on = selAgentId === a.id
                  const busy = runningByAgent.has(a.id)
                  const last = busy ? null : lastRunByAgent.get(a.id) || null
                  const { className: dot, title: dotTitle } = agentDotState({
                    busy,
                    last: last ? { status: last.status, relLabel: fmtRelative(last.startedAt) } : null,
                  })
                  return (
                    <button
                      key={a.id}
                      onClick={() => setSelAgentId(a.id)}
                      title={a.description || a.title}
                      className={`flex w-full items-center gap-2 border-b border-[var(--gt-border)]/40 px-2.5 py-1 text-left ${
                        on ? 'bg-[var(--gt-accent)]/15' : 'hover:bg-white/5'
                      }`}
                    >
                      <Icon
                        size={13}
                        strokeWidth={2}
                        className={`shrink-0 ${
                          on ? 'text-[var(--gt-accent-light)]' : 'text-zinc-500'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-100">
                        {a.title}
                      </span>
                      {a.force && <ForceChip />}
                      {a.hasScript && (
                        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--gt-accent-light)]/70">
                          sh
                        </span>
                      )}
                      {dot && (
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
                          title={dotTitle}
                        />
                      )}
                    </button>
                  )
                })
              })()
            )}
          </nav>
        </aside>

        {/* ━━ RIGHT PANE: selected-agent detail (header + script + runs + log) ━━ */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {(() => {
            const selectedAgent = (agents || []).find((a) => a.id === selAgentId)
            if (!selectedAgent)
              return (
                <div className="flex h-full items-center justify-center text-[12px] text-zinc-600">
                  Pick an agent on the left, or click <span className="mx-1 font-semibold text-zinc-400">New</span>{' '}
                  to design one.
                </div>
              )
            const Icon = AGENT_ICON[selectedAgent.icon || ''] || Bot
            const busy = runningByAgent.has(selectedAgent.id)
            const script = scripts[selectedAgent.id]
            const agentRuns = runs.filter((r) => r.agentId === selectedAgent.id)
            return (
              <>
                {/* Agent header — title + actions */}
                <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gt-border)] px-5 py-3">
                  <Icon size={18} strokeWidth={2} className="text-[var(--gt-accent-light)]" />
                  <h2 className="text-[14px] font-bold text-zinc-100">{selectedAgent.title}</h2>
                  {selectedAgent.force && <ForceChip size="md" />}
                  {selectedAgent.source && (
                    <Badge tone={SOURCE[selectedAgent.source].tone}>{SOURCE[selectedAgent.source].label}</Badge>
                  )}
                  {selectedAgent.hasScript && <Badge tone="blue">sh</Badge>}
                  <span className="font-mono text-[10px] text-zinc-600">{selectedAgent.id}</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => setPicking({ id: selectedAgent.id, title: selectedAgent.title })}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-lg bg-[var(--gt-accent)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {busy ? (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-white gt-pulse" />
                        Running
                      </>
                    ) : (
                      <>
                        <Play size={13} strokeWidth={2.5} />
                        Run
                      </>
                    )}
                  </button>
                  {script && (
                    <button
                      onClick={() => window.gt.openInEditor(script.path)}
                      title="Edit the .sh in your configured editor"
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-300 hover:border-[var(--gt-accent)]/60"
                    >
                      <Pencil size={11} strokeWidth={2} />
                      Edit script
                    </button>
                  )}
                  <button
                    onClick={() => setEditing(selectedAgent)}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-400 hover:border-[var(--gt-accent)]/60"
                    title="Edit the metadata sidecar (title/icon/engine/etc.)"
                  >
                    <Pencil size={11} strokeWidth={2} />
                    Metadata
                  </button>
                  {selectedAgent.source === 'override' && (
                    <button
                      onClick={async () => {
                        await window.gt.agents.reset(selectedAgent.id)
                        reloadAgents()
                      }}
                      title="Revert to the built-in default"
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-400 hover:border-[var(--gt-yellow)]/60 hover:text-[var(--gt-yellow)]"
                    >
                      <RotateCcw size={11} strokeWidth={2} />
                      Reset
                    </button>
                  )}
                </header>

                {selectedAgent.description && (
                  <div className="shrink-0 px-5 py-2 text-[12px] text-zinc-400">{selectedAgent.description}</div>
                )}
                <div className="shrink-0 border-b border-[var(--gt-border)]/60 px-5 pb-2 text-[10.5px] text-zinc-600">
                  runs as:{' '}
                  <EngineLogo
                    engine={selectedAgent.engine || 'codex'}
                    size={10}
                    className="mx-0.5 -mb-0.5"
                  />
                  {runsAs(selectedAgent.engine || 'codex')}
                  {selectedAgent.model && (
                    <>
                      <span className="mx-1 text-zinc-700">·</span>model: {selectedAgent.model}
                    </>
                  )}
                </div>

                {/* Scrollable body: script preview, runs, output */}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {/* Script preview — script can be undefined (loading), null
                      (definitively no .sh), or {path,body} (script loaded). */}
                  <section className="border-b border-[var(--gt-border)]/60 p-4">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                      {script ? (
                        <Badge tone="blue">bash script</Badge>
                      ) : script === null ? (
                        <Badge tone="mute">prompt</Badge>
                      ) : (
                        <Badge tone="mute">loading…</Badge>
                      )}
                      <span className="ml-1 min-w-0 flex-1 truncate font-normal normal-case tracking-normal">
                        {script
                          ? script.path
                          : script === null
                            ? `no .agents/${selectedAgent.id}.sh — runs as a single claude/codex prompt`
                            : `reading .agents/${selectedAgent.id}.sh…`}
                      </span>
                      {script === null && (
                        <button
                          onClick={async () => {
                            const r = await window.gt.agents.convert(selectedAgent.id)
                            if ('error' in r) {
                              alert(`convert failed: ${r.error}`)
                              return
                            }
                            setScripts((m) => ({ ...m, [selectedAgent.id]: { path: r.scriptPath, body: '' } }))
                            window.gt.agents
                              .script(selectedAgent.id)
                              .then((s) => setScripts((m) => ({ ...m, [selectedAgent.id]: s })))
                            reloadAgents()
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-accent)]/50 bg-[var(--gt-accent)]/10 px-2 py-0.5 text-[10px] normal-case tracking-normal text-[var(--gt-accent-light)] hover:bg-[var(--gt-accent)]/20"
                        >
                          convert to script
                        </button>
                      )}
                    </h3>
                    {script ? (
                      <BashHighlight code={script.body} className="max-h-96" />
                    ) : script === null ? (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--gt-border)] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-400">
                        {selectedAgent.prompt}
                      </pre>
                    ) : (
                      <div className="rounded-lg border border-dashed border-[var(--gt-border)] p-4 text-center text-[11px] text-zinc-600">
                        Loading script…
                      </div>
                    )}
                  </section>

                  {/* Per-(repo, agent) state sidecar — what the agent remembers
                      between runs. Empty = first-time / never `terminal-cli state
                      mark-main`'d. Reset wipes the file so the next run does a
                      cold scan. */}
                  <section className="border-b border-[var(--gt-border)]/60 p-4">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                      <Badge tone={state?.exists ? 'accent' : 'mute'}>state</Badge>
                      <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[9.5px] font-normal normal-case tracking-normal text-zinc-600">
                        {state?.path || '…'}
                      </span>
                      {state?.exists && (
                        <button
                          onClick={async () => {
                            if (!confirm('Reset state? Next run will scan from cold.')) return
                            await window.gt.agents.stateReset(selectedAgent.id)
                            reloadState(selectedAgent.id)
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-zinc-400 hover:border-[var(--gt-red)]/60 hover:text-[var(--gt-red)]"
                        >
                          reset
                        </button>
                      )}
                    </h3>
                    {!state ? (
                      <div className="rounded-lg border border-dashed border-[var(--gt-border)] p-3 text-center text-[11px] text-zinc-600">
                        Loading…
                      </div>
                    ) : !state.exists ? (
                      <div className="rounded-lg border border-dashed border-[var(--gt-border)] p-3 text-[11px] leading-relaxed text-zinc-500">
                        No state yet. Cadence agents persist their progress here via{' '}
                        <code className="font-mono text-zinc-300">terminal-cli state mark-main</code>; nothing to show
                        until the first run writes.
                      </div>
                    ) : (
                      (() => {
                        const s = state.state
                        const sha =
                          typeof s.lastScannedSha === 'string' ? s.lastScannedSha : ''
                        const ref = typeof s.lastScannedRef === 'string' ? s.lastScannedRef : ''
                        const at =
                          typeof s.lastRunAt === 'number' ? s.lastRunAt : 0
                        const runId =
                          typeof s.lastRunId === 'string' ? s.lastRunId : ''
                        const reserved = new Set([
                          'lastScannedSha',
                          'lastScannedRef',
                          'lastRunAt',
                          'lastRunId',
                        ])
                        const extras = Object.entries(s).filter(([k]) => !reserved.has(k))
                        const relTime = at ? fmtRelative(at) : ''
                        return (
                          <div className="space-y-1.5 rounded-lg border border-[var(--gt-border)] bg-black/30 p-3 text-[11px] text-zinc-300">
                            {sha && (
                              <div className="flex items-center gap-2">
                                <span className="w-28 shrink-0 text-zinc-600">last scanned</span>
                                <span className="font-mono text-zinc-200">{sha.slice(0, 12)}</span>
                                {ref && (
                                  <span className="rounded-md border border-[var(--gt-border)] px-1 py-0.5 text-[9.5px] uppercase text-zinc-500">
                                    {ref}
                                  </span>
                                )}
                              </div>
                            )}
                            {at > 0 && (
                              <div className="flex items-center gap-2">
                                <span className="w-28 shrink-0 text-zinc-600">last run at</span>
                                <span>{new Date(at).toLocaleString()}</span>
                                <span className="text-zinc-600">· {relTime}</span>
                              </div>
                            )}
                            {runId && (
                              <div className="flex items-center gap-2">
                                <span className="w-28 shrink-0 text-zinc-600">last run id</span>
                                <span className="truncate font-mono text-[10px] text-zinc-400">{runId}</span>
                                <button
                                  onClick={() => navigateTo('runs', { runId })}
                                  className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-100"
                                >
                                  view run
                                </button>
                              </div>
                            )}
                            {extras.length > 0 && (
                              <div className="mt-2 border-t border-[var(--gt-border)]/40 pt-2">
                                <div className="mb-1 text-[9.5px] uppercase tracking-wider text-zinc-600">
                                  extra keys
                                </div>
                                <div className="space-y-0.5 font-mono text-[10.5px]">
                                  {extras.map(([k, v]) => (
                                    <div key={k} className="flex items-baseline gap-2">
                                      <span className="text-zinc-500">{k}</span>
                                      <span className="text-zinc-300">
                                        {typeof v === 'string' ? v : JSON.stringify(v)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })()
                    )}
                  </section>

                  {/* Recent runs for THIS agent */}
                  <section className="border-b border-[var(--gt-border)]/60 p-4">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                      Recent runs
                      <span className="text-zinc-700">·</span>
                      <span className="tabular-nums text-zinc-600">{agentRuns.length}</span>
                      {(() => {
                        const s = agentSpendWeek[selectedAgent.id]
                        if (!s || s.usd <= 0) return null
                        return (
                          <>
                            <span className="text-zinc-700">·</span>
                            <span
                              className="font-mono tabular-nums normal-case text-[var(--gt-accent-light)]"
                              title="Total spend across this agent's runs in the last 7 days"
                            >
                              ${s.usd.toFixed(2)} / 7d
                            </span>
                            <span className="font-mono tabular-nums normal-case text-zinc-600">
                              · avg ${(s.usd / Math.max(s.runs, 1)).toFixed(3)}/run
                            </span>
                          </>
                        )
                      })()}
                    </h3>
                    {/* Sparkline: last 20 runs across cron + in-process, newest
                        on the right. Each bar is a tiny color-coded square
                        sized by duration (longer run = taller bar, capped).
                        Hover shows status + duration + when. */}
                    {(() => {
                      const allForAgent = allRuns
                        .filter((r) => r.agentId === selectedAgent.id)
                        .slice(0, 20)
                        .reverse()
                      if (allForAgent.length === 0) return null
                      // Need durations — refetch from agentRuns/allRuns. allRuns
                      // is the unified-runs shape with optional endedAt.
                      const withDuration = allForAgent.map((r) => {
                        const dur =
                          'endedAt' in r && (r as { endedAt?: number }).endedAt
                            ? (r as { endedAt: number }).endedAt - r.startedAt
                            : null
                        return { ...r, dur }
                      })
                      const maxDur = Math.max(
                        1000,
                        ...withDuration.map((r) => r.dur || 0),
                      )
                      return (
                        <div className="mb-3 flex items-end gap-[3px] rounded-md border border-[var(--gt-border)] bg-black/30 p-2">
                          {withDuration.map((r, i) => {
                            const h =
                              r.dur === null
                                ? 24
                                : Math.max(4, Math.round((r.dur / maxDur) * 32))
                            const tone =
                              r.status === 'done'
                                ? 'bg-[var(--gt-green)]'
                                : r.status === 'failed'
                                  ? 'bg-[var(--gt-red)]'
                                  : r.status === 'running'
                                    ? 'bg-[var(--gt-accent-light)] gt-pulse'
                                    : 'bg-zinc-600'
                            const when = new Date(r.startedAt).toLocaleString()
                            const durLabel = r.dur === null ? 'running' : fmtDuration(r.dur)
                            return (
                              <span
                                key={r.id}
                                title={`${i + 1 + allForAgent.length - withDuration.length}. ${r.status} · ${durLabel} · ${when}`}
                                className={`w-1.5 rounded-sm ${tone}`}
                                style={{ height: `${h}px` }}
                              />
                            )
                          })}
                          <span className="ml-2 text-[9.5px] text-zinc-600">
                            last {withDuration.length} (oldest → newest)
                          </span>
                        </div>
                      )
                    })()}
                    {agentRuns.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-[var(--gt-border)] p-4 text-center text-[11px] text-zinc-600">
                        No runs yet. Click <span className="mx-0.5 font-semibold text-zinc-400">Run</span> above to
                        kick one off.
                      </div>
                    ) : (
                      <div className="space-y-1 rounded-lg border border-[var(--gt-border)] bg-black/20">
                        {agentRuns.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => setSel(r.id)}
                            className={`flex w-full items-center gap-2 border-b border-[var(--gt-border)]/40 px-3 py-1.5 text-left last:border-b-0 ${
                              sel === r.id ? 'bg-white/5' : 'hover:bg-white/5'
                            }`}
                          >
                            <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-500">
                              {r.branch}
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] uppercase text-zinc-600">
                              <EngineLogo engine={r.engine} size={10} />
                              {r.engine}
                            </span>
                            <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
                              {reltime(r.startedAt)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* Selected run output */}
                  {selectedRun && selectedRun.agentId === selectedAgent.id && (
                    <section className="p-4">
                      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                        Run output
                        <span className="text-zinc-700">·</span>
                        <Badge tone={statusTone(selectedRun.status)}>{selectedRun.status}</Badge>
                        <span className="font-mono normal-case tracking-normal text-zinc-600">
                          {selectedRun.branch}
                        </span>
                        <div className="flex-1" />
                        {selectedRun.status === 'running' && (
                          <button
                            onClick={() => window.gt.agents.cancel(selectedRun.id)}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-zinc-300 hover:border-[var(--gt-red)]/60 hover:text-[var(--gt-red)]"
                          >
                            <Square size={9} strokeWidth={2} />
                            Cancel
                          </button>
                        )}
                        <button
                          onClick={() => window.gt.openExternal(`file://${selectedRun.worktree}`)}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-zinc-300 hover:border-[var(--gt-accent)]/60"
                        >
                          <FolderOpen size={9} strokeWidth={2} />
                          Worktree
                        </button>
                        {selectedRun.status !== 'running' && (
                          <button
                            onClick={() => window.gt.agents.removeWorktree(selectedRun.id)}
                            title="Remove the worktree (branch/PR stay)"
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-zinc-500 hover:border-[var(--gt-red)]/60 hover:text-[var(--gt-red)]"
                          >
                            <Trash2 size={9} strokeWidth={2} />
                          </button>
                        )}
                      </h3>
                      <pre
                        ref={logRef}
                        className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--gt-border)] bg-[#0c0c11] p-3 font-mono text-[11px] leading-relaxed text-zinc-300"
                      >
                        {stripAnsi(outputs[selectedRun.id] || '') || '…'}
                      </pre>
                    </section>
                  )}
                </div>
              </>
            )
          })()}
        </section>
      </div>
      {/* Legacy hidden container — kept so the old left-rail JSX below is dead but valid. */}
      <div style={{ display: 'none' }}>
        <div className="flex w-[44%] min-w-[340px] flex-col border-r border-[var(--gt-border)]">
          <div className="shrink-0 space-y-2 overflow-y-auto p-3" style={{ maxHeight: '58%' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-600">Agents</span>
                <div className="flex items-center gap-0.5 rounded-md border border-[var(--gt-border)] p-0.5">
                  {(['all', 'generic', 'per-repo'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setAgentFilter(f)}
                      className={`rounded-sm px-1.5 py-0.5 text-[10px] capitalize ${
                        agentFilter === f
                          ? 'bg-[var(--gt-accent)]/20 text-zinc-100'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {f === 'per-repo' ? 'per-repo' : f}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setDesignerOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-0.5 text-[11px] text-zinc-300 hover:border-[var(--gt-accent)]/60"
                title="Design a new agent — describe what it does, claude/codex writes the prompt"
              >
                <Plus size={12} strokeWidth={2.5} />
                New agent
              </button>
            </div>
            {agents === null ? (
              <div className="p-3 text-[12px] text-zinc-600">Loading…</div>
            ) : (
              agents
                .filter((a) => {
                  if (agentFilter === 'all') return true
                  // "generic" = unmodified defaults; "per-repo" = override + custom
                  if (agentFilter === 'generic') return a.source === 'default'
                  return a.source === 'override' || a.source === 'repo'
                })
                .map((a) => {
                const Icon = AGENT_ICON[a.icon || ''] || Bot
                const busy = runningByAgent.has(a.id)
                return (
                  <div
                    key={a.id}
                    className="rounded-xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-3"
                  >
                    <div className="flex items-start gap-2.5">
                      <Icon size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--gt-accent-light)]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-zinc-100">{a.title}</span>
                          {a.force && <ForceChip />}
                          {a.source && <Badge tone={SOURCE[a.source].tone}>{SOURCE[a.source].label}</Badge>}
                          {a.hasScript && <Badge tone="blue">sh</Badge>}
                        </div>
                        {a.description && (
                          <div className="text-[11.5px] leading-snug text-zinc-500">{a.description}</div>
                        )}
                      </div>
                      <button
                        onClick={() => setPicking({ id: a.id, title: a.title })}
                        disabled={busy}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--gt-accent)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
                      >
                        {busy ? (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-white gt-pulse" />
                            Running
                          </>
                        ) : (
                          <>
                            <Play size={13} strokeWidth={2.5} />
                            Run
                          </>
                        )}
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-[11px]">
                      <button
                        onClick={() => toggleExpand(a.id)}
                        className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-300"
                      >
                        {expanded.has(a.id) ? (
                          <ChevronDown size={12} strokeWidth={2} />
                        ) : (
                          <ChevronRight size={12} strokeWidth={2} />
                        )}
                        prompt
                      </button>
                      <button
                        onClick={() => setEditing(a)}
                        className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-300"
                      >
                        <Pencil size={11} strokeWidth={2} />
                        edit
                      </button>
                      {a.source === 'override' && (
                        <button
                          onClick={async () => {
                            await window.gt.agents.reset(a.id)
                            reloadAgents()
                          }}
                          title="Revert to the built-in default"
                          className="inline-flex items-center gap-1 text-zinc-500 hover:text-[var(--gt-yellow)]"
                        >
                          <RotateCcw size={11} strokeWidth={2} />
                          reset
                        </button>
                      )}
                    </div>
                    {expanded.has(a.id) && (
                      <div className="mt-2 space-y-1.5">
                        {scripts[a.id] ? (
                          <>
                            <div className="flex items-center gap-1.5 text-[10px]">
                              <Badge tone="blue">bash script</Badge>
                              <span className="min-w-0 flex-1 truncate font-mono text-zinc-600">
                                {scripts[a.id]!.path}
                              </span>
                              <button
                                onClick={() => window.gt.openInEditor(scripts[a.id]!.path)}
                                className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-1.5 py-0.5 text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-200"
                                title="Open in your configured editor (Settings → Apps)"
                              >
                                <Pencil size={9} strokeWidth={2} />
                                edit
                              </button>
                            </div>
                            <BashHighlight code={scripts[a.id]!.body} className="max-h-72" />
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5 text-[10px]">
                              <Badge tone="mute">prompt</Badge>
                              <span className="min-w-0 flex-1 truncate text-zinc-700">
                                {scripts[a.id] === null
                                  ? `no .agents/${a.id}.sh — runs as a single claude/codex prompt`
                                  : 'loading…'}
                              </span>
                              {scripts[a.id] === null && (
                                <button
                                  onClick={async () => {
                                    const r = await window.gt.agents.convert(a.id)
                                    if ('error' in r) {
                                      alert(`convert failed: ${r.error}`)
                                      return
                                    }
                                    // Refresh the cached script for this agent so the bash shows immediately.
                                    setScripts((m) => ({ ...m, [a.id]: { path: r.scriptPath, body: '' } }))
                                    window.gt.agents.script(a.id).then((s) =>
                                      setScripts((m) => ({ ...m, [a.id]: s })),
                                    )
                                    reloadAgents()
                                  }}
                                  className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-accent)]/50 bg-[var(--gt-accent)]/10 px-1.5 py-0.5 text-[var(--gt-accent-light)] hover:bg-[var(--gt-accent)]/20"
                                  title="Materialize this prompt-style agent as .agents/<id>.sh + sidecar so you can edit it as bash and mix deterministic checks with LLM calls."
                                >
                                  convert to script
                                </button>
                              )}
                            </div>
                            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--gt-border)] bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-400">
                              {a.prompt}
                            </pre>
                          </>
                        )}
                        <div className="break-all font-mono text-[9.5px] text-zinc-600">
                          runs as: <EngineLogo engine={a.engine || 'codex'} size={9} className="mx-0.5 -mb-0.5" />
                          {runsAs(a.engine || 'codex')}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--gt-border)]">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-600">Runs</span>
              <span className="text-[10px] text-zinc-700">{repoFilter || 'all repos'}</span>
              <div className="flex-1" />
              {repoOptions.length > 1 && (
                <select
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  title="Filter by repo"
                  className="rounded-md border border-[var(--gt-border)] bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none"
                >
                  <option value="">All repos</option>
                  {repoOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {runs.length === 0 ? (
              <div className="px-3 pb-3 text-[12px] text-zinc-600">No runs yet.</div>
            ) : shownRuns.length === 0 ? (
              <div className="px-3 pb-3 text-[12px] text-zinc-600">No runs for {repoFilter}.</div>
            ) : (
              shownRuns.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSel(r.id)}
                  className={`flex w-full items-center gap-2 border-b border-[var(--gt-border)]/50 px-3 py-2 text-left hover:bg-white/5 ${
                    sel === r.id ? 'bg-white/5' : ''
                  }`}
                >
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{r.agentTitle}</span>
                  <span className="shrink-0 font-mono text-[9.5px] text-zinc-600">{repoOf(r.repoRoot)}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] uppercase text-zinc-600">
                    <EngineLogo engine={r.engine} size={10} />
                    {r.engine}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">{reltime(r.startedAt)}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!selectedRun ? (
            <div className="flex h-full items-center justify-center text-[12px] text-zinc-600">
              Run an agent to see its output.
            </div>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gt-border)] px-4 py-2">
                <Badge tone={statusTone(selectedRun.status)}>{selectedRun.status}</Badge>
                <span className="text-[12px] font-semibold text-zinc-100">{selectedRun.agentTitle}</span>
                <span className="inline-flex items-center gap-1 text-[9.5px] uppercase text-zinc-600">
                  <EngineLogo engine={selectedRun.engine} size={11} />
                  {selectedRun.engine}
                </span>
                {selectedRun.persona && (
                  <span className="text-[10px] text-[var(--gt-accent-light)]">as {selectedRun.persona}</span>
                )}
                {selectedRun.pipeline && (
                  <span className="text-[10px] text-[var(--gt-accent-light)]">· {selectedRun.pipeline}</span>
                )}
                <span className="font-mono text-[10.5px] text-zinc-600">{selectedRun.branch}</span>
                <div className="flex-1" />
                {selectedRun.status === 'running' && (
                  <button
                    onClick={() => window.gt.agents.cancel(selectedRun.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-300 hover:border-[var(--gt-red)]/60 hover:text-[var(--gt-red)]"
                  >
                    <Square size={11} strokeWidth={2} />
                    Cancel
                  </button>
                )}
                <button
                  onClick={() => window.gt.openExternal(`file://${selectedRun.worktree}`)}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-300 hover:border-[var(--gt-accent)]/60"
                >
                  <FolderOpen size={11} strokeWidth={2} />
                  Worktree
                </button>
                {selectedRun.status !== 'running' && (
                  <button
                    onClick={() => window.gt.agents.removeWorktree(selectedRun.id)}
                    title="Remove the worktree (branch/PR stay)"
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[11px] text-zinc-500 hover:border-[var(--gt-red)]/60 hover:text-[var(--gt-red)]"
                  >
                    <Trash2 size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
              <pre
                ref={logRef}
                className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[#0c0c11] p-4 font-mono text-[11.5px] leading-relaxed text-zinc-300"
              >
                {stripAnsi(outputs[selectedRun.id] || '') || '…'}
              </pre>
            </>
          )}
        </div>
      </div>

      {picking && (
        <EnginePicker
          title={`Run · ${picking.title}`}
          onClose={() => setPicking(null)}
          onPick={(e, persona, pipeline, model) => {
            run(picking.id, e, persona, pipeline, model)
            setPicking(null)
          }}
        />
      )}

      {designerOpen && (
        <AgentDesigner
          onClose={() => setDesignerOpen(false)}
          onSpawned={(r) => {
            setDesignerOpen(false)
            setRuns((prev) => [r, ...prev.filter((x) => x.id !== r.id)])
            setSel(r.id)
          }}
          onAdvanced={() => {
            setDesignerOpen(false)
            setEditing('new')
          }}
        />
      )}

      {editing && (
        <AgentEditor
          agent={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reloadAgents()
          }}
        />
      )}
    </div>
  )
}

const tab: Tab = {
  id: 'agents',
  title: 'Agents',
  icon: Bot,
  order: 3,
  appliesTo: (ctx) => ctx.hasAgents,
  badge: async (gt) => (await gt.agents.runs()).filter((r) => r.status === 'running').length,
  Component: AgentsTab,
}
export default tab

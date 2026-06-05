import { useEffect, useState, type ReactNode } from 'react'
import {
  X,
  FolderOpen,
  Loader2,
  Send,
  CircleCheck,
  CircleSlash,
  RotateCcw,
  TerminalSquare,
  ClipboardCopy,
} from 'lucide-react'
import type { Settings, SettingsPatch, EnvDetect, Engine, ForgePref, RoleId } from '../lib/types'
import { useProjectsDirCheck } from '../lib/useProjectsDirCheck'
import { ProjectsDirWarning } from './ProjectsDirWarning'

const inp =
  'w-full rounded-lg border border-[var(--gt-border)] bg-black/30 px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-[var(--gt-accent)]/60'
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="border-b border-[var(--gt-border)]/60 px-5 py-4">
      <div className="mb-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-400">{title}</div>
      {desc && <div className="mb-3 text-[11px] leading-relaxed text-zinc-600">{desc}</div>}
      {!desc && <div className="mb-3" />}
      {children}
    </div>
  )
}

function Toggle({ on, onToggle, label, hint }: { on: boolean; onToggle: () => void; label: string; hint?: string }) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-lg border border-[var(--gt-border)] bg-black/20 px-3 py-2 text-left hover:border-[var(--gt-accent)]/40"
    >
      <span className="min-w-0">
        <span className="text-[12px] text-zinc-200">{label}</span>
        {hint && <span className="mt-0.5 block text-[10.5px] text-zinc-600">{hint}</span>}
      </span>
      <span
        className={`relative ml-3 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          on ? 'bg-[var(--gt-accent)]' : 'bg-zinc-700'
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </span>
    </button>
  )
}

function Readiness({ ok, name, hint }: { ok: boolean; name: string; hint: string }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      {ok ? (
        <CircleCheck size={14} strokeWidth={2} className="shrink-0 text-[var(--gt-green)]" />
      ) : (
        <CircleSlash size={14} strokeWidth={2} className="shrink-0 text-zinc-600" />
      )}
      <span className="font-mono text-zinc-300">{name}</span>
      <span className="truncate text-zinc-600">{hint}</span>
    </div>
  )
}

// OpenRouter free + cheap-paid preset picker. One click to switch the
// default model without having to remember the full slug. Anthropic models
// don't appear here — those route through claude -p (free via Max) anyway.
function OpenRouterPresets({
  currentModel,
  onPick,
}: {
  currentModel: string
  onPick: (model: string) => void
}) {
  const [presets, setPresets] = useState<{
    free: readonly { id: string; label: string }[]
    cheapPaid: readonly { id: string; label: string; inUsdPerM: number }[]
  } | null>(null)
  useEffect(() => {
    window.gt.openrouter.presets().then(setPresets)
  }, [])
  if (!presets) return null
  const Pill = ({
    id,
    label,
    note,
  }: {
    id: string
    label: string
    note?: string
  }) => {
    const on = currentModel === id
    return (
      <button
        onClick={() => onPick(id)}
        title={id}
        className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${
          on
            ? 'border-[var(--gt-accent)]/60 bg-[var(--gt-accent)]/15 text-zinc-100'
            : 'border-[var(--gt-border)] text-zinc-400 hover:border-[var(--gt-accent)]/40'
        }`}
      >
        {label}
        {note && <span className="ml-0.5 text-[9.5px] text-zinc-600">{note}</span>}
      </button>
    )
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[9.5px] uppercase tracking-wider text-zinc-600">free:</span>
        {presets.free.map((p) => (
          <Pill key={p.id} id={p.id} label={p.label} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[9.5px] uppercase tracking-wider text-zinc-600">cheap:</span>
        {presets.cheapPaid.map((p) => (
          <Pill key={p.id} id={p.id} label={p.label} note={`$${p.inUsdPerM}/M`} />
        ))}
      </div>
    </div>
  )
}

// Tab visibility — let the user hide tabs they never use. Persists to
// localStorage and broadcasts a synthetic event so SessionView re-renders
// without a window reload.
function TabsVisibilityPanel() {
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('gt.tabs.hidden') || '[]')
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  })
  // ALL_TABS is the source of truth for the tab list — import lazily to avoid
  // a circular import (tabs/registry → tabs/* → components/SettingsPanel).
  const [allTabs, setAllTabs] = useState<{ id: string; title: string; order: number }[]>([])
  useEffect(() => {
    import('../tabs/registry').then((m) => {
      setAllTabs(
        [...m.ALL_TABS]
          .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
          .map((t) => ({ id: t.id, title: t.title, order: t.order ?? 99 })),
      )
    })
  }, [])
  const toggle = (id: string) => {
    setHidden((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      localStorage.setItem('gt.tabs.hidden', JSON.stringify(next))
      window.dispatchEvent(new Event('gt.tabs.hidden.changed'))
      return next
    })
  }
  if (allTabs.length === 0)
    return <div className="text-[11px] text-zinc-600">loading…</div>
  return (
    <div className="grid grid-cols-2 gap-1">
      {allTabs.map((t) => {
        const off = hidden.includes(t.id)
        return (
          <button
            key={t.id}
            onClick={() => toggle(t.id)}
            className={`flex items-center justify-between rounded-md border px-2 py-1 text-[11px] ${
              off
                ? 'border-[var(--gt-border)] bg-black/20 text-zinc-500 line-through'
                : 'border-[var(--gt-accent)]/40 bg-[var(--gt-accent)]/10 text-zinc-100'
            }`}
          >
            <span className="truncate">{t.title}</span>
            <span className="text-[9.5px] text-zinc-600">{off ? 'hidden' : 'shown'}</span>
          </button>
        )
      })}
    </div>
  )
}

// Harness self-status: meta-observability snapshot of how TerMinal's own
// infrastructure is doing. Refreshes on mount + every 5s while visible.
function HarnessStatusPanel() {
  const [s, setS] = useState<Awaited<ReturnType<typeof window.gt.harnessStatus>> | null>(null)
  useEffect(() => {
    const load = () => window.gt.harnessStatus().then(setS)
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])
  if (!s)
    return (
      <div className="rounded-md border border-dashed border-[var(--gt-border)] p-3 text-[11px] text-zinc-600">
        loading…
      </div>
    )
  const Cell = ({
    label,
    value,
    tone = 'mute',
  }: {
    label: string
    value: number | string
    tone?: 'mute' | 'green' | 'red' | 'yellow' | 'blue'
  }) => {
    const cls =
      tone === 'green'
        ? 'text-[var(--gt-green)]'
        : tone === 'red'
          ? 'text-[var(--gt-red)]'
          : tone === 'yellow'
            ? 'text-[var(--gt-yellow)]'
            : tone === 'blue'
              ? 'text-[var(--gt-accent-light)]'
              : 'text-zinc-200'
    return (
      <div className="flex flex-col items-start gap-0.5 rounded-md border border-[var(--gt-border)] bg-black/20 px-2.5 py-1.5">
        <span className="text-[9.5px] uppercase tracking-wider text-zinc-500">{label}</span>
        <span className={`tabular-nums text-[15px] font-semibold ${cls}`}>{value}</span>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2 text-zinc-300">
        <Cell label="cron records" value={s.cronRunFiles} />
        <Cell
          label="cron running"
          value={s.cronRunsRunning}
          tone={s.cronRunsRunning > 0 ? 'blue' : 'mute'}
        />
        <Cell
          label="in-proc running"
          value={s.inProcessRunning}
          tone={s.inProcessRunning > 0 ? 'blue' : 'mute'}
        />
        <Cell
          label="failed (24h)"
          value={s.cronFailed24h}
          tone={s.cronFailed24h > 0 ? 'red' : 'green'}
        />
        <Cell
          label="paused schedules"
          value={s.schedulesPaused}
          tone={s.schedulesPaused > 0 ? 'yellow' : 'mute'}
        />
        <Cell label="cron worktrees" value={s.cronWorktrees} />
      </div>
      <div className="text-[10px] text-zinc-600">
        Updated live · stored in <code className="font-mono">{tilde(s.configDir)}</code>
      </div>
    </div>
  )
}

// In-app rebuild panel. Kicks off bin/release as a detached daemon, tails the
// log live in the UI, and prepares the user for the imminent app quit. The
// release script kills the running TerMinal halfway through to replace
// /Applications — that's expected, and the relaunch is the script's job.
function RebuildPanel() {
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Tail the log every second while a rebuild is going. We also keep polling
  // status:running so the indicator clears once bin/release finishes (in
  // practice the app gets quit + relaunched, so this UI is mostly seen for
  // the "build…" phase before the kill lands).
  useEffect(() => {
    if (!running) return
    let alive = true
    const tick = async () => {
      const text = await window.gt.release.tail()
      const st = await window.gt.release.status()
      if (!alive) return
      setLog(text)
      if (!st.running) setRunning(false)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [running])

  const start = async () => {
    setError(null)
    setBusy(true)
    const r = await window.gt.release.start()
    setBusy(false)
    if ('error' in r) {
      setError(r.error)
      return
    }
    setRunning(true)
  }

  return (
    <div className="space-y-2">
      <button
        onClick={start}
        disabled={busy || running}
        className="flex w-full items-center gap-2 rounded-lg border border-[var(--gt-accent)]/40 bg-[var(--gt-accent)]/10 px-3 py-2 text-left text-[12px] text-zinc-100 hover:bg-[var(--gt-accent)]/20 disabled:opacity-50"
      >
        {busy || running ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} strokeWidth={2} />}
        {running ? 'Rebuilding… (app will quit + relaunch automatically)' : 'Rebuild + reinstall now'}
        <span className="ml-auto text-[10.5px] text-zinc-600">bun run release</span>
      </button>
      {error && <div className="text-[11px] text-amber-400">{error}</div>}
      {(running || log) && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--gt-border)] bg-[#0c0c11] p-2 font-mono text-[10.5px] leading-relaxed text-zinc-300">
          {log || '(starting…)'}
        </pre>
      )}
    </div>
  )
}

export function SettingsPanel({ onClose, onRerunSetup }: { onClose: () => void; onRerunSetup: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [env, setEnv] = useState<EnvDetect | null>(null)
  const [tg, setTg] = useState<{ busy?: boolean; ok?: boolean; error?: string } | null>(null)
  const [notify, setNotify] = useState<{ busy?: boolean; ok?: boolean; path?: string; error?: string } | null>(null)
  const [copied, setCopied] = useState(false)
  // Controlled mirror of the projectsDir field so the parent-folder guard
  // (ticket #34) can validate live as the user types. Synced when settings load.
  const [pdInput, setPdInput] = useState('')
  const pdVerdict = useProjectsDirCheck(pdInput)

  useEffect(() => {
    window.gt.settings.get().then(setS)
    window.gt.detectEnv().then(setEnv)
  }, [])

  useEffect(() => {
    if (s) setPdInput(s.projectsDir)
  }, [s?.projectsDir])

  const save = async (patch: SettingsPatch) => setS(await window.gt.settings.patch(patch))
  const appOptions = (detected: string[] | undefined, fallback: string[], current: string) => {
    const list = [...new Set([...(detected?.length ? detected : fallback), ...(current ? [current] : [])])]
    return list.map((a) => (
      <option key={a} value={a} className="bg-[var(--gt-panel)]">
        {a}
      </option>
    ))
  }
  const browse = async (key: 'projectsDir') => {
    const d = await window.gt.pickDir()
    if (d) save({ [key]: d })
  }
  const testTelegram = async () => {
    setTg({ busy: true })
    setTg(await window.gt.telegram.test())
  }
  const [orState, setOrState] = useState<
    { busy?: boolean; ok?: boolean; text?: string; model?: string; error?: string } | null
  >(null)
  const testOpenRouter = async () => {
    setOrState({ busy: true })
    const r = await window.gt.openrouter.test()
    setOrState(r)
  }
  const installNotify = async () => {
    setNotify({ busy: true })
    setNotify(await window.gt.installGtNotify())
  }
  const [mcpState, setMcpState] = useState<{ busy?: boolean; ok?: boolean; installed?: string[]; error?: string } | null>(null)
  const installMcp = async () => {
    setMcpState({ busy: true })
    const r = await window.gt.mcpInstall()
    if ('error' in r) setMcpState({ error: r.error })
    else setMcpState({ ok: true, installed: r.installed })
  }
  const copySetupPrompt = async () => {
    const repo = s?.templateRepo || 'https://github.com/trevormil/project-template'
    const prompt = [
      'I just installed TerMinal (an Electron alt-terminal for AI coding agents).',
      'Help me finish one-time setup on this machine. Check what already exists before changing anything.',
      '',
      '1. CLIs: ensure `claude` (required) is installed + logged in, plus any of `codex`, `gh`, `glab` I plan to use. Walk me through `gh auth login` / `glab auth login` if needed.',
      `2. Global agent skills: clone ${repo} and follow its setup docs to install the project-template workflow skills (code-review, iterate, test-suite, document, pr-creation, stacked-mr, notify) into ~/.claude/skills (and ~/.codex/skills for codex). Verify each resolves.`,
      '3. (Optional) Telegram: help me create a bot with @BotFather and find my numeric chat id, so I can paste the token + id into TerMinal → Settings → Telegram.',
      '',
      'Summarize what you did and what is left for me.',
    ].join('\n')
    await window.gt.clipboardWrite(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  if (!s)
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
        <Loader2 className="animate-spin text-zinc-500" />
      </div>
    )

  const MODEL_OPTIONS: Record<Engine, string[]> = {
    claude: ['', 'haiku', 'sonnet', 'opus'],
    codex: ['', 'gpt-5', 'gpt-5-codex', 'o4-mini'],
    cursor: ['', 'composer-2.5', 'auto', 'sonnet-4.5', 'gpt-5.2'],
  }
  const engineRow = (e: Engine, vendor: string) => {
    const found = env ? env[e].found : true
    const detPath = env ? env[e].path : ''
    const defModel = s.engines[e].defaultModel
    return (
      <div key={e} className="mb-2">
        <div className="mb-1 flex items-center gap-2">
          <Readiness ok={found} name={e} hint={found ? detPath || vendor : `not on PATH — set a path below`} />
        </div>
        <input
          defaultValue={s.engines[e].path}
          onBlur={(ev) => ev.target.value !== s.engines[e].path && save({ engines: { [e]: { path: ev.target.value.trim() } } })}
          placeholder={`${e} (bare name on PATH, or absolute path)`}
          spellCheck={false}
          className={`${inp} font-mono`}
        />
        <div className="mt-1 flex items-center gap-2">
          <label className="text-[10.5px] text-zinc-500">default model</label>
          <select
            value={defModel}
            onChange={(ev) =>
              save({ engines: { [e]: { defaultModel: ev.target.value } } })
            }
            className="rounded-md border border-[var(--gt-border)] bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-200 outline-none"
          >
            {MODEL_OPTIONS[e].map((m) => (
              <option key={m} value={m}>
                {m || '(engine default)'}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-zinc-600">
            applied to every {e} run unless the agent/schedule overrides
          </span>
        </div>
      </div>
    )
  }

  const forgeOpt = (val: ForgePref, label: string, hint: string) => (
    <button
      key={val}
      onClick={() => save({ forge: val })}
      className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
        s.forge === val
          ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
          : 'border-[var(--gt-border)] text-zinc-400 hover:border-[var(--gt-accent)]/50'
      }`}
    >
      <div className="text-[12px] font-semibold">{label}</div>
      <div className="text-[10.5px] text-zinc-500">{hint}</div>
    </button>
  )

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-[580px] flex-col overflow-hidden rounded-2xl border border-[var(--gt-border)] bg-[var(--gt-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gt-border)] px-5 py-3">
          <h2 className="flex-1 text-[13px] font-bold text-zinc-100">Settings</h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200">
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Projects & worktrees */}
          <Section title="Projects & worktrees" desc="Where the entry screen looks for repos, and where agent worktrees are created.">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  value={pdInput}
                  onChange={(e) => setPdInput(e.target.value)}
                  onBlur={(e) => e.target.value !== s.projectsDir && save({ projectsDir: e.target.value.trim() })}
                  placeholder="~ (home) — leave blank to auto-detect"
                  spellCheck={false}
                  className={`${inp} font-mono`}
                />
                <button onClick={() => browse('projectsDir')} className={`${inp} flex w-auto shrink-0 items-center gap-1.5 hover:border-[var(--gt-accent)]/60`}>
                  <FolderOpen size={13} strokeWidth={2} />
                  Browse
                </button>
              </div>
              <ProjectsDirWarning
                verdict={pdVerdict}
                onUseParent={(p) => {
                  setPdInput(p)
                  save({ projectsDir: p })
                }}
              />
              <input
                defaultValue={s.worktreesDir}
                onBlur={(e) => e.target.value !== s.worktreesDir && save({ worktreesDir: e.target.value.trim() })}
                placeholder={`${tilde(s.projectsDir) || '<projects>'}/.worktrees (default)`}
                spellCheck={false}
                className={`${inp} font-mono`}
              />
              <input
                defaultValue={s.templateRepo}
                onBlur={(e) => e.target.value !== s.templateRepo && save({ templateRepo: e.target.value.trim() })}
                placeholder="scaffold template repo (default: trevormil/project-template)"
                spellCheck={false}
                className={`${inp} font-mono`}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => window.gt.openConfigDir()}
                  title="Reveal ~/.config/TerMinal/ in Finder — edit schedules.json, settings.json, or agent-state/ sidecars by hand"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--gt-border)] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-[var(--gt-accent)]/60"
                >
                  Open TerMinal config dir
                </button>
                <span className="text-[10.5px] text-zinc-600">
                  schedules · settings · cron logs · agent state
                </span>
              </div>
            </div>
          </Section>

          {/* Engines */}
          <Section title="Engines" desc="The agent backends. Detected on your PATH; override the binary path if needed.">
            {engineRow('claude', 'Anthropic Claude')}
            {engineRow('codex', 'OpenAI Codex')}
            {engineRow('cursor', 'Cursor')}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-zinc-500">Default:</span>
              {(['claude', 'codex', 'cursor'] as Engine[]).map((e) => (
                <button
                  key={e}
                  onClick={() => save({ defaultEngine: e })}
                  className={`rounded-md border px-2.5 py-1 text-[11px] ${
                    s.defaultEngine === e
                      ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
                      : 'border-[var(--gt-border)] text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </Section>

          <Section
            title="Role routing (⌘K tasks)"
            desc="Who runs each stage of a task: plan → code → review → verify. A review/verify stage that lands on the implementer's engine is skipped at run time (separation of duties)."
          >
            {(
              [
                ['plan', 'plans the work (no code changes)'],
                ['code', 'implements the plan, opens the PR'],
                ['review', 'checks the code (different family than code)'],
                ['verify', 'final adversarial pass'],
              ] as [RoleId, string][]
            ).map(([role, hint]) => (
              <div key={role} className="mb-2 flex items-center gap-2">
                <span className="w-12 text-[11px] font-medium text-zinc-300">{role}</span>
                <select
                  value={s.roles[role].engine}
                  onChange={(ev) =>
                    // model resets with the engine — the old alias may not be
                    // valid for the newly picked engine
                    save({ roles: { [role]: { engine: ev.target.value as Engine, model: '' } } })
                  }
                  className="rounded-md border border-[var(--gt-border)] bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-200 outline-none"
                >
                  {(['claude', 'codex', 'cursor'] as Engine[]).map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
                <select
                  value={s.roles[role].model}
                  onChange={(ev) => save({ roles: { [role]: { model: ev.target.value } } })}
                  className="rounded-md border border-[var(--gt-border)] bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-200 outline-none"
                >
                  {MODEL_OPTIONS[s.roles[role].engine].map((m) => (
                    <option key={m} value={m}>
                      {m || '(engine default)'}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-zinc-600">{hint}</span>
              </div>
            ))}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-zinc-500">Verify stage:</span>
              {(['heavy', 'always', 'never'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => save({ taskFlow: { verify: v } })}
                  title={
                    v === 'heavy'
                      ? 'only when the diff is heavy (high-risk paths or >500 lines)'
                      : v === 'always'
                        ? 'every task'
                        : 'skip the verify stage entirely'
                  }
                  className={`rounded-md border px-2.5 py-1 text-[11px] ${
                    s.taskFlow.verify === v
                      ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
                      : 'border-[var(--gt-border)] text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {v === 'heavy' ? 'heavy only' : v}
                </button>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={s.taskFlow.planGate}
                onChange={(ev) => save({ taskFlow: { planGate: ev.target.checked } })}
              />
              Plan gate — park in HITL after planning; coding starts only when you approve
            </label>
          </Section>

          {/* Forge */}
          <Section title="Code forge" desc="Auto picks gh for GitHub remotes and glab otherwise — per repo.">
            <div className="flex gap-2">
              {forgeOpt('auto', 'Auto', 'detect per repo')}
              {forgeOpt('github', 'GitHub', 'force gh / PRs')}
              {forgeOpt('gitlab', 'GitLab', 'force glab / MRs')}
            </div>
            {env && (
              <div className="mt-3 space-y-1">
                <Readiness ok={env.gh.found && env.gh.authed} name="gh" hint={env.gh.found ? (env.gh.authed ? `authenticated${env.gh.authHost ? ` (${env.gh.authHost})` : ''}` : 'installed — run `gh auth login`') : 'not installed — `brew install gh`'} />
                <Readiness ok={env.glab.found && env.glab.authed} name="glab" hint={env.glab.found ? (env.glab.authed ? `authenticated${env.glab.authHost ? ` (${env.glab.authHost})` : ''}` : 'installed — run `glab auth login`') : 'not installed — `brew install glab`'} />
              </div>
            )}
          </Section>

          {/* External apps */}
          <Section
            title="External apps"
            desc="Which app the Files tab's 'Open in editor' and the Browser tab's 'Open in browser' hand off to. Runs `open -a <app>` (works for any installed macOS app)."
          >
            <div className="flex flex-wrap gap-5">
              <label className="flex items-center gap-2 text-[12px] text-zinc-400">
                Editor
                <select
                  value={s.apps.editor || 'Cursor'}
                  onChange={(e) => save({ apps: { editor: e.target.value } })}
                  className="rounded-md border border-[var(--gt-border)] bg-black/30 px-2 py-1 text-[12px] text-zinc-200 outline-none"
                >
                  {appOptions(env?.apps.editors, ['Cursor', 'Visual Studio Code'], s.apps.editor)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[12px] text-zinc-400">
                Browser
                <select
                  value={s.apps.browser || 'Brave Browser'}
                  onChange={(e) => save({ apps: { browser: e.target.value } })}
                  className="rounded-md border border-[var(--gt-border)] bg-black/30 px-2 py-1 text-[12px] text-zinc-200 outline-none"
                >
                  {appOptions(env?.apps.browsers, ['Brave Browser'], s.apps.browser)}
                </select>
              </label>
            </div>
          </Section>

          {/* Telegram */}
          <Section title="Telegram (notifications + AFK control)" desc="Create a bot with @BotFather, paste its token and your chat id. Leave blank to use the legacy ~/.claude scripts if present.">
            <div className="space-y-2">
              <Toggle on={s.telegram.notify} onToggle={() => save({ telegram: { notify: !s.telegram.notify } })} label="Mirror notifications to Telegram" />
              <Toggle on={s.telegram.control} onToggle={() => save({ telegram: { control: !s.telegram.control } })} label="Remote control (AFK)" hint="Launch/cancel agents by texting the bot" />
              <input
                defaultValue={s.telegram.botToken}
                onBlur={(e) => e.target.value !== s.telegram.botToken && save({ telegram: { botToken: e.target.value.trim() } })}
                placeholder="bot token (123456:ABC-DEF…)"
                spellCheck={false}
                className={`${inp} font-mono`}
              />
              <div className="flex items-center gap-2">
                <input
                  defaultValue={s.telegram.chatId}
                  onBlur={(e) => e.target.value !== s.telegram.chatId && save({ telegram: { chatId: e.target.value.trim() } })}
                  placeholder="chat id (your numeric id)"
                  spellCheck={false}
                  className={`${inp} font-mono`}
                />
                <button onClick={testTelegram} disabled={tg?.busy} className={`${inp} flex w-auto shrink-0 items-center gap-1.5 hover:border-[var(--gt-accent)]/60 disabled:opacity-50`}>
                  {tg?.busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} strokeWidth={2} />}
                  Test
                </button>
              </div>
              {tg && !tg.busy && (
                <div className={`text-[11px] ${tg.ok ? 'text-[var(--gt-green)]' : 'text-amber-400'}`}>
                  {tg.ok ? '✓ Sent — check your chat.' : tg.error}
                </div>
              )}
              {s.telegram.control && (
                <details className="mt-1 rounded-md border border-[var(--gt-border)] bg-black/20 px-2.5 py-1.5">
                  <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">
                    Command reference (send /help in the chat)
                  </summary>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-zinc-500">
                    <span>/repos · /cd &lt;repo&gt;</span>
                    <span>/sessions · /about</span>
                    <span>/runs · /cancel &lt;n&gt;</span>
                    <span>/tail &lt;id|n&gt;</span>
                    <span>/agents [@repo]</span>
                    <span>/run &lt;agent&gt; [opts]</span>
                    <span>/tickets [@repo]</span>
                    <span>/ticket &lt;slug|n&gt;</span>
                    <span>/ticket new &lt;title&gt;</span>
                    <span>/close &lt;slug|n&gt;</span>
                    <span>/schedules</span>
                    <span>/pause · /resume · /runnow</span>
                    <span>/hitl · /resolve · /reopen</span>
                    <span>/mrs [@repo] · /mr &lt;iid&gt;</span>
                    <span>/state &lt;agent&gt;</span>
                    <span>/reset-state &lt;agent&gt;</span>
                    <span>/install &lt;agent&gt;</span>
                    <span>/rebuild</span>
                    <span>/harness · /activity</span>
                  </div>
                  <div className="mt-1.5 text-[10px] text-zinc-600">
                    HITL pings include inline ✅ Resolve / 🪵 Tail run buttons — tap to act without typing.
                  </div>
                </details>
              )}
            </div>
          </Section>

          {/* OpenRouter — one-shot calls for cheap classifiers, health checks, etc. */}
          <Section
            title="OpenRouter (cheap one-shot calls)"
            desc="Not a full coding harness — use claude/codex for that. Used inside scripts for cheap classifiers, health-check escalations, MR-authorship sniffing. Get a key at openrouter.ai/keys."
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  defaultValue={s.openrouter.apiKey}
                  onBlur={(e) =>
                    e.target.value !== s.openrouter.apiKey &&
                    save({ openrouter: { apiKey: e.target.value.trim() } })
                  }
                  placeholder="sk-or-v1-…"
                  spellCheck={false}
                  type="password"
                  className={`${inp} min-w-0 flex-1 font-mono`}
                />
                <button
                  onClick={testOpenRouter}
                  disabled={orState?.busy || !s.openrouter.apiKey}
                  className={`${inp} flex w-auto shrink-0 items-center gap-1.5 hover:border-[var(--gt-accent)]/60 disabled:opacity-50`}
                >
                  {orState?.busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} strokeWidth={2} />}
                  Test
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] text-zinc-500">default model</span>
                <input
                  defaultValue={s.openrouter.defaultModel}
                  onBlur={(e) =>
                    e.target.value !== s.openrouter.defaultModel &&
                    save({ openrouter: { defaultModel: e.target.value.trim() } })
                  }
                  placeholder="anthropic/claude-haiku-4.5"
                  spellCheck={false}
                  className={`${inp} flex-1 font-mono`}
                />
                <span className="text-[10px] text-zinc-600">e.g. openai/gpt-5-mini, google/gemini-2.5-flash</span>
              </div>
              {orState && !orState.busy && (
                <div className={`text-[11px] ${orState.ok ? 'text-[var(--gt-green)]' : 'text-amber-400'}`}>
                  {orState.ok
                    ? `✓ Connected via ${orState.model || 'OpenRouter'} — replied "${(orState.text || '').slice(0, 40)}"`
                    : orState.error}
                </div>
              )}
              {/* Free model presets — one click to switch default. Anthropic
                  models route through claude -p (free via Max); these are
                  for when you want a non-Anthropic cheap-tier model. */}
              <OpenRouterPresets
                currentModel={s.openrouter.defaultModel}
                onPick={(m) => save({ openrouter: { defaultModel: m } })}
              />
            </div>
          </Section>

          {/* Setup / integrations */}
          <Section title="Setup & integrations" desc="One-time helpers for a fresh machine. Agents inherit your global ~/.claude and ~/.codex config + skills.">
            <div className="space-y-2">
              <button onClick={copySetupPrompt} className="flex w-full items-center gap-2 rounded-lg border border-[var(--gt-border)] bg-black/20 px-3 py-2 text-left text-[12px] text-zinc-200 hover:border-[var(--gt-accent)]/40">
                {copied ? <CircleCheck size={14} strokeWidth={2} className="text-[var(--gt-green)]" /> : <ClipboardCopy size={14} strokeWidth={2} className="text-[var(--gt-accent-light)]" />}
                Copy global-skills setup prompt
                <span className="ml-auto text-[10.5px] text-zinc-600">{copied ? 'copied — paste into Claude' : 'paste into Claude'}</span>
              </button>
              <button onClick={installNotify} disabled={notify?.busy} className="flex w-full items-center gap-2 rounded-lg border border-[var(--gt-border)] bg-black/20 px-3 py-2 text-left text-[12px] text-zinc-200 hover:border-[var(--gt-accent)]/40 disabled:opacity-50">
                {notify?.busy ? <Loader2 size={14} className="animate-spin" /> : <TerminalSquare size={14} strokeWidth={2} className="text-[var(--gt-accent-light)]" />}
                Install <span className="font-mono">gt-notify</span> to ~/.local/bin
                <span className="ml-auto text-[10.5px] text-zinc-600">activity feed hook</span>
              </button>
              {notify && !notify.busy && (
                <div className={`text-[11px] ${notify.ok ? 'text-[var(--gt-green)]' : 'text-amber-400'}`}>
                  {notify.ok ? `✓ Installed at ${tilde(notify.path || '')}` : notify.error}
                </div>
              )}
              <button
                onClick={installMcp}
                disabled={mcpState?.busy}
                className="flex w-full items-center gap-2 rounded-lg border border-[var(--gt-border)] bg-black/20 px-3 py-2 text-left text-[12px] text-zinc-200 hover:border-[var(--gt-accent)]/40 disabled:opacity-50"
              >
                {mcpState?.busy ? <Loader2 size={14} className="animate-spin" /> : <TerminalSquare size={14} strokeWidth={2} className="text-[var(--gt-accent-light)]" />}
                Install MCP server (Claude Code + Codex)
                <span className="ml-auto text-[10.5px] text-zinc-600">cross-session views</span>
              </button>
              {mcpState && !mcpState.busy && (
                <div className={`text-[11px] ${mcpState.ok ? 'text-[var(--gt-green)]' : 'text-amber-400'}`}>
                  {mcpState.ok
                    ? `✓ Installed to ${mcpState.installed?.join(', ') || ''}. Restart any open Claude session to pick it up.`
                    : mcpState.error}
                </div>
              )}
              <button onClick={onRerunSetup} className="flex w-full items-center gap-2 rounded-lg border border-[var(--gt-border)] bg-black/20 px-3 py-2 text-left text-[12px] text-zinc-200 hover:border-[var(--gt-accent)]/40">
                <RotateCcw size={14} strokeWidth={2} className="text-[var(--gt-accent-light)]" />
                Re-run first-time setup
              </button>
            </div>
          </Section>

          {/* Tab visibility — hide tabs you never use. */}
          <Section
            title="Tabs"
            desc="Hide tabs you don't use. They stay registered (so cross-tab nav still works); they just don't render in the tab bar."
          >
            <TabsVisibilityPanel />
          </Section>

          {/* Harness self-status — meta-observability snapshot. */}
          <Section
            title="Harness status"
            desc="How TerMinal's own infrastructure is doing right now. Refreshes every 5s."
          >
            <HarnessStatusPanel />
          </Section>

          {/* In-app rebuild — eats own dog food. Spawns bin/release fully
              detached so it survives the pkill mid-flow + lands a fresh app
              in /Applications + relaunches. */}
          <Section
            title="Rebuild + reinstall"
            desc="Run bin/release from inside the app — builds, signs, replaces the installed app, relaunches. Source checkout must be on this machine."
          >
            <RebuildPanel />
          </Section>

          <div className="px-5 py-3 text-center text-[10.5px] text-zinc-600">
            TerMinal · settings stored in ~/.config/TerMinal/settings.json
          </div>
        </div>
      </div>
    </div>
  )
}

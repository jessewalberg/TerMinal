import { useEffect, useState, type ReactNode } from 'react'
import {
  X,
  ChevronLeft,
  Ban,
  ShieldCheck,
  Gauge,
  Compass,
  Sparkles,
  Palette,
  FlaskConical,
  Accessibility,
  Server,
  UserRound,
  Zap,
  Eye,
  Repeat2,
  Layers,
  type LucideIcon,
} from 'lucide-react'
import type { Engine, EnginePick, Persona, PipelineInfo, EnvDetect, Settings } from '../lib/types'
import { EngineModelPicker } from './EngineModelPicker'
import { SkillHint } from './SkillHint'
import openaiLogo from '../assets/openai.svg'
import claudeLogo from '../assets/claude.svg'
import cursorLogo from '../assets/cursor.svg'

// Three-step launch picker: engine (codex/claude/cursor) → persona (none +
// built-ins) → pipeline (single run, or chained review/iterate stages). onPick
// fires with engine + persona id ('' = none) + pipeline id ('single' = task).
const ENGINES: Engine[] = ['claude', 'codex', 'cursor']
const LOGO: Record<Engine, string> = { codex: openaiLogo, claude: claudeLogo, cursor: cursorLogo }
const VENDOR: Record<Engine, string> = {
  codex: 'OpenAI Codex',
  claude: 'Anthropic Claude',
  cursor: 'Cursor',
}
const PERSONA_ICON: Record<string, LucideIcon> = {
  ShieldCheck,
  Gauge,
  Compass,
  Sparkles,
  Palette,
  FlaskConical,
  Accessibility,
  Server,
}
const PIPELINE_ICON: Record<string, LucideIcon> = {
  single: Zap,
  review: Eye,
  'review-iterate': Repeat2,
}

export function EnginePicker({
  title,
  hint,
  onPick,
  onClose,
}: {
  title: string
  hint?: ReactNode
  onPick: (engine: EnginePick, persona: string, pipeline: string, model?: string) => void
  onClose: () => void
}) {
  const [engine, setEngine] = useState<EnginePick | null>(null)
  const [model, setModel] = useState<string | undefined>(undefined)
  const [persona, setPersona] = useState<string | null>(null) // null = not chosen, '' = none
  const [personas, setPersonas] = useState<Persona[]>([])
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([])
  const [env, setEnv] = useState<EnvDetect | null>(null)
  const [defaultEngine, setDefaultEngine] = useState<Engine>('claude')
  const [roles, setRoles] = useState<Settings['roles'] | null>(null)
  useEffect(() => {
    window.gt.agents.personas().then(setPersonas)
    window.gt.agents.pipelines().then(setPipelines)
    window.gt.detectEnv().then(setEnv)
    window.gt.settings.get().then((s) => {
      setDefaultEngine(s.defaultEngine)
      setRoles(s.roles)
    })
  }, [])

  // Until detection resolves, assume available (avoids a flicker); once known,
  // disable engines that aren't installed and auto-pick when only one exists.
  const avail = (e: Engine) => !env || !!env[e]?.found
  useEffect(() => {
    if (!env || engine !== null) return
    const ok = ENGINES.filter(avail)
    if (ok.length === 1) setEngine(ok[0])
  }, [env]) // eslint-disable-line react-hooks/exhaustive-deps
  // Default engine first, then the rest in their canonical order.
  const engineOrder: Engine[] = [defaultEngine, ...ENGINES.filter((e) => e !== defaultEngine)]

  const step = engine === null ? 1 : persona === null ? 2 : 3
  const back = () => (step === 3 ? setPersona(null) : setEngine(null))

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[420px] gt-pop-in rounded-2xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          {step > 1 && (
            <button
              onClick={back}
              className="flex items-center rounded p-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
            >
              <ChevronLeft size={15} strokeWidth={2} />
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-bold text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            className="flex shrink-0 items-center rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        {hint && (
          <div className="mb-3">
            <SkillHint>{hint}</SkillHint>
          </div>
        )}

        {step === 1 && (
          <>
            <p className="mb-3 text-[11.5px] text-zinc-500">1 · Launch with which engine?</p>
            <button
              onClick={() => roles && avail(roles.code.engine) && setEngine('auto')}
              disabled={!roles || !avail(roles.code.engine)}
              title={
                roles && !avail(roles.code.engine)
                  ? `role policy needs ${roles.code.engine}, which is not installed`
                  : 'Role routing decides: the work runs on the code-role engine; review stages route separately (reviewer ≠ implementer)'
              }
              className={`mb-2 flex w-full items-center gap-2.5 rounded-xl border bg-black/20 p-3 text-left transition-colors ${
                roles && avail(roles.code.engine)
                  ? 'border-[var(--gt-accent)]/40 hover:border-[var(--gt-accent)] hover:bg-white/5'
                  : 'cursor-not-allowed border-[var(--gt-border)]/50 opacity-40'
              }`}
            >
              <Zap size={17} strokeWidth={1.75} className="shrink-0 text-[var(--gt-accent-light)]" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-zinc-100">Auto · role routing</div>
                <div className="text-[11px] text-zinc-500">
                  {roles
                    ? `${roles.code.engine} does the work · ${roles.review.engine} reviews`
                    : 'loading role policy…'}
                </div>
              </div>
            </button>
            <div className="grid grid-cols-3 gap-2">
              {engineOrder.map((e) => {
                const ok = avail(e)
                return (
                  <button
                    key={e}
                    onClick={() => ok && setEngine(e)}
                    disabled={!ok}
                    title={ok ? '' : `${e} is not installed or not on PATH`}
                    className={`flex flex-col items-center gap-2 rounded-xl border bg-black/20 px-3 py-4 transition-colors ${
                      ok
                        ? 'border-[var(--gt-border)] hover:border-[var(--gt-accent)]/60 hover:bg-white/5'
                        : 'cursor-not-allowed border-[var(--gt-border)]/50 opacity-40'
                    }`}
                  >
                    <img src={LOGO[e]} alt="" className="h-7 w-7" draggable={false} />
                    <span className="text-[13px] font-semibold text-zinc-100">{e}</span>
                    <span className="text-[10px] text-zinc-500">{ok ? VENDOR[e] : 'not installed'}</span>
                  </button>
                )
              })}
            </div>
            {env && !env.codex.found && !env.claude.found && !env.cursor.found && (
              <p className="mt-3 text-[11px] text-[var(--gt-red)]">
                No engine (codex, claude, cursor) found on PATH. Install one, or set its path in
                Settings.
              </p>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="mb-3 flex items-center gap-2">
              <p className="text-[11.5px] text-zinc-500">
                2 · Run as a persona?{' '}
                <span className="text-zinc-600">(via {engine === 'auto' ? 'role routing' : engine})</span>
              </p>
              {engine !== 'auto' && (
                <div className="ml-auto">
                  <EngineModelPicker
                    engine={engine as Engine}
                    model={model}
                    onChange={(e, m) => {
                      setEngine(e)
                      setModel(m)
                    }}
                    size="sm"
                    align="right"
                  />
                </div>
              )}
            </div>
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto">
              <button
                onClick={() => setPersona('')}
                className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--gt-border)] bg-black/20 p-3 text-left transition-colors hover:border-[var(--gt-accent)]/60 hover:bg-white/5"
              >
                <Ban size={17} strokeWidth={1.75} className="shrink-0 text-zinc-500" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-zinc-100">None</div>
                  <div className="text-[11px] text-zinc-500">Default — just the task.</div>
                </div>
              </button>
              {personas.map((p) => {
                const Icon = PERSONA_ICON[p.icon || ''] || UserRound
                return (
                  <button
                    key={p.id}
                    onClick={() => setPersona(p.id)}
                    className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--gt-border)] bg-black/20 p-3 text-left transition-colors hover:border-[var(--gt-accent)]/60 hover:bg-white/5"
                  >
                    <Icon size={17} strokeWidth={1.75} className="shrink-0 text-[var(--gt-accent-light)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-zinc-100">{p.title}</div>
                      <div className="text-[11px] leading-snug text-zinc-500">{p.description}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p className="mb-3 text-[11.5px] text-zinc-500">
              3 · Pipeline?{' '}
              <span className="text-zinc-600">
                ({engine}
                {persona ? ` · ${personas.find((p) => p.id === persona)?.title || persona}` : ''})
              </span>
            </p>
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto">
              {pipelines.map((pl) => {
                const Icon = PIPELINE_ICON[pl.id] || Layers
                return (
                  <button
                    key={pl.id}
                    onClick={() => onPick(engine as EnginePick, persona ?? '', pl.id, engine === 'auto' ? undefined : model)}
                    className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--gt-border)] bg-black/20 p-3 text-left transition-colors hover:border-[var(--gt-accent)]/60 hover:bg-white/5"
                  >
                    <Icon size={17} strokeWidth={1.75} className="shrink-0 text-[var(--gt-accent-light)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-zinc-100">{pl.title}</div>
                      <div className="text-[11px] leading-snug text-zinc-500">{pl.description}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

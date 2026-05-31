import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Engine } from '../lib/types'
import { EngineLogo } from './EngineLogo'

// One DRY surface for the "pick engine + model" UX everywhere a run is
// configured (Agents tab, Schedules form, designer modals, ticket spawn).
// A click pops a small panel with both engines + their model chips so the
// operator can pick "claude · haiku" in one go instead of cascading through
// two separate selects.

const MODELS: Record<Engine, { id: string; label: string }[]> = {
  claude: [
    { id: 'haiku', label: 'haiku' },
    { id: 'sonnet', label: 'sonnet' },
    { id: 'opus', label: 'opus' },
  ],
  codex: [
    { id: 'gpt-5-codex', label: 'gpt-5-codex' },
    { id: 'gpt-5', label: 'gpt-5' },
    { id: 'o4-mini', label: 'o4-mini' },
  ],
  cursor: [
    { id: 'composer-2.5', label: 'composer-2.5' },
    { id: 'auto', label: 'auto' },
    { id: 'sonnet-4.5', label: 'sonnet-4.5' },
    { id: 'gpt-5.2', label: 'gpt-5.2' },
  ],
}

const VENDOR: Record<Engine, string> = {
  claude: 'Anthropic Claude',
  codex: 'OpenAI Codex',
  cursor: 'Cursor',
}

export function EngineModelPicker({
  engine,
  model,
  onChange,
  size = 'md',
  align = 'left',
}: {
  engine: Engine
  model: string | undefined
  onChange: (engine: Engine, model: string | undefined) => void
  size?: 'sm' | 'md'
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const trigger =
    size === 'sm'
      ? 'gap-1.5 rounded-md px-1.5 py-1 text-[11px]'
      : 'gap-2 rounded-lg px-2.5 py-1.5 text-[12px]'

  const modelLabel = model || 'default'

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center border border-[var(--gt-border)] bg-black/30 text-zinc-200 hover:border-[var(--gt-accent)]/60 ${trigger}`}
        title="Pick the engine + model — model defaults to the engine's default when not set."
      >
        <EngineLogo engine={engine} size={size === 'sm' ? 11 : 13} />
        <span>{engine}</span>
        <span className="text-zinc-600">·</span>
        <span className={model ? 'text-zinc-200' : 'text-zinc-500'}>{modelLabel}</span>
        <ChevronDown size={size === 'sm' ? 10 : 12} strokeWidth={2} className="text-zinc-500" />
      </button>

      {open && (
        <div
          className={`absolute top-full z-50 mt-1 w-[280px] rounded-xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-2.5 shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {(Object.keys(MODELS) as Engine[]).map((e) => {
            const isActive = e === engine
            return (
              <div key={e} className="mb-2 last:mb-0">
                <div className="mb-1 flex items-center gap-1.5 px-1">
                  <EngineLogo engine={e} size={12} />
                  <span className="text-[11px] font-semibold text-zinc-200">{e}</span>
                  <span className="text-[10px] text-zinc-600">· {VENDOR[e]}</span>
                </div>
                <div className="flex flex-wrap gap-1 px-1">
                  <button
                    onClick={() => {
                      onChange(e, undefined)
                      setOpen(false)
                    }}
                    className={`rounded-md border px-2 py-0.5 text-[10.5px] ${
                      isActive && !model
                        ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/20 text-zinc-100'
                        : 'border-[var(--gt-border)] text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                  >
                    default
                  </button>
                  {MODELS[e].map((m) => {
                    const selected = isActive && model === m.id
                    return (
                      <button
                        key={m.id}
                        onClick={() => {
                          onChange(e, m.id)
                          setOpen(false)
                        }}
                        className={`rounded-md border px-2 py-0.5 text-[10.5px] ${
                          selected
                            ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/20 text-zinc-100'
                            : 'border-[var(--gt-border)] text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                        }`}
                      >
                        {m.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div className="mt-1 border-t border-[var(--gt-border)]/60 px-1 pt-1.5 text-[9.5px] text-zinc-600">
            Cheap models (haiku, gpt-5) for lightweight schedules; opus / gpt-5-codex for real work.
          </div>
        </div>
      )}
    </div>
  )
}

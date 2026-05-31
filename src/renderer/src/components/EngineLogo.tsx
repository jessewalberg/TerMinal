import type { Engine } from '../lib/types'
import openaiLogo from '../assets/openai.svg'
import claudeLogo from '../assets/claude.svg'
import cursorLogo from '../assets/cursor.svg'

const LOGO: Record<Engine, string> = {
  codex: openaiLogo,
  claude: claudeLogo,
  cursor: cursorLogo,
}

// Single source for the engine wordmark — anywhere we say "claude" or "codex"
// in the UI, render this alongside so the engine is identifiable at a glance.
// Defaults are sized for inline use next to small labels (badges, list rows).
export function EngineLogo({
  engine,
  size = 11,
  className = '',
}: {
  engine: Engine | string
  size?: number
  className?: string
}) {
  const src = LOGO[engine as Engine]
  if (!src) return null
  return (
    <img
      src={src}
      alt={engine}
      width={size}
      height={size}
      draggable={false}
      className={`inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
    />
  )
}

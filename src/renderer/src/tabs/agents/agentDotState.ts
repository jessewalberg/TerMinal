import type { AgentRunStatus } from '../../lib/types'

export type DotInput = {
  /** A run for this agent is currently in progress (in the active repo). */
  busy: boolean
  /** The agent's most recent terminal run, with a pre-formatted relative time. */
  last: { status: AgentRunStatus | string; relLabel: string } | null
}

export type DotState = { className: string; title: string }

/**
 * Color + tooltip for the left-rail status dot.
 *
 * Running is the ONLY pulsing green, so a *finished* agent is never mistaken
 * for an active one — `done` is blue ("completed"), not the running green that
 * differed only by an easy-to-miss pulse. `interrupted`/`canceled` mirror the
 * `statusTone` badge colors (yellow / muted) so the rail and the run-list badge
 * agree. Pure + unit-tested (agentDotState.test.ts) so the matrix can't regress.
 */
export function agentDotState({ busy, last }: DotInput): DotState {
  if (busy) return { className: 'bg-[var(--gt-green)] gt-pulse', title: 'run in progress' }
  if (!last) return { className: '', title: '' }
  const title = `last run: ${last.status} · ${last.relLabel}`
  switch (last.status) {
    case 'done':
      return { className: 'bg-[var(--gt-blue)]', title }
    case 'failed':
      return { className: 'bg-[var(--gt-red)]', title }
    case 'interrupted':
      return { className: 'bg-[var(--gt-yellow)]', title }
    default: // canceled + any other terminal state
      return { className: 'bg-zinc-500', title }
  }
}

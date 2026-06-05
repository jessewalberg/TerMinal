import type { UnifiedRun } from './cron-runs'
import type { AgentRun, Engine } from './agents'

// Re-dispatch decision for the Runs-tab "Re-run" button. Kept as a pure,
// dependency-injected function so it is unit-testable without spawning real
// processes — the IPC handler in index.ts supplies the live implementations.
//
// Why this exists: the old renderer path re-ran agent runs against the CURRENT
// session's repo (via agents:run → runAgent(repoRootOf(cur().cwd), …)), so
// re-running a run that belonged to any other repo silently returned
// { error: 'unknown agent' } and the UI did nothing. This routes every re-run
// through the run's OWN repoRoot and returns a result the renderer can surface.

export type RerunResult = { ok: true; runId?: string } | { error: string }

export type RerunDeps = {
  /** True when the schedule still exists in schedules.json. */
  scheduleExists: (id: string) => boolean
  /** Re-fire a launchd-backed schedule out of band (preserves its env + log). */
  runSchedule: (id: string) => void
  /** Re-spawn a backlog-ticket implementation run. */
  runTicket: (
    repoRoot: string,
    ticketId: number,
    engine?: Engine,
    persona?: string,
    pipeline?: string,
  ) => AgentRun | { error: string }
  /** Spawn an in-process agent run in the given repo. */
  runAgent: (repoRoot: string, agentId: string, engine?: Engine) => AgentRun | { error: string }
}

const ENGINES: Engine[] = ['codex', 'claude', 'cursor']
const asEngine = (e: string | undefined): Engine | undefined =>
  ENGINES.includes(e as Engine) ? (e as Engine) : undefined
const ticketIdFromAgentId = (agentId: string): number | null => {
  const m = agentId.match(/^ticket-(\d+)$/)
  if (!m) return null
  const id = Number(m[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function rerunRun(run: UnifiedRun, deps: RerunDeps): RerunResult {
  if (run.source === 'workflow') {
    return { error: 'terminal-started workflow runs must be re-run from the terminal' }
  }
  // Cron runs whose schedule still exists re-fire through launchd so the run
  // gets the same env vars + log path the schedule was configured with.
  if (run.source === 'cron' && run.scheduleId && deps.scheduleExists(run.scheduleId)) {
    deps.runSchedule(run.scheduleId)
    return { ok: true }
  }
  // Everything else (in-process agent runs, or cron runs whose schedule was
  // deleted) re-dispatches in-process against the run's OWN repo — not the
  // active session's — so it works regardless of which repo is focused.
  if (!run.repoRoot) return { error: 'run has no repoRoot — cannot re-dispatch' }
  if (!run.agentId) return { error: 'run has no agentId — cannot re-dispatch' }
  const ticketId = ticketIdFromAgentId(run.agentId)
  if (ticketId) {
    const r = deps.runTicket(run.repoRoot, ticketId, asEngine(run.engine), run.persona, run.pipeline)
    return 'error' in r ? r : { ok: true, runId: r.id }
  }
  const r = deps.runAgent(run.repoRoot, run.agentId, asEngine(run.engine))
  return 'error' in r ? r : { ok: true, runId: r.id }
}

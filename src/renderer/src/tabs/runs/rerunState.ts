import type { UnifiedRun } from '../../lib/types'

export type RerunResult = { ok: true; runId?: string } | { error: string }

export function rerunSuccessMessage(result: RerunResult): string {
  return 'ok' in result && result.runId ? 'Re-run started' : 'Re-run requested'
}

export function findRerunTarget(
  original: UnifiedRun,
  result: RerunResult,
  runs: UnifiedRun[],
  requestedAt: number,
): string | null {
  if ('error' in result) return null
  if (result.runId) return result.runId

  return (
    runs
      .filter((run) => isLikelyDetachedRerun(original, run, requestedAt))
      .sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null
  )
}

function isLikelyDetachedRerun(original: UnifiedRun, candidate: UnifiedRun, requestedAt: number): boolean {
  if (candidate.id === original.id) return false
  if (candidate.startedAt < requestedAt) return false
  if (candidate.source !== original.source) return false
  if (candidate.agentId !== original.agentId) return false
  if (candidate.repoRoot !== original.repoRoot) return false
  if (original.source === 'cron') return !!original.scheduleId && candidate.scheduleId === original.scheduleId
  return true
}

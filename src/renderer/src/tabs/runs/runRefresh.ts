import type { UnifiedRun } from '../../lib/types'

export function shouldRefreshRunsFallback(
  runs: UnifiedRun[] | null,
  tick: number,
  fullRefreshEveryTicks: number,
): boolean {
  if (runs?.some((r) => r.status === 'running')) return true
  return fullRefreshEveryTicks > 0 && tick > 0 && tick % fullRefreshEveryTicks === 0
}

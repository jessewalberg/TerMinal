import type { UnifiedRun } from './cron-runs'

export const RUNS_CHANGED_CHANNEL = 'runs:changed'

type RunsChangedSender = (channel: string, payload: UnifiedRun[]) => void

export function shouldPublishRunsChanged(channel: string): boolean {
  return channel === 'agent:status'
}

export function publishRunsChanged(send: RunsChangedSender, listRuns: () => UnifiedRun[]): void {
  send(RUNS_CHANGED_CHANNEL, listRuns())
}

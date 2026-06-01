import { describe, expect, test } from 'bun:test'
import { publishRunsChanged, RUNS_CHANGED_CHANNEL, shouldPublishRunsChanged } from './run-change-events'
import type { UnifiedRun } from './cron-runs'

describe('run change event bridge', () => {
  test('publishes unified run changes for agent status updates only', () => {
    expect(shouldPublishRunsChanged('agent:status')).toBe(true)
    expect(shouldPublishRunsChanged('agent:output')).toBe(false)
    expect(shouldPublishRunsChanged('activity:event')).toBe(false)
  })

  test('sends the current unified run list as the source of truth', () => {
    const runs = [
      {
        id: 'run-1',
        source: 'agent',
        agentId: 'check',
        agentTitle: 'Check',
        engine: 'codex',
        status: 'done',
        startedAt: 1,
        repoRoot: '/repo',
        repoLabel: 'repo',
        branch: 'agent/check',
        worktree: '/worktree',
      },
    ] satisfies UnifiedRun[]
    const sent: { channel: string; payload: UnifiedRun[] }[] = []

    publishRunsChanged((channel, payload) => sent.push({ channel, payload }), () => runs)

    expect(sent).toEqual([{ channel: RUNS_CHANGED_CHANNEL, payload: runs }])
  })
})

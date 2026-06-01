import { describe, expect, test } from 'bun:test'
import { shouldRefreshRunsFallback } from './runRefresh'
import type { UnifiedRun } from '../../lib/types'

const run = (status: string): UnifiedRun => ({
  id: `run-${status}`,
  source: 'agent',
  agentId: 'check',
  agentTitle: 'Check',
  engine: 'codex',
  status,
  startedAt: 1,
  repoRoot: '/repo',
  repoLabel: 'repo',
  branch: 'agent/check',
  worktree: '/worktree',
})

describe('runs fallback refresh policy', () => {
  test('refreshes immediately when any known run is still running', () => {
    expect(shouldRefreshRunsFallback([run('done'), run('running')], 1, 6)).toBe(true)
  })

  test('does a low-frequency full refresh when no run is known to be running', () => {
    expect(shouldRefreshRunsFallback([run('done')], 1, 6)).toBe(false)
    expect(shouldRefreshRunsFallback([run('done')], 6, 6)).toBe(true)
  })

  test('does not refresh before initial data has loaded except on the full-refresh tick', () => {
    expect(shouldRefreshRunsFallback(null, 1, 6)).toBe(false)
    expect(shouldRefreshRunsFallback(null, 6, 6)).toBe(true)
  })
})

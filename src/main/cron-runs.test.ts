import { describe, expect, mock, test } from 'bun:test'
import type { CronRun } from './cron-runs'

mock.module('electron', () => ({
  Notification: class {
    static isSupported() {
      return false
    }
    show() {}
  },
}))

const { cronRunToUnified } = await import('./cron-runs')

describe('cron/workflow run normalization', () => {
  test('preserves terminal-started workflow runs as workflow source rows', () => {
    const run: CronRun = {
      id: 'workflow-1',
      source: 'workflow',
      scheduleId: 'workflow:stacked-mr',
      agentId: 'stacked-mr',
      agentTitle: 'Stacked MR',
      engine: 'codex',
      status: 'running',
      startedAt: 123,
      branch: '0018-keyboard-nav',
      repoLabel: 'TerMinal',
      repoRoot: '/repos/TerMinal',
      worktree: '/repos/TerMinal',
    }

    expect(cronRunToUnified(run)).toMatchObject({
      id: 'workflow-1',
      source: 'workflow',
      agentId: 'stacked-mr',
      agentTitle: 'Stacked MR',
      repoRoot: '/repos/TerMinal',
      repoLabel: 'TerMinal',
    })
  })
})

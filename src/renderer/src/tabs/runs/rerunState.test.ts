import { describe, expect, test } from 'bun:test'
import { findRerunTarget, rerunSuccessMessage } from './rerunState'
import type { UnifiedRun } from '../../lib/types'

function run(over: Partial<UnifiedRun> = {}): UnifiedRun {
  return {
    id: 'old-run',
    source: 'agent',
    agentId: 'health',
    agentTitle: 'Health',
    engine: 'codex',
    status: 'done',
    startedAt: 1_000,
    repoRoot: '/repos/alpha',
    repoLabel: 'alpha',
    branch: 'main',
    worktree: '/repos/alpha',
    ...over,
  }
}

describe('Runs tab rerun state', () => {
  test('selects the run id returned by the rerun IPC result', () => {
    const original = run()
    const runs = [run({ id: 'new-run', status: 'running', startedAt: 2_000 }), original]

    expect(findRerunTarget(original, { ok: true, runId: 'new-run' }, runs, 1_500)).toBe('new-run')
  })

  test('selects a newly written cron run when launchd rerun has no immediate run id', () => {
    const original = run({ source: 'cron', scheduleId: 'schedule-1' })
    const older = run({ id: 'older-run', source: 'cron', scheduleId: 'schedule-1', startedAt: 1_200 })
    const newer = run({ id: 'new-run', source: 'cron', scheduleId: 'schedule-1', startedAt: 2_100 })

    expect(findRerunTarget(original, { ok: true }, [older, newer, original], 2_000)).toBe('new-run')
  })

  test('does not jump to unrelated runs while waiting for a detached cron rerun', () => {
    const original = run({ source: 'cron', scheduleId: 'schedule-1' })
    const otherSchedule = run({
      id: 'other-run',
      source: 'cron',
      scheduleId: 'schedule-2',
      startedAt: 2_100,
    })
    const sameScheduleBeforeClick = run({
      id: 'before-click',
      source: 'cron',
      scheduleId: 'schedule-1',
      startedAt: 1_900,
    })

    expect(findRerunTarget(original, { ok: true }, [otherSchedule, sameScheduleBeforeClick], 2_000)).toBeNull()
  })

  test('uses visible success copy for both immediate and detached reruns', () => {
    expect(rerunSuccessMessage({ ok: true, runId: 'new-run' })).toBe('Re-run started')
    expect(rerunSuccessMessage({ ok: true })).toBe('Re-run requested')
  })
})

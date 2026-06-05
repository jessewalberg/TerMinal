import { describe, expect, test } from 'bun:test'
import { makeAIRun } from './ai-runs'

describe('makeAIRun — startedAt / durationMs invariants', () => {
  // Regression: terminal-cron passed a numeric epoch ms through Date.parse(),
  // which coerces the number to a string and returns NaN. startedAt must be
  // stored as a plain finite epoch-ms number, and endedAt - startedAt must be
  // a non-negative finite duration.

  const baseOpts = {
    source: 'claude-p' as const,
    model: 'claude-sonnet-4-5',
    inputTokens: 1000,
    outputTokens: 200,
    repoRoot: '/tmp/repo',
  }

  test('startedAt is preserved as a finite epoch-ms number', () => {
    const ts = 1_748_822_400_000 // a representative epoch ms
    const run = makeAIRun({ ...baseOpts, startedAt: ts })
    expect(Number.isFinite(run.startedAt)).toBe(true)
    expect(run.startedAt).toBe(ts)
  })

  test('Date.parse on a numeric epoch produces NaN (documents the bug)', () => {
    const ts = 1_748_822_400_000
    // This is exactly what the broken code did: Date.parse(ts) where ts is a number.
    // JavaScript coerces ts to the string "1748822400000" and Date.parse returns NaN.
    expect(Number.isNaN(Date.parse(ts as unknown as string))).toBe(true)
  })

  test('endedAt - startedAt is a non-negative finite durationMs', () => {
    const startedAt = 1_748_822_400_000
    const endedAt = startedAt + 45_000 // 45 seconds later
    const run = makeAIRun({ ...baseOpts, startedAt, endedAt })
    const durationMs = (run.endedAt ?? 0) - run.startedAt
    expect(Number.isFinite(durationMs)).toBe(true)
    expect(durationMs).toBeGreaterThanOrEqual(0)
    expect(durationMs).toBe(45_000)
  })

  test('durationMs would be NaN if startedAt were Date.parse(numericEpoch)', () => {
    const ts = 1_748_822_400_000
    const endedAt = ts + 45_000
    const corruptedStartedAt = Date.parse(ts as unknown as string) // NaN
    const durationMs = endedAt - corruptedStartedAt
    expect(Number.isNaN(durationMs)).toBe(true)
  })
})

describe('cursor-agent source — ledger acceptance + subscription ($0) cost', () => {
  // cursor-agent is a subscription CLI like claude-code/codex-cli: TerMinal
  // tracks its tokens but prices it at $0 because its model (Composer) is not in
  // ai-pricing's table → lookupPrice returns the zero-cost row. These lock the
  // source union and the non-billable cost behavior so cursor work stops being
  // silently absent from the ledger.

  test('makeAIRun accepts source: "cursor-agent" and preserves the token shape', () => {
    const startedAt = 1_748_822_400_000
    const run = makeAIRun({
      source: 'cursor-agent',
      model: 'Composer 2.5',
      inputTokens: 21236,
      outputTokens: 38,
      cacheReadTokens: 5390,
      cacheWriteTokens: 0,
      repoRoot: '/tmp/repo',
      startedAt,
      endedAt: startedAt + 4343,
    })
    expect(run.source).toBe('cursor-agent')
    expect(run.inputTokens).toBe(21236)
    expect(run.outputTokens).toBe(38)
    expect(run.cacheReadTokens).toBe(5390)
  })

  test('a Composer cursor run costs $0 (subscription / non-billable) while tokens are tracked', () => {
    const run = makeAIRun({
      source: 'cursor-agent',
      model: 'Composer 2.5',
      inputTokens: 100_000,
      outputTokens: 5_000,
      repoRoot: '/tmp/repo',
      startedAt: 1_748_822_400_000,
    })
    expect(run.costUsd).toBe(0)
    expect(run.inputTokens + run.outputTokens).toBeGreaterThan(0)
  })
})

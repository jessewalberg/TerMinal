import { test, expect, describe } from 'bun:test'
import { planWatchdogTimers, DEFAULT_SOFT_RUN_MS } from './run-watchdog'

// Per ticket #15: a per-run wall-clock *soft* warn-then-reap. Warn-only by
// default (hard cap off); a hard SIGTERM only fires if the operator explicitly
// sets one. 0 = disabled for either cap. This module is the pure policy; the
// setTimeout/kill wiring lives in runSpec + bin/terminal-cron.
describe('planWatchdogTimers', () => {
  test('default config (soft 3h, hard off) → warn only', () => {
    expect(planWatchdogTimers(DEFAULT_SOFT_RUN_MS, 0)).toEqual([
      { atMs: DEFAULT_SOFT_RUN_MS, action: 'warn' },
    ])
  })

  test('both caps set → warn then kill, sorted by time', () => {
    expect(planWatchdogTimers(1000, 2000)).toEqual([
      { atMs: 1000, action: 'warn' },
      { atMs: 2000, action: 'kill' },
    ])
  })

  test('hard earlier than soft is clamped up to soft (never reap before warning)', () => {
    expect(planWatchdogTimers(2000, 1000)).toEqual([
      { atMs: 2000, action: 'warn' },
      { atMs: 2000, action: 'kill' },
    ])
  })

  test('hard only (soft disabled) → reap with no warn', () => {
    expect(planWatchdogTimers(0, 5000)).toEqual([{ atMs: 5000, action: 'kill' }])
  })

  test('both disabled → no timers (the off switch)', () => {
    expect(planWatchdogTimers(0, 0)).toEqual([])
  })

  test('negative / NaN / non-finite caps are treated as disabled', () => {
    expect(planWatchdogTimers(-1, -5)).toEqual([])
    expect(planWatchdogTimers(NaN, Infinity)).toEqual([])
    expect(planWatchdogTimers(Infinity, 0)).toEqual([])
  })
})

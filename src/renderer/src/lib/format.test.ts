import { test, expect, describe } from 'bun:test'
import { fmtAgo } from './format'

describe('fmtAgo', () => {
  const now = 1_780_000_000_000

  test('sub-10s reads as "just now"', () => {
    expect(fmtAgo(now, now)).toBe('just now')
    expect(fmtAgo(now - 5_000, now)).toBe('just now')
  })

  test('seconds / minutes / hours / days', () => {
    expect(fmtAgo(now - 30_000, now)).toBe('30s ago')
    expect(fmtAgo(now - 5 * 60_000, now)).toBe('5m ago')
    expect(fmtAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(fmtAgo(now - 2 * 86_400_000, now)).toBe('2d ago')
  })

  test('missing / future timestamps degrade gracefully', () => {
    expect(fmtAgo(0, now)).toBe('never')
    expect(fmtAgo(now + 5_000, now)).toBe('just now')
  })
})

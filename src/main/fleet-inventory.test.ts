import { describe, expect, test } from 'bun:test'
import { classifyRepoBucket, assembleInventory } from './fleet-inventory'

const DAY = 86_400_000
const now = 1000 * DAY // fixed reference point

describe('classifyRepoBucket', () => {
  test('active when last activity is within 7 days', () => {
    expect(classifyRepoBucket(now - 3 * DAY, now)).toBe('active')
    expect(classifyRepoBucket(now - 7 * DAY, now)).toBe('active')
  })
  test('dormant between 7 and 60 days', () => {
    expect(classifyRepoBucket(now - 20 * DAY, now)).toBe('dormant')
    expect(classifyRepoBucket(now - 60 * DAY, now)).toBe('dormant')
  })
  test('dead beyond 60 days or with unknown activity', () => {
    expect(classifyRepoBucket(now - 90 * DAY, now)).toBe('dead')
    expect(classifyRepoBucket(0, now)).toBe('dead')
  })
})

describe('assembleInventory', () => {
  const raw = [
    { name: 'fresh', path: '/p/fresh', lastActivityMs: now - 1 * DAY },
    { name: 'old', path: '/p/old', lastActivityMs: now - 100 * DAY },
    { name: 'mid', path: '/p/mid', lastActivityMs: now - 30 * DAY },
  ]

  test('classifies buckets, flags schedule + hidden, sorts newest-active first', () => {
    const inv = assembleInventory(raw, new Set(['/p/old']), new Set(['/p/mid']), now)

    expect(inv.map((r) => r.name)).toEqual(['fresh', 'mid', 'old'])
    const byName = Object.fromEntries(inv.map((r) => [r.name, r]))
    expect(byName.fresh.bucket).toBe('active')
    expect(byName.mid.bucket).toBe('dormant')
    expect(byName.old.bucket).toBe('dead')
    expect(byName.old.hasSchedule).toBe(true)
    expect(byName.mid.hidden).toBe(true)
    expect(byName.fresh.hasSchedule).toBe(false)
    expect(byName.fresh.ageDays).toBe(1)
    expect(byName.old.ageDays).toBe(100)
  })

  test('unknown activity (0) yields ageDays -1 and dead bucket', () => {
    const inv = assembleInventory([{ name: 'x', path: '/p/x', lastActivityMs: 0 }], new Set(), new Set(), now)
    expect(inv[0].ageDays).toBe(-1)
    expect(inv[0].bucket).toBe('dead')
  })
})

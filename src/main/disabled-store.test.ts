import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readDisabledIds, updateDisabledIds } from '../../bin/lib/disabled-store.mjs'

// Shared kill-switch store (review 36716dba): cutover and terminal-cron's
// circuit breaker both write agents/disabled.json — updates must re-read
// under a lock and publish atomically so neither clobbers the other.

describe('disabled-store', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gt-disabled-'))
    file = join(dir, 'agents', 'disabled.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('readDisabledIds tolerates missing, array-shaped, and object-shaped files', () => {
    expect([...readDisabledIds(file)]).toEqual([])
    writeFileSync(join(dir, 'arr.json'), JSON.stringify(['a', 'b']))
    expect([...readDisabledIds(join(dir, 'arr.json'))].sort()).toEqual(['a', 'b'])
    writeFileSync(join(dir, 'obj.json'), JSON.stringify({ scheduleIds: ['c'] }))
    expect([...readDisabledIds(join(dir, 'obj.json'))]).toEqual(['c'])
  })

  test('updateDisabledIds re-reads under the lock: an external write landing between calls survives', () => {
    updateDisabledIds(file, (set) => set.add('cutover-a'))
    // circuit breaker writes directly between two cutover updates
    const current = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ scheduleIds: [...current.scheduleIds, 'breaker-b'] }))
    updateDisabledIds(file, (set) => set.delete('cutover-a'))
    const final = JSON.parse(readFileSync(file, 'utf8'))
    expect(final.scheduleIds).toEqual(['breaker-b'])
  })

  test('interleaved disable/re-enable vs circuit-breaker keeps the circuit-broken id', () => {
    // cutover disables A; breaker disables B; cutover re-enables A only
    updateDisabledIds(file, (set) => set.add('sched-a'))
    updateDisabledIds(file, (set) => set.add('sched-b')) // the breaker path uses the same store
    updateDisabledIds(file, (set) => set.delete('sched-a'))
    expect(JSON.parse(readFileSync(file, 'utf8')).scheduleIds).toEqual(['sched-b'])
  })

  test('a stale lock is taken over instead of deadlocking', () => {
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(`${file}.lock`, 'dead-pid', { flag: 'wx' })
    // fake an old lock by backdating is fs-utime fiddly in bun; the store
    // treats a lock older than its threshold as stale — simulate via the
    // injectable staleness check
    updateDisabledIds(file, (set) => set.add('x'), { isLockStale: () => true })
    expect(JSON.parse(readFileSync(file, 'utf8')).scheduleIds).toEqual(['x'])
    expect(existsSync(`${file}.lock`)).toBe(false)
  })
})

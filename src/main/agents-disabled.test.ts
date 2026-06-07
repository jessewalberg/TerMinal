import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { updateDisabledReasons } from '../../bin/lib/disabled-store.mjs'

// The Schedules tab is the THIRD writer of disabled.json (after cutover and
// the circuit breaker). Review 43ea5660: its flat read-modify-overwrite
// dropped reason metadata and raced the other writers — it must go through
// the shared store. TERMINAL_CONFIG_DIR is bound at import time, so the
// module is imported dynamically per fixture.

let cfg: string
let file: string
let api: typeof import('./agents-disabled')

beforeEach(async () => {
  cfg = mkdtempSync(join(tmpdir(), 'gt-agents-disabled-'))
  file = join(cfg, 'agents', 'disabled.json')
  process.env.TERMINAL_CONFIG_DIR = cfg
  api = await import(`./agents-disabled?cfg=${encodeURIComponent(cfg)}`)
})

afterEach(() => {
  delete process.env.TERMINAL_CONFIG_DIR
  rmSync(cfg, { recursive: true, force: true })
})

describe('agents-disabled (Schedules tab writer)', () => {
  test('toggling one schedule preserves another schedule’s breaker reason', () => {
    updateDisabledReasons(file, (map: Map<string, Set<string>>) => {
      map.set('broken', new Set(['breaker']))
    })
    api.setDisabled('paused-by-user', true)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.scheduleIds.sort()).toEqual(['broken', 'paused-by-user'])
    expect(raw.reasons.broken).toEqual(['breaker'])
    expect(raw.reasons['paused-by-user']).toEqual(['manual'])
  })

  test('a user re-enable clears EVERY reason — the explicit override beats breaker and cutover tokens', () => {
    updateDisabledReasons(file, (map: Map<string, Set<string>>) => {
      map.set('sched-a', new Set(['breaker', 'cutover']))
    })
    expect(api.isDisabled('sched-a')).toBe(true)
    api.setDisabled('sched-a', false)
    expect(api.isDisabled('sched-a')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).scheduleIds).toEqual([])
  })

  test('listDisabled returns the union view and setAllDisabled bulk-toggles', () => {
    api.setAllDisabled(['a', 'b'], true)
    expect(api.listDisabled().sort()).toEqual(['a', 'b'])
    api.setAllDisabled(['a', 'b'], false)
    expect(api.listDisabled()).toEqual([])
  })
})

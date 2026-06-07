import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  readDisabledIds,
  readDisabledReasons,
  updateDisabledReasons,
} from '../../bin/lib/disabled-store.mjs'

// Kill-switch / circuit-breaker registry. A scheduleId in this list is
// skipped by bin/terminal-cron at run time. Three writers share the file —
// this Schedules-tab IPC surface (manual pause), cron's circuit breaker
// (durable trip), and terminal-cutover (temporary token) — so every
// mutation goes through bin/lib/disabled-store.mjs (lock + re-read +
// atomic rename, reason-scoped ownership; cutover review 43ea5660).
//
// Semantics here: a user pause adds reason "manual"; a user RE-ENABLE is
// the explicit override and clears every reason (breaker trips included —
// that is exactly what the "re-enable from the Schedules tab" HITL asks
// the user to do).

const FILE = () =>
  join(
    process.env.TERMINAL_CONFIG_DIR?.trim() || join(homedir(), '.config', 'TerMinal'),
    'agents',
    'disabled.json',
  )

export function listDisabled(): string[] {
  return [...readDisabledIds(FILE())]
}

export function isDisabled(id: string): boolean {
  return readDisabledReasons(FILE()).has(id)
}

export function setDisabled(id: string, disabled: boolean): string[] {
  const map = updateDisabledReasons(FILE(), (reasons: Map<string, Set<string>>) => {
    if (disabled) {
      const set = reasons.get(id) ?? new Set<string>()
      set.add('manual')
      reasons.set(id, set)
    } else {
      reasons.delete(id)
    }
  })
  return [...map.keys()]
}

// Bulk variant. Lets the Schedules tab's "Pause all" button kill-switch every
// known schedule in one click (and the inverse to bring them all back online).
// The runner re-reads this file every fire, so paused state takes effect on
// the next launchd tick without an app/launchd restart.
export function setAllDisabled(ids: string[], disabled: boolean): string[] {
  const map = updateDisabledReasons(FILE(), (reasons: Map<string, Set<string>>) => {
    for (const id of ids) {
      if (disabled) {
        const set = reasons.get(id) ?? new Set<string>()
        set.add('manual')
        reasons.set(id, set)
      } else {
        reasons.delete(id)
      }
    }
  })
  return [...map.keys()]
}

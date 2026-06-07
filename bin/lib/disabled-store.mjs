// disabled-store.mjs — the ONE writer for the schedules kill-switch file
// (~/.config/TerMinal/agents/disabled.json). Review 36716dba: cutover and
// terminal-cron's circuit breaker both mutate this file; a plain
// read-modify-overwrite lets the later writer clobber the earlier one's
// schedule id. Updates here serialize on a wx lock file, RE-READ the current
// set inside the lock, and publish via temp + atomic rename. Zero-dep like
// its bin/lib siblings.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const LOCK_STALE_MS = 5_000
const LOCK_ATTEMPTS = 200 // ~2s of 10ms spins — kill-switch writes are tiny

export function readDisabledIds(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return new Set(Array.isArray(parsed) ? parsed : parsed?.scheduleIds || [])
  } catch {
    return new Set()
  }
}

function defaultIsLockStale(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}

function busyWait(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* spin — sync callers (cron tick, cutover step) hold this for <2s max */
  }
}

// updateDisabledIds(file, set => { mutate set }) — mutator runs against the
// CURRENT on-disk set (re-read under the lock), so concurrent writers
// compose instead of clobbering.
export function updateDisabledIds(file, mutator, { isLockStale = defaultIsLockStale } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const lockPath = `${file}.lock`
  let held = false
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt += 1) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
      held = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (isLockStale(lockPath)) {
        rmSync(lockPath, { force: true }) // dead writer — take over
      } else {
        busyWait(10)
      }
    }
  }
  if (!held) {
    throw new Error(`could not lock ${lockPath} — another writer is stuck; remove the lock if its pid is dead`)
  }
  try {
    const set = readDisabledIds(file)
    mutator(set)
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify({ scheduleIds: [...set] }, null, 2))
    renameSync(temp, file)
    return set
  } finally {
    rmSync(lockPath, { force: true })
  }
}

export function hasDisabledFile(file) {
  return existsSync(file)
}

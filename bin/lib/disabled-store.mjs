// disabled-store.mjs — the ONE writer for the schedules kill-switch file
// (~/.config/TerMinal/agents/disabled.json). Three writers share it: the
// Schedules tab (manual pause), terminal-cron's circuit breaker (durable
// trip), and terminal-cutover (temporary token). Reviews 36716dba/43ea5660:
// a plain read-modify-overwrite let writers clobber each other, and a flat
// id set could not tell cutover's TEMPORARY pause from a DURABLE breaker
// trip — cutover's re-enable would erase a trip that landed mid-cutover.
//
// File shape (backward compatible — every legacy reader keys off
// scheduleIds, which stays the union):
//   { "scheduleIds": ["a"], "reasons": { "a": ["breaker", "cutover"] } }
// Legacy files (bare array or {scheduleIds} without reasons) read as reason
// "manual". An id is disabled while it has ANY reason.
//
// Updates serialize on a wx lock file, RE-READ the current state inside the
// lock, and publish via temp + atomic rename. Zero-dep like its siblings.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const LOCK_STALE_MS = 5_000
const LOCK_ATTEMPTS = 200 // ~2s of 10ms spins — kill-switch writes are tiny

function parseReasons(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return new Map()
  }
  const ids = Array.isArray(parsed) ? parsed : parsed?.scheduleIds || []
  const rawReasons = (!Array.isArray(parsed) && parsed?.reasons) || {}
  const map = new Map()
  for (const [id, reasons] of Object.entries(rawReasons)) {
    if (Array.isArray(reasons) && reasons.length) map.set(id, new Set(reasons))
  }
  for (const id of ids) {
    if (typeof id === 'string' && !map.has(id)) map.set(id, new Set(['manual']))
  }
  return map
}

function serializeReasons(map) {
  const reasons = {}
  for (const [id, set] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size) reasons[id] = [...set]
  }
  return JSON.stringify({ scheduleIds: Object.keys(reasons), reasons }, null, 2)
}

export function readDisabledIds(file) {
  return new Set(parseReasons(file).keys())
}

export function readDisabledReasons(file) {
  return parseReasons(file)
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
    /* spin — sync callers (cron tick, cutover step, IPC toggle) hold this <2s */
  }
}

function withLock(file, options, body) {
  mkdirSync(dirname(file), { recursive: true })
  const lockPath = `${file}.lock`
  const isLockStale = options?.isLockStale ?? defaultIsLockStale
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
    return body()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

// updateDisabledReasons(file, map => { mutate Map<id, Set<reason>> }) — the
// mutator runs against the CURRENT on-disk state (re-read under the lock),
// so concurrent writers compose instead of clobbering.
export function updateDisabledReasons(file, mutator, options) {
  return withLock(file, options, () => {
    const map = parseReasons(file)
    mutator(map)
    for (const [id, set] of map) {
      if (!set || set.size === 0) map.delete(id)
    }
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, serializeReasons(map))
    renameSync(temp, file)
    return map
  })
}

// Set-shaped wrapper for callers that think in plain ids (the Schedules tab
// bulk ops, legacy call sites): additions get reason "manual", deletions
// clear EVERY reason — an explicit id-level removal is the user override.
export function updateDisabledIds(file, mutator, options) {
  const result = updateDisabledReasons(
    file,
    (map) => {
      const view = new Set(map.keys())
      const before = new Set(view)
      mutator(view)
      for (const id of view) {
        if (!before.has(id)) map.set(id, new Set(['manual']))
      }
      for (const id of before) {
        if (!view.has(id)) map.delete(id)
      }
    },
    options,
  )
  return new Set(result.keys())
}

export function hasDisabledFile(file) {
  return existsSync(file)
}

// cutover-core.mjs — per-repo vault-cutover support (vault TerMinal-004,
// Cross-Project ADR-0002 build 6). Zero-dep like its siblings so the bin/lib
// installer can deploy it; consumed by bin/terminal-cutover and tested from
// src/main/cutover-core.test.ts.
//
// Three concerns, all injectable for tests:
//   quiesceStatus            — is the repo safe to cut over right now?
//   setRepoSchedulesDisabled — kill-switch toggle scoped to one repo
//   restoreWritable          — rollback: flip a projected backlog writable
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateDisabledReasons } from './disabled-store.mjs'

const STALE_AFTER_MS = 2 * 3600_000

export function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ADR-0002 cutover step 3: a run record blocks ONLY when status:'running'
// AND its pid is alive AND it is younger than 2h. Dead pid, missing pid, or
// >2h old = stale — never block on status alone (runner crashes routinely
// leave running-status records behind; the cron sweeper finalizes them
// lazily, and cutover must not wait on that).
export function quiesceStatus({ repoRoot, runsDirs, isPidAlive = defaultIsPidAlive, now = Date.now() }) {
  const blockers = []
  const stale = []
  for (const dir of runsDirs) {
    let files
    try {
      files = readdirSync(dir)
    } catch {
      continue // dir may not exist yet — nothing running
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      let rec
      try {
        rec = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      } catch {
        continue // unreadable record cannot prove a live run
      }
      if (rec?.status !== 'running' || rec?.repoRoot !== repoRoot) continue
      const ageMs = now - (rec.startedAt ?? 0)
      const entry = { id: rec.id ?? file.replace(/\.json$/, ''), pid: rec.pid, ageMs, file: join(dir, file) }
      const pidAlive = rec.pid ? isPidAlive(rec.pid) : false
      if (pidAlive && ageMs <= STALE_AFTER_MS) {
        blockers.push(entry)
      } else {
        stale.push({
          ...entry,
          reason: !rec.pid ? 'no pid recorded' : !pidAlive ? `pid ${rec.pid} is dead` : `older than 2h`,
        })
      }
    }
  }
  return { quiet: blockers.length === 0, blockers, stale }
}

// Kill-switch toggle scoped to one repoRoot (cutover steps 2 and 7). Returns
// the ids THIS call changed so re-enable can be exact: a schedule the
// circuit breaker disabled before cutover must stay off afterward — pass
// `only` (the disable call's `changed`) when re-enabling. The mutation runs
// through disabled-store (lock + re-read + atomic rename), so a concurrent
// circuit-breaker write composes instead of being clobbered (review 36716dba).
export function setRepoSchedulesDisabled({ repoRoot, schedulesFile, disabledFile, disable, only }) {
  let schedules = []
  try {
    const parsed = JSON.parse(readFileSync(schedulesFile, 'utf8'))
    schedules = Array.isArray(parsed) ? parsed : []
  } catch {
    return { changed: [] } // no schedules at all — nothing to toggle
  }
  const repoIds = schedules.filter((sched) => sched?.repoRoot === repoRoot).map((sched) => sched.id)
  const scope = only ? repoIds.filter((id) => only.includes(id)) : repoIds
  if (!scope.length) return { changed: [] }
  const changed = []
  // Cutover owns only its own 'cutover' reason (review 43ea5660): disable
  // tokens ids that are not already disabled for some other reason, and
  // re-enable strips ONLY the cutover token — a breaker trip or manual pause
  // that landed in the meantime keeps the schedule disabled.
  updateDisabledReasons(disabledFile, (map) => {
    for (const id of scope) {
      const reasons = map.get(id)
      if (disable) {
        if (!reasons || reasons.size === 0) {
          map.set(id, new Set(['cutover']))
          changed.push(id)
        }
      } else if (reasons?.has('cutover')) {
        reasons.delete('cutover')
        changed.push(id)
      }
    }
  })
  return { changed }
}

// Apply-mode sequencing (review a3664e2f): the kill-switch MUST land before
// the quiesce check — quiesce-then-disable leaves a window where a schedule
// fires into the repo mid-cutover. Every exit path re-enables exactly what
// this run disabled (a quiesce refusal included); circuit-broken schedules
// stay off because `enable` is scoped to `down.changed`.
export function applyCutover({ disable, enable, quiesce, importStep, untrackStep, projectStep }) {
  const down = disable()
  try {
    const status = quiesce()
    if (!status.quiet) {
      const blockers = status.blockers
        .map((b) => `${b.id} (pid ${b.pid}, ${Math.round(b.ageMs / 60000)} min old)`)
        .join(', ')
      throw new Error(`blocked by live run(s): ${blockers}`)
    }
    importStep()
    untrackStep()
    projectStep()
    return { disabled: down.changed, quiesce: status }
  } finally {
    enable(down.changed)
  }
}

// Idempotent gitignore line (review 5e0379f6): retries of a half-applied
// cutover must not stack duplicate entries.
export function withIgnoredBacklog(content) {
  if (content.split('\n').some((line) => line.trim() === 'backlog/')) return content
  return `${content.length && !content.endsWith('\n') ? `${content}\n` : content}backlog/\n`
}

// Rollback (ADR-0002): delete .projection, restore .next-id — the repo
// reverts to writable-canonical. Un-ignoring backlog/ and restoring tracked
// content are git operations that stay in the runbook (they need the repo's
// git context); deleting imported vault tasks after a BAD IMPORT is a
// separate, deliberate step documented there too.
export function restoreWritable({ backlogDir, nextId }) {
  const marker = join(backlogDir, '.projection')
  const restored = existsSync(marker)
  if (restored) rmSync(marker, { force: true })
  writeFileSync(join(backlogDir, '.next-id'), `${nextId}\n`)
  return { restored }
}

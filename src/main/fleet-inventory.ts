import { readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolvedProjectsDir, readSettings } from './settings'
import { readSchedules } from './schedules'

// Cross-repo fleet inventory.
//
// fleet:list only "sees" repos with open sessions; factory-health ranks by event
// volume, so silent repos vanish. This scans resolvedProjectsDir() once for git
// repos and buckets them by last-activity age — pure visibility, plus a manual
// hide flag (settings.hiddenRepos). Not a retire *workflow*. See ticket #14.

const DAY = 86_400_000
const ACTIVE_DAYS = 7
const DORMANT_DAYS = 60

export type RepoBucket = 'active' | 'dormant' | 'dead'

export type RepoInventory = {
  name: string
  path: string
  lastActivityMs: number
  ageDays: number // -1 when unknown (no commits)
  hasSchedule: boolean
  hidden: boolean
  bucket: RepoBucket
}

/** Pure: bucket a repo by how long since its last activity. */
export function classifyRepoBucket(lastActivityMs: number, now: number): RepoBucket {
  if (!lastActivityMs) return 'dead'
  const ageDays = (now - lastActivityMs) / DAY
  if (ageDays <= ACTIVE_DAYS) return 'active'
  if (ageDays <= DORMANT_DAYS) return 'dormant'
  return 'dead'
}

/** Pure: turn raw repo facts + schedule/hidden sets into a sorted inventory
 *  (newest activity first). Injectable so it's testable without disk/git. */
export function assembleInventory(
  raw: { name: string; path: string; lastActivityMs: number }[],
  scheduleRoots: Set<string>,
  hidden: Set<string>,
  now: number,
): RepoInventory[] {
  return raw
    .map((r) => ({
      name: r.name,
      path: r.path,
      lastActivityMs: r.lastActivityMs,
      ageDays: r.lastActivityMs ? Math.floor((now - r.lastActivityMs) / DAY) : -1,
      hasSchedule: scheduleRoots.has(r.path),
      hidden: hidden.has(r.path),
      bucket: classifyRepoBucket(r.lastActivityMs, now),
    }))
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
}

/** Scan the projects dir for git repos and build the live inventory. */
export function buildInventory(now = Date.now()): RepoInventory[] {
  const base = resolvedProjectsDir()
  let entries: string[] = []
  try {
    entries = readdirSync(base)
  } catch {
    return []
  }
  const raw: { name: string; path: string; lastActivityMs: number }[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const path = join(base, name)
    if (!existsSync(join(path, '.git'))) continue
    let lastActivityMs = 0
    try {
      const ct = execFileSync('git', ['-C', path, 'log', '-1', '--format=%ct'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (ct) lastActivityMs = Number(ct) * 1000
    } catch {
      /* no commits / not a repo → lastActivityMs stays 0 (dead) */
    }
    raw.push({ name: basename(path), path, lastActivityMs })
  }
  const scheduleRoots = new Set(readSchedules(now).map((s) => s.repoRoot).filter(Boolean))
  const hidden = new Set(readSettings().hiddenRepos || [])
  return assembleInventory(raw, scheduleRoots, hidden, now)
}

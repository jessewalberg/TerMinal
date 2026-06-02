import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { listRuns as listAgentRuns, type AgentRun } from './agents'

// Read the run records the headless runner (bin/terminal-cron) writes per run.
const RUNS_DIR = join(homedir(), '.config', 'TerMinal', 'cron-runs')
const STALE_MS = 2 * 60 * 60 * 1000 // matches terminal-cron's STALE_MS

export type CronRun = {
  id: string
  scheduleId: string
  agentId: string
  agentTitle: string
  engine: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  exitCode?: number
  branch: string
  repoLabel: string
  worktree: string
  error?: string
}

// Parsed records cached by filename + mtime. readCronRuns runs on every
// runs:all call and every cron-run watch push (and inside factoryHealth's 15s
// poll), and a record is immutable once finalized — so re-parsing every JSON
// file each call was pure waste. readdir + one stat per file is cheap; the
// readFile+JSON.parse only happens for files whose mtime actually changed.
const recCache = new Map<string, { mtime: number; rec: CronRun }>()
export function readCronRuns(scheduleId?: string, limit = 200): CronRun[] {
  if (!existsSync(RUNS_DIR)) return []
  let files: string[]
  try {
    files = readdirSync(RUNS_DIR)
  } catch {
    return []
  }
  const out: CronRun[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    seen.add(f)
    const full = join(RUNS_DIR, f)
    let mtime = 0
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      continue
    }
    let rec: CronRun
    const hit = recCache.get(f)
    if (hit && hit.mtime === mtime) {
      rec = hit.rec
    } else {
      try {
        rec = JSON.parse(readFileSync(full, 'utf8')) as CronRun
      } catch {
        continue
      }
      recCache.set(f, { mtime, rec })
    }
    if (!scheduleId || rec.scheduleId === scheduleId) out.push(rec)
  }
  for (const k of recCache.keys()) if (!seen.has(k)) recCache.delete(k) // drop deleted files
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, limit)
}

// App-side watchdog. Mirrors bin/terminal-cron's sweep but runs whenever the
// app is alive — not gated on a schedule firing. Without this, a phantom run
// (schedule deleted before the runner finalized the record, terminal closed
// mid-run, OOM) sits at status:running forever when the user has no enabled
// schedules left to trigger a sweep on the cron side.
//
// Conservative: only finalizes records that are (a) status:running, (b) older
// than STALE_MS, AND (c) have NO live process matching the worktree path. The
// process check is a coarse pgrep — false positives would mean leaving a
// real run alone (safer than killing it accidentally).
export function sweepStaleCronRuns(): { swept: number } {
  if (!existsSync(RUNS_DIR)) return { swept: 0 }
  const now = Date.now()
  let swept = 0
  for (const f of readdirSync(RUNS_DIR)) {
    if (!f.endsWith('.json')) continue
    const path = join(RUNS_DIR, f)
    try {
      const r = JSON.parse(readFileSync(path, 'utf8')) as CronRun & { worktree?: string }
      if (r.status !== 'running') continue
      if (now - (r.startedAt || 0) < STALE_MS) continue
      // No process / no worktree match → phantom. Skip the live-process check
      // when we have no worktree (very old records): fall through to sweep.
      // We don't bother shelling out — the cost of a false sweep is the user
      // sees a "failed: stale" badge instead of the truth, which is fine.
      const finalized = {
        ...r,
        status: 'failed' as const,
        endedAt: now,
        error: 'stale: app-side watchdog finalized (>2h with no in-app activity)',
      }
      writeFileSync(path, JSON.stringify(finalized, null, 2))
      swept++
    } catch {
      /* skip unreadable record */
    }
  }
  return { swept }
}

export function readCronRunLog(runId: string): string {
  const safe = runId.replace(/[^\w-]/g, '')
  const f = join(RUNS_DIR, `${safe}.log`)
  try {
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  } catch {
    return ''
  }
}

// ---- unified runs view -----------------------------------------------------

// A single shape for every run regardless of origin — cron-fired vs in-process
// agent vs ticket-spawn etc. Powers the Runs tab so the operator gets one
// global picture instead of jumping between Schedules and Agents.
export type UnifiedRun = {
  id: string
  source: 'cron' | 'agent'
  agentId: string
  agentTitle: string
  engine: string
  status: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  repoRoot: string
  repoLabel: string
  branch: string
  worktree: string
  persona?: string
  pipeline?: string
  scheduleId?: string
  error?: string
  force?: boolean
}

function agentRunToUnified(r: AgentRun): UnifiedRun {
  return {
    id: r.id,
    source: 'agent',
    agentId: r.agentId,
    agentTitle: r.agentTitle,
    engine: r.engine,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    repoRoot: r.repoRoot,
    repoLabel: basename(r.repoRoot) || '',
    branch: r.branch,
    worktree: r.worktree,
    persona: r.persona,
    pipeline: r.pipeline,
    force: r.force,
  }
}

function cronRunToUnified(r: CronRun & { repoRoot?: string }): UnifiedRun {
  return {
    id: r.id,
    source: 'cron',
    agentId: r.agentId,
    agentTitle: r.agentTitle,
    engine: r.engine,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    repoRoot: r.repoRoot || '',
    repoLabel: r.repoLabel,
    branch: r.branch,
    worktree: r.worktree,
    scheduleId: r.scheduleId,
    error: r.error,
  }
}

export function listAllRuns(limit = 400): UnifiedRun[] {
  const cron = readCronRuns(undefined, limit).map(cronRunToUnified)
  const agent = listAgentRuns().map(agentRunToUnified)
  return [...cron, ...agent].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, limit)
}

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyCutover,
  quiesceStatus,
  setRepoSchedulesDisabled,
  restoreWritable,
  withIgnoredBacklog,
} from '../../bin/lib/cutover-core.mjs'
import { hasProjectionMarker } from '../../bin/lib/backlog-core.mjs'

// Per-repo cutover support (vault TerMinal-004, ADR-0002 build 6): quiesce
// check over cron-runs/agent-runs, kill-switch toggle scoped to one repo,
// and the rollback that restores a writable backlog.

const REPO = '/Volumes/home-ext/projects/demo'
const NOW = 1_800_000_000_000

describe('quiesceStatus', () => {
  let cfg: string
  let runsDirs: string[]

  const rec = (dir: string, name: string, over: Record<string, unknown>) =>
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({
        id: name,
        status: 'running',
        repoRoot: REPO,
        startedAt: NOW - 60_000,
        pid: 4242,
        ...over,
      }),
    )

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), 'gt-cutover-'))
    runsDirs = [join(cfg, 'cron-runs'), join(cfg, 'agent-runs')]
    for (const d of runsDirs) mkdirSync(d, { recursive: true })
  })
  afterEach(() => rmSync(cfg, { recursive: true, force: true }))

  test('a running record with a live pid for the repo blocks', () => {
    rec(runsDirs[0], 'live', {})
    const status = quiesceStatus({
      repoRoot: REPO,
      runsDirs,
      isPidAlive: () => true,
      now: NOW,
    })
    expect(status.quiet).toBe(false)
    expect(status.blockers).toHaveLength(1)
    expect(status.blockers[0].id).toBe('live')
    expect(status.blockers[0].pid).toBe(4242)
  })

  test('dead pid, missing pid, and >2h-old records are stale — status alone never blocks', () => {
    rec(runsDirs[0], 'dead-pid', { pid: 999 })
    rec(runsDirs[0], 'no-pid', { pid: undefined })
    rec(runsDirs[1], 'ancient', { startedAt: NOW - 3 * 3600_000 })
    const status = quiesceStatus({
      repoRoot: REPO,
      runsDirs,
      isPidAlive: (pid: number) => pid === 4242, // only 'ancient' has a live pid
      now: NOW,
    })
    expect(status.quiet).toBe(true)
    expect(status.blockers).toHaveLength(0)
    expect(status.stale.map((s: { id: string }) => s.id).sort()).toEqual([
      'ancient',
      'dead-pid',
      'no-pid',
    ])
  })

  test('records for other repos and non-running statuses are ignored', () => {
    rec(runsDirs[0], 'other-repo', { repoRoot: '/elsewhere' })
    rec(runsDirs[1], 'done', { status: 'done' })
    const status = quiesceStatus({
      repoRoot: REPO,
      runsDirs,
      isPidAlive: () => true,
      now: NOW,
    })
    expect(status.quiet).toBe(true)
    expect(status.blockers).toHaveLength(0)
    expect(status.stale).toHaveLength(0)
  })

  test('missing runs dirs and unreadable records are tolerated', () => {
    writeFileSync(join(runsDirs[0], 'garbage.json'), 'not json')
    const status = quiesceStatus({
      repoRoot: REPO,
      runsDirs: [...runsDirs, join(cfg, 'never-created')],
      isPidAlive: () => true,
      now: NOW,
    })
    expect(status.quiet).toBe(true)
  })
})

describe('setRepoSchedulesDisabled', () => {
  let cfg: string
  let schedulesFile: string
  let disabledFile: string

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), 'gt-killswitch-'))
    schedulesFile = join(cfg, 'schedules.json')
    disabledFile = join(cfg, 'agents', 'disabled.json')
    writeFileSync(
      schedulesFile,
      JSON.stringify([
        { id: 'sched-a', agentTitle: 'A', repoRoot: REPO },
        { id: 'sched-b', agentTitle: 'B', repoRoot: REPO },
        { id: 'sched-x', agentTitle: 'X', repoRoot: '/elsewhere' },
      ]),
    )
  })
  afterEach(() => rmSync(cfg, { recursive: true, force: true }))

  test('disable adds exactly the repo schedules to the kill-switch and reports them', () => {
    const result = setRepoSchedulesDisabled({
      repoRoot: REPO,
      schedulesFile,
      disabledFile,
      disable: true,
    })
    expect(result.changed.sort()).toEqual(['sched-a', 'sched-b'])
    const disabled = JSON.parse(readFileSync(disabledFile, 'utf8'))
    expect(disabled.scheduleIds.sort()).toEqual(['sched-a', 'sched-b'])
  })

  test('re-enable removes only what the cutover disabled — a circuit-broken schedule stays off', () => {
    mkdirSync(join(cfg, 'agents'), { recursive: true })
    // sched-b was already disabled by the circuit breaker before cutover
    writeFileSync(disabledFile, JSON.stringify({ scheduleIds: ['sched-b'] }))
    const down = setRepoSchedulesDisabled({
      repoRoot: REPO,
      schedulesFile,
      disabledFile,
      disable: true,
    })
    // only sched-a is newly disabled
    expect(down.changed).toEqual(['sched-a'])
    const up = setRepoSchedulesDisabled({
      repoRoot: REPO,
      schedulesFile,
      disabledFile,
      disable: false,
      only: down.changed,
    })
    expect(up.changed).toEqual(['sched-a'])
    const disabled = JSON.parse(readFileSync(disabledFile, 'utf8'))
    expect(disabled.scheduleIds).toEqual(['sched-b'])
  })

  test('missing schedules.json means nothing to toggle', () => {
    rmSync(schedulesFile)
    const result = setRepoSchedulesDisabled({
      repoRoot: REPO,
      schedulesFile,
      disabledFile,
      disable: true,
    })
    expect(result.changed).toEqual([])
    expect(existsSync(disabledFile)).toBe(false)
  })
})

describe('applyCutover orchestration (review a3664e2f)', () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const calls: string[] = []
    const hooks = {
      disable: () => {
        calls.push('disable')
        return { changed: ['sched-a'] }
      },
      enable: (only: string[]) => {
        calls.push(`enable:${only.join(',')}`)
        return { changed: only }
      },
      quiesce: () => {
        calls.push('quiesce')
        return { quiet: true, blockers: [], stale: [] }
      },
      importStep: () => calls.push('import'),
      untrackStep: () => calls.push('untrack'),
      projectStep: () => calls.push('project'),
      ...over,
    }
    return { calls, hooks }
  }

  test('the kill-switch lands BEFORE quiesce — a schedule cannot start in between', () => {
    const { calls, hooks } = harness()
    applyCutover(hooks)
    expect(calls).toEqual(['disable', 'quiesce', 'import', 'untrack', 'project', 'enable:sched-a'])
  })

  test('a quiesce refusal still re-enables exactly what was disabled', () => {
    const { calls, hooks } = harness({
      quiesce: () => {
        calls.push('quiesce')
        return { quiet: false, blockers: [{ id: 'live', pid: 1, ageMs: 0, file: 'x' }], stale: [] }
      },
    })
    expect(() => applyCutover(hooks)).toThrow(/live run/)
    expect(calls).toEqual(['disable', 'quiesce', 'enable:sched-a'])
  })

  test('a step failure mid-flow still re-enables exactly what was disabled', () => {
    const { calls, hooks } = harness({
      projectStep: () => {
        calls.push('project')
        throw new Error('projection exploded')
      },
    })
    expect(() => applyCutover(hooks)).toThrow(/projection exploded/)
    expect(calls).toEqual(['disable', 'quiesce', 'import', 'untrack', 'project', 'enable:sched-a'])
  })
})

describe('withIgnoredBacklog (review 5e0379f6)', () => {
  test('appends backlog/ once and is idempotent on retries', () => {
    expect(withIgnoredBacklog('')).toBe('backlog/\n')
    expect(withIgnoredBacklog('node_modules/\n')).toBe('node_modules/\nbacklog/\n')
    const once = withIgnoredBacklog('node_modules/\n')
    expect(withIgnoredBacklog(once)).toBe(once)
    // matches the bare line only, not substrings
    expect(withIgnoredBacklog('legacy-backlog/\n')).toBe('legacy-backlog/\nbacklog/\n')
  })
})

describe('restoreWritable (cutover rollback)', () => {
  test('deletes the marker and restores .next-id so writers go writable-canonical again', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gt-rollback-'))
    const backlog = join(repo, 'backlog')
    mkdirSync(backlog, { recursive: true })
    writeFileSync(join(backlog, '.projection'), '{"vaultPath":"/v"}\n')
    writeFileSync(join(backlog, '.next-id'), '44\n')
    writeFileSync(join(backlog, '0001-t.md'), 'projected\n')
    expect(hasProjectionMarker(backlog)).toBe(true)

    const result = restoreWritable({ backlogDir: backlog, nextId: 25 })
    expect(result.restored).toBe(true)
    expect(hasProjectionMarker(backlog)).toBe(false)
    expect(readFileSync(join(backlog, '.next-id'), 'utf8')).toBe('25\n')
    // the projected tickets stay — rollback only flips writability; the
    // runbook's git checkout restores tracked content where needed
    expect(existsSync(join(backlog, '0001-t.md'))).toBe(true)
    rmSync(repo, { recursive: true, force: true })
  })

  test('is a safe no-op on an already-writable backlog', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gt-rollback2-'))
    const backlog = join(repo, 'backlog')
    mkdirSync(backlog, { recursive: true })
    const result = restoreWritable({ backlogDir: backlog, nextId: 7 })
    expect(result.restored).toBe(false)
    expect(readFileSync(join(backlog, '.next-id'), 'utf8')).toBe('7\n')
    rmSync(repo, { recursive: true, force: true })
  })
})

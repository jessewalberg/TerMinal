import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const cli = resolve(process.cwd(), 'bin/terminal-cli')

describe('terminal-cli run lifecycle', () => {
  test('records and finalizes a terminal-started workflow run', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminal-cli-run-'))
    const repo = join(home, 'repo')
    mkdirSync(repo)
    const env = {
      ...process.env,
      HOME: home,
      TERMINAL_REPO: repo,
      TERMINAL_RUN_SOURCE: 'workflow',
    }

    const runId = execFileSync(
      'bun',
      [
        cli,
        'run',
        'start',
        'stacked-mr',
        'Stacked MR',
        '--engine',
        'codex',
        '--branch',
        '0018-keyboard-nav',
        '--worktree',
        repo,
      ],
      { encoding: 'utf8', env },
    ).trim()

    expect(runId).toMatch(/^[\w-]+$/)

    execFileSync('bun', [cli, 'run', 'finish', runId, 'done', '--exit-code', '0'], {
      encoding: 'utf8',
      env,
    })

    const cfg = join(home, '.config', 'TerMinal')
    const rec = JSON.parse(readFileSync(join(cfg, 'cron-runs', `${runId}.json`), 'utf8'))
    expect(rec).toMatchObject({
      id: runId,
      source: 'workflow',
      scheduleId: 'workflow:stacked-mr',
      agentId: 'stacked-mr',
      agentTitle: 'Stacked MR',
      engine: 'codex',
      status: 'done',
      exitCode: 0,
      repoRoot: repo,
      repoLabel: 'repo',
      branch: '0018-keyboard-nav',
      worktree: repo,
    })
    expect(rec.startedAt).toBeGreaterThan(0)
    expect(rec.endedAt).toBeGreaterThanOrEqual(rec.startedAt)

    const log = readFileSync(join(cfg, 'cron-runs', `${runId}.log`), 'utf8')
    expect(log).toContain('Workflow started · Stacked MR')
    expect(log).toContain('Workflow finished · done')

    const events = readFileSync(join(cfg, 'activity.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.map((e) => e.title)).toEqual([
      'Workflow started · Stacked MR',
      'Workflow done · Stacked MR',
    ])
    expect(events.every((e) => e.runId === runId && e.runSource === 'workflow')).toBe(true)
  })
})

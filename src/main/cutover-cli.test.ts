import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Integration tests for bin/terminal-cutover (reviews 5e0379f6, 37fb3c64):
// a temp git repo with a tracked backlog/, a fake vault tool that records
// its invocations + env, and an isolated TERMINAL_CONFIG_DIR.

const CLI = join(import.meta.dir, '..', '..', 'bin', 'terminal-cutover')

let root: string
let repo: string
let cfg: string
let fakeTool: string
let invocations: string

const runCli = (args: string[], extraEnv: Record<string, string> = {}) =>
  execFileSync('bun', [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TERMINAL_CONFIG_DIR: cfg,
      VAULT_TOOLS_PATH: fakeTool,
      GT_VAULT_PATH: join(root, 'vault'),
      ...extraEnv,
    },
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gt-cutover-cli-'))
  repo = join(root, 'demo')
  cfg = join(root, 'cfg')
  invocations = join(root, 'invocations.log')
  mkdirSync(join(cfg, 'cron-runs'), { recursive: true })
  mkdirSync(join(cfg, 'agent-runs'), { recursive: true })
  mkdirSync(join(root, 'vault'), { recursive: true })

  // fake vault.mjs: logs "<verb> <env vault path>" and fails `project`
  // while the fail-project marker exists
  fakeTool = join(root, 'fake-vault.mjs')
  writeFileSync(
    fakeTool,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync, existsSync } from 'node:fs'",
      `const log = ${JSON.stringify(invocations)}`,
      `const marker = ${JSON.stringify(join(root, 'fail-project'))}`,
      'const verb = process.argv[2]',
      "appendFileSync(log, `${verb} ${process.env.PROJECTS_VAULT_PATH ?? ''}\\n`)",
      "if (verb === 'project' && existsSync(marker)) { console.error('boom'); process.exit(1) }",
      'process.exit(0)',
    ].join('\n'),
  )
  chmodSync(fakeTool, 0o755)

  // git repo with one tracked backlog ticket
  mkdirSync(join(repo, 'backlog'), { recursive: true })
  writeFileSync(join(repo, 'backlog', '0001-t.md'), '---\nid: 1\n---\n\nbody\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('add', '.')
  git('commit', '-q', '-m', 'seed')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('terminal-cutover CLI', () => {
  test('dry-run threads the resolved vault path into the vault tool and mutates nothing', () => {
    const out = runCli([repo])
    expect(out).toContain('[dry-run]')
    const logged = readFileSync(invocations, 'utf8').trim()
    // review 37fb3c64: PROJECTS_VAULT_PATH must be the route-resolved path
    expect(logged).toBe(`import-backlog ${join(root, 'vault')}`)
    expect(existsSync(join(repo, '.gitignore'))).toBe(false)
    // backlog still tracked
    const tracked = execFileSync('git', ['ls-files', '--', 'backlog'], { cwd: repo, encoding: 'utf8' })
    expect(tracked).toContain('0001-t.md')
  })

  test('a projection failure leaves a retryable state: the re-run reaches projection (review 5e0379f6)', () => {
    writeFileSync(join(root, 'fail-project'), '')
    expect(() => runCli([repo, '--apply'])).toThrow()
    // first attempt untracked backlog/ before projection failed
    const tracked = execFileSync('git', ['ls-files', '--', 'backlog'], { cwd: repo, encoding: 'utf8' })
    expect(tracked.trim()).toBe('')

    rmSync(join(root, 'fail-project'))
    const out = runCli([repo, '--apply'])
    expect(out).toContain('cutover complete')
    // the second run got PAST the untrack step and re-ran projection
    const verbs = readFileSync(invocations, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])
    expect(verbs).toEqual(['import-backlog', 'project', 'import-backlog', 'project'])
    // gitignore carries exactly one backlog/ line across both attempts
    const ignore = readFileSync(join(repo, '.gitignore'), 'utf8')
    expect(ignore.split('\n').filter((l) => l.trim() === 'backlog/')).toHaveLength(1)
  })

  test('apply with a live blocker refuses before importing and re-enables schedules', () => {
    writeFileSync(join(cfg, 'schedules.json'), JSON.stringify([{ id: 'sched-a', repoRoot: repo }]))
    writeFileSync(
      join(cfg, 'cron-runs', 'live.json'),
      JSON.stringify({ id: 'live', status: 'running', repoRoot: repo, startedAt: Date.now(), pid: process.pid }),
    )
    expect(() => runCli([repo, '--apply'])).toThrow()
    // nothing imported, backlog still tracked
    expect(existsSync(invocations)).toBe(false)
    const tracked = execFileSync('git', ['ls-files', '--', 'backlog'], { cwd: repo, encoding: 'utf8' })
    expect(tracked).toContain('0001-t.md')
    // the kill-switch was rolled back to empty (sched-a re-enabled)
    const disabled = JSON.parse(readFileSync(join(cfg, 'agents', 'disabled.json'), 'utf8'))
    expect(disabled.scheduleIds).toEqual([])
  })
})

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseHarnessConfigYaml, repoRootFor, webhookSecretFor } from './harness-config'

describe('parseHarnessConfigYaml', () => {
  test('parses repos map with ci_webhook_secret', () => {
    const yaml = `
repos:
  terminal:
    root: /Users/me/TerMinal
    ci_webhook_secret: sekrit
  emails:
    root: /Users/me/emails
    ci_webhook_secret: other
`
    const cfg = parseHarnessConfigYaml(yaml)
    expect(cfg.repos).toHaveLength(2)
    expect(repoRootFor('terminal', cfg)).toBe('/Users/me/TerMinal')
    expect(webhookSecretFor('TerMinal', cfg)).toBe('sekrit')
  })

  test('ignores incomplete entries', () => {
    const cfg = parseHarnessConfigYaml('repos:\n  foo:\n    root: /x\n')
    expect(cfg.repos).toHaveLength(0)
  })
})

describe('repoRootFor / webhookSecretFor', () => {
  let dir: string
  let prev: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gt-harness-'))
    prev = process.env.GT_HARNESS_DIR
    process.env.GT_HARNESS_DIR = dir
    mkdirSync(join(dir, 'prs'), { recursive: true })
    writeFileSync(
      join(dir, 'prs', 'config.yml'),
      `repos:
  myrepo:
    root: /tmp/myrepo
    ci_webhook_secret: abc
`,
      { flag: 'w' },
    )
    // mkdir prs
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.GT_HARNESS_DIR
    else process.env.GT_HARNESS_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })

  test('loads from harnessDir/prs/config.yml', () => {
    expect(repoRootFor('myrepo')).toBe('/tmp/myrepo')
    expect(webhookSecretFor('MYREPO')).toBe('abc')
  })
})

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from './server'

describe('POST /api/ci-webhook/:repo', () => {
  let harnessDir: string
  let repoRoot: string
  let prevHarness: string | undefined

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'gt-wh-'))
    repoRoot = mkdtempSync(join(tmpdir(), 'gt-repo-'))
    prevHarness = process.env.GT_HARNESS_DIR
    process.env.GT_HARNESS_DIR = harnessDir
    mkdirSync(join(harnessDir, 'prs'), { recursive: true })
    writeFileSync(
      join(harnessDir, 'prs', 'config.yml'),
      `repos:
  testrepo:
    root: ${repoRoot}
    ci_webhook_secret: wh-secret
`,
    )
    mkdirSync(join(repoRoot, '.agents'), { recursive: true })
    const script = join(repoRoot, '.agents', 'ci-watchdog.sh')
    writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(script, 0o755)
  })

  afterEach(() => {
    if (prevHarness === undefined) delete process.env.GT_HARNESS_DIR
    else process.env.GT_HARNESS_DIR = prevHarness
    rmSync(harnessDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test('rejects missing signature', async () => {
    const app = createApp()
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      body: JSON.stringify({ object_kind: 'pipeline', object_attributes: { status: 'failed', id: 1 } }),
    })
    expect(res.status).toBe(401)
  })

  test('accepts gitlab token and returns ok for failed pipeline', async () => {
    const app = createApp()
    const body = JSON.stringify({
      object_kind: 'pipeline',
      object_attributes: { id: 99, status: 'failed', ref: 'feature/x' },
      merge_request: { iid: 7 },
    })
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret', 'Content-Type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('ignores non-failed pipelines', async () => {
    const app = createApp()
    const body = JSON.stringify({
      object_kind: 'pipeline',
      object_attributes: { id: 1, status: 'success' },
    })
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body,
    })
    expect(res.status).toBe(200)
  })
})

import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from './server'
import { MAX_BODY_BYTES } from './read-body'
import * as spawnWatchdog from './spawn-watchdog'

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
    mock.restore()
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

  test('rejects invalid json', async () => {
    const app = createApp()
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid json')
  })

  test('rejects oversized body', async () => {
    const app = createApp()
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    })
    expect(res.status).toBe(413)
  })

  test('rejects unknown repo', async () => {
    const app = createApp()
    const res = await app.request('/api/ci-webhook/nope', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  test('rejects configured repo when root path is missing', async () => {
    writeFileSync(
      join(harnessDir, 'prs', 'config.yml'),
      `repos:
  ghost:
    root: ${join(tmpdir(), 'gt-missing-root-never-exists')}
    ci_webhook_secret: wh-secret
`,
    )
    const app = createApp()
    const res = await app.request('/api/ci-webhook/ghost', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body: JSON.stringify({ object_kind: 'pipeline', object_attributes: { id: 1, status: 'failed' } }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('repo root missing')
  })

  test('acknowledges failed pipeline without id without spawning', async () => {
    const spawnSpy = spyOn(spawnWatchdog, 'spawnCiWatchdog')
    const app = createApp()
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body: JSON.stringify({ object_kind: 'pipeline', object_attributes: { status: 'failed' } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  test('returns 500 when spawn fails', async () => {
    spyOn(spawnWatchdog, 'spawnCiWatchdog').mockReturnValue({ ok: false, error: 'spawn failed' })
    const app = createApp()
    const body = JSON.stringify({
      object_kind: 'pipeline',
      object_attributes: { id: 1, status: 'failed' },
    })
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body,
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('spawn failed')
  })

  test('passes CI env vars to spawn', async () => {
    let captured: spawnWatchdog.WatchdogEnv | undefined
    spyOn(spawnWatchdog, 'spawnCiWatchdog').mockImplementation((env) => {
      captured = env
      return { ok: true, pid: 12345 }
    })

    const app = createApp()
    const body = JSON.stringify({
      object_kind: 'pipeline',
      object_attributes: { id: 42, ref: 'fix/ci', status: 'failed' },
      merge_request: { iid: 7 },
    })
    const res = await app.request('/api/ci-webhook/testrepo', {
      method: 'POST',
      headers: { 'X-Gitlab-Token': 'wh-secret' },
      body,
    })
    expect(res.status).toBe(200)
    expect(captured).toEqual({
      repoRoot,
      pipelineId: '42',
      mrIid: '7',
      branch: 'fix/ci',
    })
  })
})

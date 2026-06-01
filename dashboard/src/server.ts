#!/usr/bin/env bun
// Harness dashboard HTTP shim — receives CI webhooks on :4848 and spawns
// .agents/ci-watchdog.sh. Intelligence lives in the script; this file is ~40 lines
// of routing + signature verify per ticket #0005.

import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { findRepoEntry, loadHarnessConfig } from './harness-config'
import { verifyWebhookSignature } from './verify-signature'
import { spawnCiWatchdog } from './spawn-watchdog'
import { readBodyLimited } from './read-body'
import { shouldSpawnWatchdog, extractCiEnv, type GitLabPipelinePayload } from './ci-pipeline'

export const DEFAULT_PORT = 4848

export type { GitLabPipelinePayload }
export { shouldSpawnWatchdog, extractCiEnv }

export function createApp() {
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true }))

  app.post('/api/ci-webhook/:repo', async (c) => {
    const repo = c.req.param('repo')
    const entry = findRepoEntry(repo, loadHarnessConfig())
    if (!entry) return c.json({ ok: false, error: 'unknown repo or no secret configured' }, 404)
    if (!existsSync(entry.root)) return c.json({ ok: false, error: 'repo root missing' }, 404)

    const bodyRead = await readBodyLimited(c.req.raw)
    if (!bodyRead.ok) {
      if (bodyRead.error === 'too_large') {
        return c.json({ ok: false, error: 'payload too large' }, 413)
      }
      return c.json({ ok: false, error: 'bad body' }, 400)
    }
    const rawBody = bodyRead.text

    const verified = verifyWebhookSignature(rawBody, {
      github: c.req.header('X-Hub-Signature-256'),
      gitlab: c.req.header('X-Gitlab-Token'),
    }, entry.ciWebhookSecret)
    if (!verified.ok) return c.json({ ok: false, error: verified.reason }, 401)

    let payload: GitLabPipelinePayload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return c.json({ ok: false, error: 'invalid json' }, 400)
    }

    if (shouldSpawnWatchdog(payload)) {
      const ci = extractCiEnv(payload)
      // Ack the webhook even when pipeline id is missing — avoids retry storms.
      if (ci.pipelineId) {
        const spawned = spawnCiWatchdog({
          repoRoot: entry.root,
          pipelineId: ci.pipelineId,
          mrIid: ci.mrIid,
          branch: ci.branch,
        })
        if (!spawned.ok) return c.json({ ok: false, error: spawned.error }, 500)
      }
    }

    return c.json({ ok: true })
  })

  return app
}

export function startServer(port = DEFAULT_PORT) {
  const app = createApp()
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  })
  console.log(`[dashboard] CI webhook listening on 127.0.0.1:${server.port}`)
  return server
}

if (import.meta.main) {
  const port = Number(process.env.DASHBOARD_PORT || DEFAULT_PORT)
  try {
    startServer(port)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      console.log(`[dashboard] :${port} already in use — assuming another instance`)
      process.exit(0)
    }
    throw e
  }
}

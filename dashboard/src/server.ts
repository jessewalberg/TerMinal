#!/usr/bin/env bun
// Harness dashboard HTTP shim — receives CI webhooks on :4848 and spawns
// .agents/ci-watchdog.sh. Intelligence lives in the script; this file is ~40 lines
// of routing + signature verify per ticket #0005.

import { Hono } from 'hono'
import { repoRootFor, webhookSecretFor } from './harness-config'
import { verifyWebhookSignature } from './verify-signature'
import { spawnCiWatchdog } from './spawn-watchdog'

export const DEFAULT_PORT = 4848

export type GitLabPipelinePayload = {
  object_kind?: string
  object_attributes?: { id?: number; ref?: string; status?: string }
  merge_request?: { iid?: number }
}

export function createApp() {
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true }))

  app.post('/api/ci-webhook/:repo', async (c) => {
    const repo = c.req.param('repo')
    const secret = webhookSecretFor(repo)
    if (!secret) return c.json({ ok: false, error: 'unknown repo or no secret configured' }, 404)

    const rawBody = await c.req.text()
    const verified = verifyWebhookSignature(rawBody, {
      github: c.req.header('X-Hub-Signature-256'),
      gitlab: c.req.header('X-Gitlab-Token'),
    }, secret)
    if (!verified.ok) return c.json({ ok: false, error: verified.reason }, 401)

    let payload: GitLabPipelinePayload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return c.json({ ok: false, error: 'invalid json' }, 400)
    }

    if (payload.object_kind === 'pipeline' && payload.object_attributes?.status === 'failed') {
      const repoRoot = repoRootFor(repo)
      if (!repoRoot) return c.json({ ok: false, error: 'repo root not configured' }, 404)

      const spawned = spawnCiWatchdog({
        repoRoot,
        pipelineId: String(payload.object_attributes.id ?? ''),
        mrIid: String(payload.merge_request?.iid ?? ''),
        branch: payload.object_attributes.ref ?? '',
      })
      if (!spawned.ok) return c.json({ ok: false, error: spawned.error }, 500)
    }

    return c.json({ ok: true })
  })

  return app
}

export function startServer(port = DEFAULT_PORT) {
  const app = createApp()
  const server = Bun.serve({ port, fetch: app.fetch })
  console.log(`[dashboard] CI webhook listening on :${server.port}`)
  return server
}

if (import.meta.main) {
  const port = Number(process.env.DASHBOARD_PORT || DEFAULT_PORT)
  startServer(port)
}

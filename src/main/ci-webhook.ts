// GitLab (or compatible) CI pipeline webhook receiver. Listens on :4848 when
// TerMinal is running; verifies per-repo secret; spawns .agents/ci-watchdog.sh
// detached for failed pipelines. See ADR-0003 — lives in main, not a separate
// dashboard server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { spawn as cpSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { loadCiWebhookRepos, repoRootFor, secretForRepo } from './ci-webhook-config'

const TERMINAL_BIN = join(homedir(), '.config', 'TerMinal', 'bin')
const GLOBAL_SCRIPTS_DIR = join(homedir(), '.config', 'TerMinal', 'scripts')
const LOG_DIR = join(homedir(), '.config', 'TerMinal', 'ci-webhook-spawns')
const DEFAULT_PORT = 4848
/** GitLab pipeline webhook JSON is small; cap body reads to avoid memory exhaustion. */
const MAX_BODY_BYTES = 256 * 1024

export { repoRootFor, secretForRepo, loadCiWebhookRepos } from './ci-webhook-config'

function locateWatchdogScript(repoRoot: string): string | null {
  const perRepo = join(repoRoot, '.agents', 'ci-watchdog.sh')
  if (existsSync(perRepo)) return perRepo
  const global = join(GLOBAL_SCRIPTS_DIR, 'ci-watchdog.sh')
  if (existsSync(global)) return global
  return null
}

export type GitLabPipelinePayload = {
  object_kind?: string
  status?: string
  object_attributes?: { id?: number; ref?: string; status?: string }
  merge_request?: { iid?: number }
}

/** True when this payload should trigger ci-watchdog. */
export function shouldSpawnWatchdog(payload: GitLabPipelinePayload): boolean {
  if (payload.object_kind !== 'pipeline') return false
  const status = payload.status ?? payload.object_attributes?.status
  return status === 'failed'
}

export function extractCiEnv(payload: GitLabPipelinePayload): {
  CI_PIPELINE_ID: string
  CI_MR_IID: string
  CI_BRANCH: string
} {
  return {
    CI_PIPELINE_ID: String(payload.object_attributes?.id ?? ''),
    CI_MR_IID: String(payload.merge_request?.iid ?? ''),
    CI_BRANCH: String(payload.object_attributes?.ref ?? ''),
  }
}

/** Verify GitLab secret token or GitHub-style HMAC-SHA256 signature. */
export function verifyCiWebhookAuth(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  body: Buffer,
): boolean {
  if (!secret) return false
  const token = headerValue(headers, 'x-gitlab-token')
  if (token && safeEqual(token, secret)) return true
  const sig = headerValue(headers, 'x-hub-signature-256')
  if (sig?.startsWith('sha256=')) {
    const expected = createHmac('sha256', secret).update(body).digest('hex')
    const got = sig.slice('sha256='.length)
    if (got.length === expected.length) {
      try {
        return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'))
      } catch {
        return false
      }
    }
  }
  return false
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  try {
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (c) => {
      if (rejected) return
      size += c.length
      if (size > maxBytes) {
        rejected = true
        reject(new Error('body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export type SpawnWatchdogFn = (opts: {
  repoRoot: string
  env: NodeJS.ProcessEnv
}) => ChildProcess | null

/** Default detached spawn — overridable in tests. */
export function defaultSpawnWatchdog(opts: {
  repoRoot: string
  env: NodeJS.ProcessEnv
}): ChildProcess | null {
  const script = locateWatchdogScript(opts.repoRoot)
  if (!script) return null
  mkdirSync(LOG_DIR, { recursive: true })
  const logFile = join(LOG_DIR, `${Date.now()}-${basename(opts.repoRoot)}.log`)
  const out = openSync(logFile, 'a')
  const child = cpSpawn(script, [], {
    cwd: opts.repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
    env: opts.env,
  })
  child.unref()
  return child
}

export type CiWebhookDeps = {
  secretForRepo: (slug: string) => string | null
  repoRootFor: (slug: string) => string | null
  spawnFn: SpawnWatchdogFn
}

export async function handleCiWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repoSlug: string,
  deps: Partial<CiWebhookDeps> = {},
): Promise<void> {
  const repos = deps.secretForRepo || deps.repoRootFor ? null : loadCiWebhookRepos()
  const secretFn = deps.secretForRepo ?? ((slug: string) => secretForRepo(slug, repos ?? undefined))
  const rootFn = deps.repoRootFor ?? ((slug: string) => repoRootFor(slug, repos ?? undefined))
  const spawnFn = deps.spawnFn ?? defaultSpawnWatchdog
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const secret = secretFn(repoSlug)
  if (!secret) {
    json(res, 404, { ok: false, error: 'unknown repo' })
    return
  }
  const root = rootFn(repoSlug)
  if (!root || !existsSync(root)) {
    json(res, 404, { ok: false, error: 'repo root missing' })
    return
  }
  let body: Buffer
  try {
    body = await readBody(req)
  } catch (e) {
    const msg = (e as Error).message
    if (msg === 'body too large') {
      json(res, 413, { ok: false, error: 'payload too large' })
      return
    }
    json(res, 400, { ok: false, error: 'bad body' })
    return
  }
  if (!verifyCiWebhookAuth(req.headers, secret, body)) {
    json(res, 401, { ok: false, error: 'unauthorized' })
    return
  }
  let payload: GitLabPipelinePayload
  try {
    payload = JSON.parse(body.toString('utf8')) as GitLabPipelinePayload
  } catch {
    json(res, 400, { ok: false, error: 'invalid json' })
    return
  }
  if (shouldSpawnWatchdog(payload)) {
    const ci = extractCiEnv(payload)
    spawnFn({
      repoRoot: root,
      env: {
        ...process.env,
        PATH: `${TERMINAL_BIN}:${process.env.PATH || ''}`,
        TERMINAL_REPO: root,
        TERMINAL_AGENT_ID: 'ci-watchdog',
        ...ci,
      },
    })
  }
  json(res, 200, { ok: true })
}

let server: Server | null = null

export function startCiWebhookServer(port = DEFAULT_PORT): Server | null {
  if (server) return server
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      const match = url.pathname.match(/^\/api\/ci-webhook\/([^/]+)$/)
      if (!match) {
        json(res, 404, { ok: false, error: 'not found' })
        return
      }
      await handleCiWebhookRequest(req, res, decodeURIComponent(match[1]))
    } catch (e) {
      json(res, 500, { ok: false, error: (e as Error).message })
    }
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Another TerMinal instance or local service owns :4848 — skip rather than crash.
      server = null
      return
    }
    throw err
  })
  server.listen(port, '127.0.0.1')
  return server
}

export function stopCiWebhookServer(): void {
  server?.close()
  server = null
}

import { test, expect, describe } from 'bun:test'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { parsePrsConfigYaml } from './ci-webhook-config'
import {
  verifyCiWebhookAuth,
  shouldSpawnWatchdog,
  extractCiEnv,
  handleCiWebhookRequest,
} from './ci-webhook'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChildProcess } from 'node:child_process'

describe('parsePrsConfigYaml', () => {
  test('reads repos block with root + secret', () => {
    const yaml = `
repos:
  TerMinal:
    root: /Users/me/TerMinal
    ci_webhook_secret: sekrit
  emails:
    root: /Users/me/emails
    ci_webhook_secret: other
`
    const parsed = parsePrsConfigYaml(yaml)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({
      slug: 'TerMinal',
      root: '/Users/me/TerMinal',
      ci_webhook_secret: 'sekrit',
    })
  })

  test('strips inline comments from values', () => {
    const yaml = `
repos:
  TerMinal:
    root: /Users/me/TerMinal
    ci_webhook_secret: sekrit # gitlab token
`
    expect(parsePrsConfigYaml(yaml)[0].ci_webhook_secret).toBe('sekrit')
  })
})

describe('verifyCiWebhookAuth', () => {
  const secret = 'test-secret'
  const body = Buffer.from('{"object_kind":"pipeline"}')

  test('accepts matching X-Gitlab-Token', () => {
    expect(verifyCiWebhookAuth({ 'x-gitlab-token': secret }, secret, body)).toBe(true)
  })

  test('rejects wrong token', () => {
    expect(verifyCiWebhookAuth({ 'x-gitlab-token': 'wrong' }, secret, body)).toBe(false)
  })

  test('accepts valid HMAC signature', () => {
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    expect(verifyCiWebhookAuth({ 'x-hub-signature-256': sig }, secret, body)).toBe(true)
  })
})

describe('shouldSpawnWatchdog', () => {
  test('fires only on failed pipeline', () => {
    expect(
      shouldSpawnWatchdog({
        object_kind: 'pipeline',
        status: 'failed',
        object_attributes: { id: 1, ref: 'feat/x' },
      }),
    ).toBe(true)
    expect(shouldSpawnWatchdog({ object_kind: 'pipeline', status: 'success' })).toBe(false)
    expect(shouldSpawnWatchdog({ object_kind: 'push', status: 'failed' })).toBe(false)
  })

  test('reads status from object_attributes when top-level status absent', () => {
    expect(
      shouldSpawnWatchdog({
        object_kind: 'pipeline',
        object_attributes: { id: 1, ref: 'main', status: 'failed' },
      }),
    ).toBe(true)
    expect(
      shouldSpawnWatchdog({
        object_kind: 'pipeline',
        object_attributes: { id: 1, status: 'success' },
      }),
    ).toBe(false)
  })
})

describe('extractCiEnv', () => {
  test('maps pipeline fields to env vars', () => {
    expect(
      extractCiEnv({
        object_attributes: { id: 99, ref: 'agent/foo' },
        merge_request: { iid: 12 },
      }),
    ).toEqual({
      CI_PIPELINE_ID: '99',
      CI_MR_IID: '12',
      CI_BRANCH: 'agent/foo',
    })
  })
})

function mockResponse() {
  let status = 0
  let responseBody = ''
  const res = {
    writeHead: (s: number) => {
      status = s
    },
    end: (chunk: string) => {
      responseBody = chunk
    },
  } as unknown as ServerResponse
  return {
    res,
    get: () => ({ status, body: JSON.parse(responseBody || '{}') }),
  }
}

function mockRequest(body: Buffer, headers: Record<string, string>, method = 'POST'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  req.method = method
  req.headers = headers
  queueMicrotask(() => {
    req.emit('data', body)
    req.emit('end')
  })
  return req
}

describe('handleCiWebhookRequest', () => {
  const root = process.cwd()
  const secret = 'hook-secret'
  const deps = {
    secretForRepo: (slug: string) => (slug === 'TerMinal' ? secret : null),
    repoRootFor: (slug: string) => (slug === 'TerMinal' ? root : null),
  }

  test('spawns watchdog on verified failed pipeline', async () => {
    let spawned = false
    const payload = {
      object_kind: 'pipeline',
      status: 'failed',
      object_attributes: { id: 42, ref: 'fix/ci', status: 'failed' },
      merge_request: { iid: 7 },
    }
    const body = Buffer.from(JSON.stringify(payload))
    const req = mockRequest(body, { 'x-gitlab-token': secret })
    const { res, get } = mockResponse()

    await handleCiWebhookRequest(req, res, 'TerMinal', {
      ...deps,
      spawnFn: () => {
        spawned = true
        return {} as ChildProcess
      },
    })

    expect(get().status).toBe(200)
    expect(get().body).toEqual({ ok: true })
    expect(spawned).toBe(true)
  })

  test('rejects bad auth without spawning', async () => {
    let spawned = false
    const body = Buffer.from('{}')
    const req = mockRequest(body, { 'x-gitlab-token': 'bad' })
    const { res, get } = mockResponse()

    await handleCiWebhookRequest(req, res, 'TerMinal', {
      ...deps,
      spawnFn: () => {
        spawned = true
        return {} as ChildProcess
      },
    })

    expect(get().status).toBe(401)
    expect(spawned).toBe(false)
  })

  test('does not spawn on successful pipeline', async () => {
    let spawned = false
    const payload = { object_kind: 'pipeline', status: 'success', object_attributes: { id: 1 } }
    const body = Buffer.from(JSON.stringify(payload))
    const req = mockRequest(body, { 'x-gitlab-token': secret })
    const { res, get } = mockResponse()

    await handleCiWebhookRequest(req, res, 'TerMinal', {
      ...deps,
      spawnFn: () => {
        spawned = true
        return {} as ChildProcess
      },
    })

    expect(get().status).toBe(200)
    expect(spawned).toBe(false)
  })

  test('passes CI env vars to spawn', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    const payload = {
      object_kind: 'pipeline',
      object_attributes: { id: 42, ref: 'fix/ci', status: 'failed' },
      merge_request: { iid: 7 },
    }
    const body = Buffer.from(JSON.stringify(payload))
    const req = mockRequest(body, { 'x-gitlab-token': secret })
    const { res } = mockResponse()

    await handleCiWebhookRequest(req, res, 'TerMinal', {
      ...deps,
      spawnFn: ({ env }) => {
        capturedEnv = env
        return {} as ChildProcess
      },
    })

    expect(capturedEnv?.CI_PIPELINE_ID).toBe('42')
    expect(capturedEnv?.CI_MR_IID).toBe('7')
    expect(capturedEnv?.CI_BRANCH).toBe('fix/ci')
    expect(capturedEnv?.TERMINAL_REPO).toBe(root)
    expect(capturedEnv?.TERMINAL_AGENT_ID).toBe('ci-watchdog')
  })

  test('rejects unknown repo', async () => {
    const body = Buffer.from('{}')
    const req = mockRequest(body, { 'x-gitlab-token': secret })
    const { res, get } = mockResponse()

    await handleCiWebhookRequest(req, res, 'unknown-slug', deps)

    expect(get().status).toBe(404)
  })

  test('rejects GET', async () => {
    const req = mockRequest(Buffer.from(''), { 'x-gitlab-token': secret }, 'GET')
    const { res, get } = mockResponse()

    await handleCiWebhookRequest(req, res, 'TerMinal', deps)

    expect(get().status).toBe(405)
  })

  test('rejects invalid json', async () => {
    const body = Buffer.from('not-json')
    const req = mockRequest(body, { 'x-gitlab-token': secret })
    const { res, get } = mockResponse()

    await handleCiWebhookRequest(req, res, 'TerMinal', deps)

    expect(get().status).toBe(400)
    expect(get().body.error).toBe('invalid json')
  })

  test('rejects oversized body', async () => {
    const req = new EventEmitter() as IncomingMessage
    req.method = 'POST'
    req.headers = { 'x-gitlab-token': secret }
    const { res, get } = mockResponse()

    const p = handleCiWebhookRequest(req, res, 'TerMinal', deps)
    req.emit('data', Buffer.alloc(300 * 1024))
    await p

    expect(get().status).toBe(413)
  })
})

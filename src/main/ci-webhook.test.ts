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
})

import { test, expect, describe } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifyGithubSignature, verifyGitlabToken, verifyWebhookSignature } from './verify-signature'

describe('verifyGithubSignature', () => {
  test('accepts valid HMAC', () => {
    const body = '{"object_kind":"pipeline"}'
    const secret = 's3cret'
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    expect(verifyGithubSignature(body, sig, secret).ok).toBe(true)
  })

  test('rejects bad signature', () => {
    expect(verifyGithubSignature('{}', 'sha256=deadbeef', 's3cret').ok).toBe(false)
  })
})

describe('verifyGitlabToken', () => {
  test('accepts matching token', () => {
    expect(verifyGitlabToken('tok', 'tok').ok).toBe(true)
  })

  test('rejects mismatch', () => {
    expect(verifyGitlabToken('wrong', 'tok').ok).toBe(false)
  })
})

describe('verifyWebhookSignature', () => {
  test('routes to github when X-Hub-Signature-256 present', () => {
    const body = '{}'
    const secret = 'x'
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    expect(verifyWebhookSignature(body, { github: sig }, secret).ok).toBe(true)
  })

  test('routes to gitlab when X-Gitlab-Token present', () => {
    expect(verifyWebhookSignature('{}', { gitlab: 't' }, 't').ok).toBe(true)
  })
})

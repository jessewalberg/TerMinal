import { test, expect, describe } from 'bun:test'
import { readBodyLimited, MAX_BODY_BYTES } from './read-body'

describe('readBodyLimited', () => {
  test('reads a small body', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: '{"ok":true}',
    })
    const result = await readBodyLimited(req)
    expect(result).toEqual({ ok: true, text: '{"ok":true}' })
  })

  test('rejects bodies over the cap', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1)
    const req = new Request('http://localhost/', { method: 'POST', body: big })
    const result = await readBodyLimited(req)
    expect(result).toEqual({ ok: false, error: 'too_large' })
  })
})

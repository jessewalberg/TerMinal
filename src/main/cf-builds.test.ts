import { test, expect, describe } from 'bun:test'
import { workerNameFromWrangler, selectNewDeployments } from './cf-builds'

describe('workerNameFromWrangler', () => {
  test('reads name from wrangler.jsonc (comments tolerated)', () => {
    const jsonc = '{\n  // the worker\n  "name": "ping-worker",\n  "main": "src/index.ts"\n}'
    expect(workerNameFromWrangler(jsonc)).toBe('ping-worker')
  })

  test('reads name from wrangler.toml', () => {
    expect(workerNameFromWrangler('name = "astro-site"\nmain = "x"\n')).toBe('astro-site')
  })

  test('no name → empty string', () => {
    expect(workerNameFromWrangler('{ "main": "x" }')).toBe('')
  })
})

describe('selectNewDeployments', () => {
  test('returns only unseen ids, preserving order', () => {
    const deps = [{ id: 'c' }, { id: 'b' }, { id: 'a' }]
    expect(selectNewDeployments(deps, ['a']).map((d) => d.id)).toEqual(['c', 'b'])
  })

  test('all seen → none (idempotent re-poll)', () => {
    expect(selectNewDeployments([{ id: 'a' }, { id: 'b' }], ['a', 'b'])).toEqual([])
  })
})

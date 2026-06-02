import { describe, expect, test } from 'bun:test'
import { filterSessions } from './sessionSearch'
import type { SessionMeta } from './types'

const s = (over: Partial<SessionMeta>): SessionMeta => ({
  id: 'x',
  engine: 'claude',
  cwd: '',
  gitBranch: '',
  model: '',
  turns: 0,
  firstUserText: '',
  mtime: 0,
  ...over,
})

describe('filterSessions', () => {
  const list = [
    s({ id: 'a', firstUserText: 'debug the auth flow', cwd: '/p/web', gitBranch: 'main' }),
    s({ id: 'b', firstUserText: 'add billing', cwd: '/p/api', gitBranch: 'feat/stripe' }),
    s({ id: 'c', firstUserText: 'fix tests', cwd: '/p/web', gitBranch: 'fix/ci' }),
  ]

  test('empty / whitespace query returns the same list reference', () => {
    expect(filterSessions(list, '')).toBe(list)
    expect(filterSessions(list, '   ')).toBe(list)
  })

  test('matches prompt text, case-insensitively', () => {
    expect(filterSessions(list, 'AUTH').map((x) => x.id)).toEqual(['a'])
  })

  test('matches cwd', () => {
    expect(filterSessions(list, '/p/web').map((x) => x.id)).toEqual(['a', 'c'])
  })

  test('matches branch', () => {
    expect(filterSessions(list, 'stripe').map((x) => x.id)).toEqual(['b'])
  })

  test('no match → empty', () => {
    expect(filterSessions(list, 'zzz')).toEqual([])
  })
})

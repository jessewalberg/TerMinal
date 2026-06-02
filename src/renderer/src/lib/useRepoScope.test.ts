import { describe, expect, test } from 'bun:test'
import { initialRepoScope, repoBasename } from './useRepoScope'

describe('initialRepoScope', () => {
  test('defaults a fresh window to its current repo', () => {
    expect(initialRepoScope({ stored: null, currentRepo: 'TerMinal' })).toBe('TerMinal')
  })

  test('respects an explicit stored "all repos" ("") choice over the default', () => {
    // '' is the user deliberately choosing all-repos; it must NOT fall back.
    expect(initialRepoScope({ stored: '', currentRepo: 'TerMinal' })).toBe('')
  })

  test('respects a stored pick of another repo', () => {
    expect(initialRepoScope({ stored: 'project-template', currentRepo: 'TerMinal' })).toBe(
      'project-template',
    )
  })

  test('falls back to all-repos when there is no current repo and nothing stored', () => {
    expect(initialRepoScope({ stored: null, currentRepo: '' })).toBe('')
  })
})

describe('repoBasename', () => {
  test('takes the last path segment, ignoring trailing slashes', () => {
    expect(repoBasename('/Volumes/home-ext/projects/TerMinal')).toBe('TerMinal')
    expect(repoBasename('/Volumes/home-ext/projects/TerMinal/')).toBe('TerMinal')
  })

  test('is empty for an empty path', () => {
    expect(repoBasename('')).toBe('')
  })
})

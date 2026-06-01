import { describe, it, expect } from 'bun:test'
import { pickDefaultEngine, underDir } from './pickDefaultEngine'
import type { Engine, SessionMeta } from './types'

const mk = (engine: Engine, cwd: string, mtime = 0): SessionMeta => ({
  id: `${engine}-${mtime}`,
  engine,
  cwd,
  gitBranch: '',
  model: '',
  turns: 1,
  firstUserText: '',
  mtime,
})

describe('underDir', () => {
  it('matches the dir itself and nested paths, not siblings', () => {
    expect(underDir('/a/b', '/a/b')).toBe(true)
    expect(underDir('/a/b/c', '/a/b')).toBe(true)
    expect(underDir('/a/bc', '/a/b')).toBe(false)
    expect(underDir('/x', '/a/b')).toBe(false)
  })
})

describe('pickDefaultEngine', () => {
  it('falls back to claude for an empty list — never local', () => {
    expect(pickDefaultEngine([])).toBe('claude')
  })

  it('uses the newest session engine (list is sorted newest-first)', () => {
    expect(pickDefaultEngine([mk('codex', '/a'), mk('claude', '/b')])).toBe('codex')
    expect(pickDefaultEngine([mk('claude', '/a'), mk('codex', '/b')])).toBe('claude')
  })

  it('prefers the newest session under a locked cwd', () => {
    const sessions = [mk('claude', '/repos/x'), mk('codex', '/repos/y'), mk('codex', '/repos/y/sub')]
    expect(pickDefaultEngine(sessions, '/repos/y')).toBe('codex')
  })

  it('falls back to the newest overall engine when nothing matches the locked cwd', () => {
    const sessions = [mk('codex', '/repos/x'), mk('claude', '/repos/y')]
    expect(pickDefaultEngine(sessions, '/repos/none')).toBe('codex')
  })

  it('never returns local even with a single claude session (the old hardcoded default)', () => {
    expect(pickDefaultEngine([mk('claude', '/a')])).not.toBe('local')
  })
})

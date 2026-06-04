import { describe, expect, test } from 'bun:test'
import { resolveSessionCwd } from './session-cwd'

const HOME = '/Users/me'

describe('resolveSessionCwd', () => {
  test('empty request falls back to home without flagging a fallback', () => {
    expect(resolveSessionCwd(undefined, () => true, HOME)).toEqual({ cwd: HOME, fellBack: false })
    expect(resolveSessionCwd('', () => true, HOME)).toEqual({ cwd: HOME, fellBack: false })
  })

  test('existing cwd is used as-is', () => {
    const exists = (p: string) => p === '/repos/app'
    expect(resolveSessionCwd('/repos/app', exists, HOME)).toEqual({
      cwd: '/repos/app',
      fellBack: false,
    })
  })

  test('missing cwd falls back to nearest existing ancestor (renamed project)', () => {
    // /Volumes/x/projects/gauntlet exists, the renamed project dir does not
    const exists = (p: string) =>
      ['/Volumes/x', '/Volumes/x/projects', '/Volumes/x/projects/gauntlet'].includes(p)
    expect(resolveSessionCwd('/Volumes/x/projects/gauntlet/old-name', exists, HOME)).toEqual({
      cwd: '/Volumes/x/projects/gauntlet',
      fellBack: true,
      requested: '/Volumes/x/projects/gauntlet/old-name',
    })
  })

  test('walks multiple missing levels to the surviving ancestor', () => {
    const exists = (p: string) => p === '/Volumes/x'
    expect(resolveSessionCwd('/Volumes/x/a/b/c', exists, HOME)).toEqual({
      cwd: '/Volumes/x',
      fellBack: true,
      requested: '/Volumes/x/a/b/c',
    })
  })

  test('prefers home over bare root when nothing below / survives (unmounted volume)', () => {
    const exists = (p: string) => p === '/'
    expect(resolveSessionCwd('/Volumes/gone/repo', exists, HOME)).toEqual({
      cwd: HOME,
      fellBack: true,
      requested: '/Volumes/gone/repo',
    })
  })
})

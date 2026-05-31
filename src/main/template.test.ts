import { test, expect, describe } from 'bun:test'
import { isTemplateUrl, pickTemplateSource } from './template'

describe('isTemplateUrl', () => {
  test('true for scheme:// urls', () => {
    expect(isTemplateUrl('https://github.com/trevormil/project-template')).toBe(true)
    expect(isTemplateUrl('http://example.com/x')).toBe(true)
    expect(isTemplateUrl('ssh://git@host/x')).toBe(true)
  })
  test('false for local paths and scp-style git remotes', () => {
    expect(isTemplateUrl('/Volumes/home-ext/projects/TerMinal/templates/project-template')).toBe(false)
    expect(isTemplateUrl('~/project-template')).toBe(false)
    expect(isTemplateUrl('git@github.com:trevormil/project-template')).toBe(false) // scp-style, not scheme://
  })
})

describe('pickTemplateSource', () => {
  const presentIn = (dirs: string[]) => (dir: string) => dirs.includes(dir)

  test('returns the first local candidate that has bootstrap.sh and never clones', () => {
    let cloned = false
    const r = pickTemplateSource({
      candidates: ['/a', '/b', '/c'],
      hasBootstrap: presentIn(['/b', '/c']),
      templateRepo: 'https://example.com/repo',
      cloneToTmp: () => {
        cloned = true
        return { dir: '/tmp/x', cleanup() {} }
      },
    })
    expect(r).toEqual({ dir: '/b' })
    expect(cloned).toBe(false)
  })

  test('clones to a tmp dir when no local candidate has bootstrap.sh (the packaged-app path)', () => {
    const cleanup = () => {}
    const r = pickTemplateSource({
      candidates: ['/a', '/b'],
      hasBootstrap: presentIn([]),
      templateRepo: 'https://example.com/repo',
      cloneToTmp: (repo) => {
        expect(repo).toBe('https://example.com/repo')
        return { dir: '/tmp/clone', cleanup }
      },
    })
    expect(r).toEqual({ dir: '/tmp/clone', cleanup })
  })

  test('errors when no local candidate and no templateRepo to clone', () => {
    const r = pickTemplateSource({
      candidates: ['/a'],
      hasBootstrap: presentIn([]),
      templateRepo: '',
      cloneToTmp: () => {
        throw new Error('should not clone when templateRepo is empty')
      },
    })
    expect('error' in r).toBe(true)
  })

  test('errors when the clone falls through (cloneToTmp returns null)', () => {
    const r = pickTemplateSource({
      candidates: [],
      hasBootstrap: presentIn([]),
      templateRepo: 'https://example.com/repo',
      cloneToTmp: () => null,
    })
    expect('error' in r).toBe(true)
  })
})

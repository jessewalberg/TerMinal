import { test, expect, describe } from 'bun:test'
import {
  isTemplateUrl,
  pickTemplateSource,
  sourceCheckoutRoot,
  templateDirCandidates,
  cloneTemplateToTmp,
} from './template'

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

describe('sourceCheckoutRoot', () => {
  test('returns empty when no candidate contains the marker', () => {
    expect(sourceCheckoutRoot(['/no/such/path'], 'bin/release')).toBe('')
  })
})

describe('cloneTemplateToTmp', () => {
  test('rejects repo strings that look like git options', () => {
    expect(
      cloneTemplateToTmp('--config=core.sshCommand=evil', {
        tmpPrefix: 'gt-test-',
        marker: 'bootstrap.sh',
      }),
    ).toBeNull()
  })
})

describe('templateDirCandidates', () => {
  test('includes configured local path and submodule dirs under each root', () => {
    expect(
      templateDirCandidates('/local/template', ['/repo', '/other']),
    ).toEqual(['/local/template', '/repo/templates/project-template', '/other/templates/project-template'])
  })
  test('skips URL configured repos (clone path handles those)', () => {
    expect(templateDirCandidates('https://github.com/x/y', ['/repo'])).toEqual([
      '/repo/templates/project-template',
    ])
  })
})

describe('pickTemplateSource', () => {
  const presentIn = (dirs: string[]) => (_dir: string, marker: string) =>
    dirs.includes(`${_dir}/${marker}`)

  test('returns the first local candidate that has the marker and never clones', () => {
    let cloned = false
    const r = pickTemplateSource({
      candidates: ['/a', '/b', '/c'],
      marker: 'bootstrap.sh',
      hasMarker: presentIn(['/b/bootstrap.sh', '/c/bootstrap.sh']),
      templateRepo: 'https://example.com/repo',
      cloneToTmp: () => {
        cloned = true
        return { dir: '/tmp/x', cleanup() {} }
      },
    })
    expect(r).toEqual({ dir: '/b' })
    expect(cloned).toBe(false)
  })

  test('calls onLocalPick when a local candidate wins', () => {
    let refreshed: string | null = null
    pickTemplateSource({
      candidates: ['/local'],
      marker: 'bootstrap.sh',
      hasMarker: presentIn(['/local/bootstrap.sh']),
      templateRepo: '',
      cloneToTmp: () => null,
      onLocalPick: (dir) => {
        refreshed = dir
      },
    })
    expect(refreshed).toBe('/local')
  })

  test('does not call onLocalPick when cloning', () => {
    let refreshed = false
    pickTemplateSource({
      candidates: [],
      marker: '.agents',
      hasMarker: () => false,
      templateRepo: 'https://example.com/repo',
      cloneToTmp: () => ({ dir: '/tmp/clone', cleanup() {} }),
      onLocalPick: () => {
        refreshed = true
      },
    })
    expect(refreshed).toBe(false)
  })

  test('clones to a tmp dir when no local candidate has the marker (the packaged-app path)', () => {
    const cleanup = () => {}
    const r = pickTemplateSource({
      candidates: ['/a', '/b'],
      marker: 'bootstrap.sh',
      hasMarker: () => false,
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
      marker: 'bootstrap.sh',
      hasMarker: () => false,
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
      marker: '.agents',
      hasMarker: () => false,
      templateRepo: 'https://example.com/repo',
      cloneToTmp: () => null,
    })
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('.agents')
  })

  test('errors when templateRepo looks like a git option (injected cloneToTmp)', () => {
    const r = pickTemplateSource({
      candidates: [],
      marker: 'bootstrap.sh',
      hasMarker: () => false,
      templateRepo: '--upload-pack=evil',
      cloneToTmp: (repo) => cloneTemplateToTmp(repo, { tmpPrefix: 'gt-test-', marker: 'bootstrap.sh' }),
    })
    expect('error' in r).toBe(true)
  })
})

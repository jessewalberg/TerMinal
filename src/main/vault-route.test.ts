import { test, expect, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveRoute, dirsForSlug } from '../../bin/lib/vault-route.mjs'

const DEFAULT_VAULT = '/Volumes/home-ext/projects/programming-vault'

describe('vault-route resolveRoute', () => {
  test('default: slug = basename, mode vault, default vaultPath', () => {
    expect(resolveRoute('/x/journeyman', {}, {})).toEqual({
      mode: 'vault',
      vaultPath: DEFAULT_VAULT,
      slug: 'journeyman',
    })
  })

  test('vaultPath precedence: env GT_VAULT_PATH > settings.vaultPath > default', () => {
    expect(
      resolveRoute('/x/journeyman', { vaultPath: '/from/settings' }, { GT_VAULT_PATH: '/from/env' })
        .vaultPath,
    ).toBe('/from/env')
    expect(resolveRoute('/x/journeyman', { vaultPath: '/from/settings' }, {}).vaultPath).toBe(
      '/from/settings',
    )
    expect(resolveRoute('/x/journeyman', {}, {}).vaultPath).toBe(DEFAULT_VAULT)
  })

  test('slug exceptions (Schema naming rules)', () => {
    expect(resolveRoute('/x/how-we-homeschool', {}, {}).slug).toBe('howwehomeschool')
    expect(resolveRoute('/x/weekly-commits', {}, {}).slug).toBe('15five')
    expect(resolveRoute('/x/childcare-transparency', {}, {}).slug).toBe('howverydareyou')
    // -hitl is deliberately its own vault project (Schema)
    expect(resolveRoute('/x/jessewalberg.com-hitl', {}, {}).slug).toBe('jessewalberg.com-hitl')
    expect(resolveRoute('/x/TerMinal', {}, {}).slug).toBe('TerMinal')
  })

  test('symlinked checkout resolves through realpath to its target basename', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gt-route-'))
    mkdirSync(join(tmp, 'howverydareyou'))
    symlinkSync(join(tmp, 'howverydareyou'), join(tmp, 'some-link-name'))
    expect(resolveRoute(join(tmp, 'some-link-name'), {}, {}).slug).toBe('howverydareyou')
    rmSync(tmp, { recursive: true, force: true })
  })

  test('owner carve-out lists drive mode — never inferred', () => {
    const settings = {
      vaultCarveOuts: { template: ['15five'], collaborator: ['howverydareyou'] },
    }
    expect(resolveRoute('/x/weekly-commits', settings, {}).mode).toBe('template')
    expect(resolveRoute('/x/childcare-transparency', settings, {}).mode).toBe('collaborator')
    expect(resolveRoute('/x/journeyman', settings, {}).mode).toBe('vault')
    // jessewalberg.com is org theroomofrequirement AND vault-mode — org is not a signal
    expect(resolveRoute('/x/jessewalberg.com', settings, {}).mode).toBe('vault')
  })
})

describe('vault-route dirsForSlug (reverse map)', () => {
  test('one-to-many, existence-filtered', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gt-dirs-'))
    mkdirSync(join(tmp, 'jessewalberg.com'))
    mkdirSync(join(tmp, 'jessewalberg.com-hitl'))
    expect(dirsForSlug('jessewalberg.com', { projectsDir: tmp })).toEqual([
      join(tmp, 'jessewalberg.com'),
      join(tmp, 'jessewalberg.com-hitl'),
    ])
    // candidates that don't exist on disk are filtered out
    expect(dirsForSlug('howwehomeschool', { projectsDir: tmp })).toEqual([])
    // default slug → its own dir when present
    mkdirSync(join(tmp, 'journeyman'))
    expect(dirsForSlug('journeyman', { projectsDir: tmp })).toEqual([join(tmp, 'journeyman')])
    rmSync(tmp, { recursive: true, force: true })
  })
})

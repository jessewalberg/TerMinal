import { test, expect, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// End-to-end MCP contract (review finding): file_ticket → update_ticket must
// round-trip in vault-mode even BEFORE the projection generator has
// materialized the view file (it lands with build 4 / ticket 016).
describe('terminal-mcp-server vault-mode round-trip', () => {
  test('update_ticket resolves a fresh vault ticket by source_id without a projected file', () => {
    const projects = mkdtempSync(join(tmpdir(), 'gt-mcp-projects-'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'gt-mcp-home-'))
    const vault = mkdtempSync(join(tmpdir(), 'gt-mcp-vault-'))
    const repo = join(projects, 'fixturerepo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'backlog'))
    writeFileSync(join(repo, 'backlog', '.projection'), 'vaultPath: x\n')
    mkdirSync(join(fakeHome, '.config', 'TerMinal'), { recursive: true })
    writeFileSync(
      join(fakeHome, '.config', 'TerMinal', 'settings.json'),
      JSON.stringify({ projectsDir: projects }),
    )

    const server = join(import.meta.dir, '../../bin/terminal-mcp-server')
    const requests = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'file_ticket',
          arguments: { repo: 'fixturerepo', title: 'Round trip', type: 'bug' },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'update_ticket',
          arguments: { slug: '0001-round-trip', status: 'closed' },
        },
      }),
    ].join('\n')

    const r = Bun.spawnSync(['bun', server], {
      stdin: Buffer.from(`${requests}\n`),
      env: { ...process.env, HOME: fakeHome, GT_VAULT_PATH: vault },
    })
    const out = r.stdout.toString()
    expect(out).toContain('0001-round-trip')
    expect(out).toContain('ok')
    expect(out).not.toContain('not found in any known repo')

    const md = readFileSync(
      join(vault, 'Projects', 'fixturerepo', 'Tasks', 'fixturerepo-001.md'),
      'utf8',
    )
    expect(md).toContain('source_id: 1')
    expect(md).toContain('status: "closed"')

    rmSync(projects, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  })

  test('source_id collisions across repos disambiguate by title suffix; mismatches refuse', () => {
    const projects = mkdtempSync(join(tmpdir(), 'gt-mcp-multi-'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'gt-mcp-home-'))
    const vault = mkdtempSync(join(tmpdir(), 'gt-mcp-vault-'))
    for (const name of ['arepo', 'brepo']) {
      mkdirSync(join(projects, name, '.git'), { recursive: true })
      mkdirSync(join(projects, name, 'backlog'))
      writeFileSync(join(projects, name, 'backlog', '.projection'), 'x\n')
      mkdirSync(join(vault, 'Projects', name, 'Tasks'), { recursive: true })
    }
    // both projects have source_id: 1 — collisions are NORMAL per-project
    writeFileSync(
      join(vault, 'Projects', 'arepo', 'Tasks', 'arepo-001.md'),
      '---\ntype: "task"\nid: "arepo-001"\nproject: "arepo"\nstatus: "open"\nhorizon: "now"\nsource_id: 1\nupdated: 2026-06-06\n---\n\n# Alpha thing\n',
    )
    writeFileSync(
      join(vault, 'Projects', 'brepo', 'Tasks', 'brepo-001.md'),
      '---\ntype: "task"\nid: "brepo-001"\nproject: "brepo"\nstatus: "open"\nhorizon: "now"\nsource_id: 1\nupdated: 2026-06-06\n---\n\n# Bravo thing\n',
    )
    mkdirSync(join(fakeHome, '.config', 'TerMinal'), { recursive: true })
    writeFileSync(
      join(fakeHome, '.config', 'TerMinal', 'settings.json'),
      JSON.stringify({ projectsDir: projects }),
    )

    const server = join(import.meta.dir, '../../bin/terminal-mcp-server')
    const call = (id: number, slug: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'update_ticket', arguments: { slug, status: 'closed' } },
      })
    const r = Bun.spawnSync(['bun', server], {
      stdin: Buffer.from(`${call(1, '0001-bravo-thing')}\n${call(2, '0001-not-real-title')}\n`),
      env: { ...process.env, HOME: fakeHome, GT_VAULT_PATH: vault },
    })
    const out = r.stdout.toString()

    // the suffix picks brepo, not first-scanned arepo
    const brepoMd = readFileSync(join(vault, 'Projects', 'brepo', 'Tasks', 'brepo-001.md'), 'utf8')
    const arepoMd = readFileSync(join(vault, 'Projects', 'arepo', 'Tasks', 'arepo-001.md'), 'utf8')
    expect(brepoMd).toContain('status: "closed"')
    expect(arepoMd).toContain('status: "open"')
    // the mismatched suffix is refused, never silently patched
    expect(out).toContain('not found')
    expect(arepoMd).not.toContain('status: "closed"')

    rmSync(projects, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  })
})

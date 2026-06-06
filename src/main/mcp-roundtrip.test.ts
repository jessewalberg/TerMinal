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
})

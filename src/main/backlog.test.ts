import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTicket, getTicket, listTickets, updateTicket } from './backlog'
import {
  createVaultTicketFile,
  findVaultTaskBySourceId,
  updateTicketFile,
  writeExclusive,
} from '../../bin/lib/backlog-core.mjs'

const ticketMd = (id: number, title: string) =>
  `---\nid: ${id}\ntitle: "${title}"\nstatus: open\npriority: medium\ntype: feature\n---\n\nbody\n`

describe('listTickets', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gt-backlog-'))
    mkdirSync(join(root, 'backlog'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const write = (name: string, content: string) =>
    writeFileSync(join(root, 'backlog', name), content)

  test('only counts NNNN-slug.md ticket files', () => {
    write('0001-real-ticket.md', ticketMd(1, 'Real ticket'))
    write('0002-another.md', ticketMd(2, 'Another'))
    write('README.md', '# Backlog\n\nThis is not a ticket.\n')
    write('EXAMPLE.md', ticketMd(999, 'Example'))
    write('notes.txt', 'scratch')

    const tickets = listTickets(root)
    expect(tickets.map((t) => t.id).sort((a, b) => a - b)).toEqual([1, 2])
    // README.md / EXAMPLE.md / notes.txt must not slip in as tickets.
    expect(tickets.some((t) => t.slug === 'README')).toBe(false)
    expect(tickets.some((t) => t.slug === 'EXAMPLE')).toBe(false)
  })

  test('empty backlog dir → []', () => {
    expect(listTickets(root)).toEqual([])
  })

  test('missing backlog dir → []', () => {
    expect(listTickets(join(root, 'nonexistent'))).toEqual([])
  })
})

// Consolidated writer (TerMinal-001): one module behind file_ticket (MCP),
// tickets:create (app), and terminal-cli ticket — one allocator, one
// frontmatter shape, atomic create.
describe('createTicket (consolidated writer)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gt-backlog-'))
    mkdirSync(join(root, 'backlog'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const write = (name: string, content: string) =>
    writeFileSync(join(root, 'backlog', name), content)

  test('emits the full frontmatter superset (MCP shape), numeric id', () => {
    const t = createTicket(root, {
      title: 'Add SMS alerts',
      type: 'bug',
      priority: 'high',
      status: 'open',
      body: 'because reasons',
    })
    const md = readFileSync(join(root, 'backlog', `${t.slug}.md`), 'utf8')
    expect(md).toContain('id: 1')
    expect(md).toContain('title: "Add SMS alerts"')
    expect(md).toContain('horizon: now')
    // fields the old app/cli writers silently omitted:
    expect(md).toContain('hitl: false')
    expect(md).toContain('prs: []')
    expect(md).toContain('refs: []')
    expect(md).toContain('depends_on: []')
    expect(md).toContain('source: TerMinal')
    expect(md).toContain('because reasons')
  })

  test('allocator heals a stale-low .next-id (max of files wins)', () => {
    write('0013-existing.md', ticketMd(13, 'Existing'))
    write('.next-id', '1\n') // the nerdletters drift case
    const t = createTicket(root, { title: 'Next one', type: 'feature', priority: 'medium', status: 'open', body: '' })
    expect(t.id).toBe(14)
    expect(readFileSync(join(root, 'backlog', '.next-id'), 'utf8').trim()).toBe('15')
  })

  test('allocator respects a .next-id that is ahead (reserved ids)', () => {
    write('0088-existing.md', ticketMd(88, 'Existing'))
    write('.next-id', '90\n')
    const t = createTicket(root, { title: 'Reserved', type: 'feature', priority: 'medium', status: 'open', body: '' })
    expect(t.id).toBe(90)
    expect(readFileSync(join(root, 'backlog', '.next-id'), 'utf8').trim()).toBe('91')
  })

  test('garbage .next-id hints are ignored (strict whole-string parse)', () => {
    write('0002-existing.md', ticketMd(2, 'Existing'))
    write('.next-id', '10000junk\n') // permissive parseInt would read 10000
    const t = createTicket(root, {
      title: 'After garbage',
      type: 'feature',
      priority: 'medium',
      status: 'open',
      body: '',
    })
    expect(t.id).toBe(3)
  })

  test('allocator terminates when the candidate collides with a file the max scan ignores', () => {
    write('.next-id', '10000\n')
    // 5-digit filename: invisible to the 4-digit max scan, but occupies the
    // exact path the allocator computes — the old loop recomputed the same
    // candidate forever (review finding, high)
    write('10000-same-title.md', ticketMd(10000, 'Same title'))
    const t = createTicket(root, {
      title: 'Same title',
      type: 'feature',
      priority: 'medium',
      status: 'open',
      body: '',
    })
    expect(t.id).toBe(10001)
  })

  test('titles with quotes round-trip create → read unescaped', () => {
    const t = createTicket(root, {
      title: 'Fix "quoted" title',
      type: 'bug',
      priority: 'high',
      status: 'open',
      body: '',
    })
    expect(t.title).toBe('Fix "quoted" title')
  })

  test('honors an explicit source', () => {
    const t = createTicket(root, {
      title: 'From a script',
      type: 'dx',
      priority: 'low',
      status: 'open',
      body: '',
      source: 'script',
    })
    const md = readFileSync(join(root, 'backlog', `${t.slug}.md`), 'utf8')
    expect(md).toContain('source: script')
  })
})

describe('writeExclusive (atomic create primitive)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gt-excl-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('creates once, refuses to clobber, leaves content intact', () => {
    const p = join(root, 'target.md')
    expect(writeExclusive(p, 'first\n')).toBe(true)
    expect(writeExclusive(p, 'second\n')).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe('first\n')
  })
})

describe('createVaultTicketFile (vault-mode writer, ADR-0002)', () => {
  let vault: string

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'gt-vault-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  test('writes a full vault task: 3-digit id, source_id, kind normalization, bare dates', () => {
    const r = createVaultTicketFile(
      { vaultPath: vault, slug: 'myrepo' },
      { title: 'Fix perf path', type: 'perf', priority: 'high', status: 'open', body: 'why text', source: 'mcp' },
    )
    expect(r.id).toBe('myrepo-001')
    expect(r.sourceId).toBe(1)
    const md = readFileSync(r.path, 'utf8')
    expect(md).toContain('type: "task"')
    expect(md).toContain('id: "myrepo-001"')
    expect(md).toContain('project: "myrepo"')
    expect(md).toContain('source_id: 1')
    expect(md).toContain('kind: performance') // perf → performance
    expect(md).toContain('priority: high')
    expect(md).toContain('source: mcp')
    expect(md).toContain('hitl: false')
    const today = new Date().toISOString().slice(0, 10)
    expect(md).toContain(`created: ${today}`)
    expect(md).not.toContain(`created: "${today}"`)
    expect(md).toContain('# Fix perf path')
    expect(md).toContain('why text')
  })

  test('source_id continues from the project max; vault NNN from the file max', () => {
    mkdirSync(join(vault, 'Projects', 'myrepo', 'Tasks'), { recursive: true })
    writeFileSync(
      join(vault, 'Projects', 'myrepo', 'Tasks', 'myrepo-007.md'),
      '---\ntype: "task"\nid: "myrepo-007"\nproject: "myrepo"\nstatus: "open"\nhorizon: "now"\nsource_id: 41\nupdated: 2026-06-06\n---\n\n# Existing\n',
    )
    const r = createVaultTicketFile(
      { vaultPath: vault, slug: 'myrepo' },
      { title: 'Next one', type: 'feature', priority: 'medium', status: 'open', body: '' },
    )
    expect(r.id).toBe('myrepo-008')
    expect(r.sourceId).toBe(42)
  })

  test('findVaultTaskBySourceId resolves the task file; updateTicketFile patches it', () => {
    const r = createVaultTicketFile(
      { vaultPath: vault, slug: 'myrepo' },
      { title: 'Update me', type: 'bug', priority: 'low', status: 'open', body: '' },
    )
    const found = findVaultTaskBySourceId(vault, 'myrepo', r.sourceId)
    expect(found).toBe(r.path)
    expect(findVaultTaskBySourceId(vault, 'myrepo', 999)).toBeNull()
    expect(
      updateTicketFile(found as string, {
        status: 'closed',
        appendPrUrl: 'https://github.com/o/r/pull/3',
      }),
    ).toBe(true)
    const md = readFileSync(r.path, 'utf8')
    expect(md).toContain('status: "closed"')
    expect(md).toContain('https://github.com/o/r/pull/3')
  })
})

describe('projection marker guards (app writers fail fast)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gt-marker-'))
    mkdirSync(join(root, 'backlog'))
    writeFileSync(join(root, 'backlog', '.projection'), 'vaultPath: /tmp/v\n')
    writeFileSync(
      join(root, 'backlog', '0001-existing.md'),
      '---\nid: 1\ntitle: "Existing"\nstatus: open\npriority: medium\n---\n\nbody\n',
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('createTicket throws on a projected backlog instead of writing into the view', () => {
    expect(() =>
      createTicket(root, { title: 'X', type: 'feature', priority: 'medium', status: 'open', body: '' }),
    ).toThrow(/read-only projection/)
  })

  test('updateTicket refuses to patch a projected view', () => {
    expect(updateTicket(root, '0001-existing', { status: 'closed' })).toBe(false)
  })
})

describe('terminal-cli ticket (process-level contract)', () => {
  test('files a full-superset ticket, prints the path, exit 2 without TERMINAL_REPO', () => {
    const root = mkdtempSync(join(tmpdir(), 'gt-cli-'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'gt-home-')) // keep activity events out of the real feed
    mkdirSync(join(root, 'backlog'))
    const cli = join(import.meta.dir, '../../bin/terminal-cli')

    const ok = Bun.spawnSync(['bun', cli, 'ticket', 'Proc-level smoke', 'the body'], {
      env: { ...process.env, TERMINAL_REPO: root, HOME: fakeHome },
    })
    expect(ok.exitCode).toBe(0)
    const path = ok.stdout.toString().trim()
    expect(path).toContain('0001-proc-level-smoke')
    const md = readFileSync(path, 'utf8')
    expect(md).toContain('id: 1')
    expect(md).toContain('hitl: false')
    expect(md).toContain('depends_on: []')
    expect(md).toContain('source: script')

    const bad = Bun.spawnSync(['bun', cli, 'ticket', 'x', 'y'], {
      env: { ...process.env, TERMINAL_REPO: '', HOME: fakeHome },
    })
    expect(bad.exitCode).toBe(2)

    rmSync(root, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  test('vault-mode: a projected repo routes the write to the vault (GT_VAULT_PATH)', () => {
    const root = mkdtempSync(join(tmpdir(), 'gt-cli-vm-'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'gt-home-'))
    const vault = mkdtempSync(join(tmpdir(), 'gt-vault-'))
    mkdirSync(join(root, 'backlog'))
    writeFileSync(join(root, 'backlog', '.projection'), 'vaultPath: x\n')
    const cli = join(import.meta.dir, '../../bin/terminal-cli')

    const r = Bun.spawnSync(['bun', cli, 'ticket', 'Vault routed', 'body'], {
      env: { ...process.env, TERMINAL_REPO: root, HOME: fakeHome, GT_VAULT_PATH: vault },
    })
    expect(r.exitCode).toBe(0)
    const outPath = r.stdout.toString().trim()
    expect(outPath).toContain(join(vault, 'Projects'))
    const md = readFileSync(outPath, 'utf8')
    expect(md).toContain('source_id: 1')
    expect(md).toContain('kind: feature')
    // nothing written into the read-only view
    const viewFiles = readdirSync(join(root, 'backlog')).filter((f) => f.endsWith('.md'))
    expect(viewFiles).toHaveLength(0)

    rmSync(root, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  })

  test('vault-mode: unreachable vault queues to backlog/.pending/ with a warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'gt-cli-pend-'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'gt-home-'))
    mkdirSync(join(root, 'backlog'))
    writeFileSync(join(root, 'backlog', '.projection'), 'vaultPath: x\n')
    const cli = join(import.meta.dir, '../../bin/terminal-cli')

    const r = Bun.spawnSync(['bun', cli, 'ticket', 'Offline filed', ''], {
      env: {
        ...process.env,
        TERMINAL_REPO: root,
        HOME: fakeHome,
        GT_VAULT_PATH: join(root, 'does-not-exist'),
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stderr.toString()).toContain('vault unreachable')
    const outPath = r.stdout.toString().trim()
    expect(outPath).toContain(join('backlog', '.pending'))
    expect(readFileSync(outPath, 'utf8')).toContain('Offline filed')

    rmSync(root, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })
})

describe('updateTicket (consolidated: prs list ops)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gt-backlog-'))
    mkdirSync(join(root, 'backlog'))
    writeFileSync(
      join(root, 'backlog', '0001-with-prs.md'),
      '---\nid: 1\ntitle: "With prs"\nstatus: in-progress\npriority: medium\nprs: []\n---\n\nbody\n',
    )
    writeFileSync(
      join(root, 'backlog', '0002-no-prs-key.md'),
      '---\nid: 2\ntitle: "No prs key"\nstatus: open\npriority: medium\n---\n\nbody\n',
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('appendPrUrl adds to the inline list; removePrUrl scrubs it', () => {
    const url = 'https://github.com/o/r/pull/7'
    expect(updateTicket(root, '0001-with-prs', { appendPrUrl: url })).toBe(true)
    expect(getTicket(root, '0001-with-prs')?.prs).toEqual([url])
    expect(updateTicket(root, '0001-with-prs', { removePrUrl: url })).toBe(true)
    expect(getTicket(root, '0001-with-prs')?.prs).toEqual([])
  })

  test('appendPrUrl creates the prs key when missing and dedups', () => {
    const url = 'https://github.com/o/r/pull/9'
    expect(updateTicket(root, '0002-no-prs-key', { appendPrUrl: url })).toBe(true)
    expect(updateTicket(root, '0002-no-prs-key', { appendPrUrl: url })).toBe(true)
    expect(getTicket(root, '0002-no-prs-key')?.prs).toEqual([url])
  })
})

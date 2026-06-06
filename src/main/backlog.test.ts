import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTicket, getTicket, listTickets, updateTicket } from './backlog'
import { writeExclusive } from '../../bin/lib/backlog-core.mjs'

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

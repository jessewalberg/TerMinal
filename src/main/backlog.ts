import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createTicketFile,
  createVaultTicketFile,
  findVaultTaskBySourceId,
  hasProjectionMarker,
  slugify,
  todayStr,
  updateTicketFile,
} from '../../bin/lib/backlog-core.mjs'
import { resolveRoute } from '../../bin/lib/vault-route.mjs'
import { parseFrontmatter } from './frontmatter'

// Per-repo backlog: <repoRoot>/backlog/NNNN-slug.md with YAML frontmatter.

export type Ticket = {
  slug: string
  id: number
  title: string
  status: string
  priority: string
  horizon: string
  hitl: boolean
  type: string
  source: string
  created: string
  updated: string
  prs: string[]
  refs: string[]
  depends_on: number[] // ticket ids this one is blocked by (parsed from frontmatter)
  body: string
}

export type NewTicket = {
  title: string
  type: string
  priority: string
  status: string
  body: string
  source?: string
}

function backlogDir(repoRoot: string): string {
  return join(repoRoot, 'backlog')
}

function toTicket(slug: string, md: string): Ticket {
  const { fm, body } = parseFrontmatter(md)
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [])
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    slug,
    id: Number(fm.id) || 0,
    title: str(fm.title) || slug,
    status: str(fm.status) || 'open',
    priority: str(fm.priority) || 'medium',
    horizon: str(fm.horizon) || 'now',
    hitl: fm.hitl === 'true' || fm.hitl === true,
    type: str(fm.type) || 'feature',
    source: str(fm.source),
    created: str(fm.created),
    updated: str(fm.updated),
    prs: arr(fm.prs),
    refs: arr(fm.refs),
    depends_on: depsArr(fm.depends_on),
    body: body.trim(),
  }
}

// depends_on is a list of ticket IDs (numbers). YAML may parse them as
// numbers or as strings ("0042"); coerce either way and drop anything that
// isn't a positive integer.
function depsArr(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? parseInt(x, 10) : NaN
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return out
}

export function listTickets(repoRoot: string): Ticket[] {
  const dir = backlogDir(repoRoot)
  if (!existsSync(dir)) return []
  const out: Ticket[] = []
  for (const f of readdirSync(dir)) {
    // Tickets are NNNN-slug.md — a leading digit excludes README.md, EXAMPLE.md, etc.
    if (!/^\d/.test(f) || !f.endsWith('.md')) continue
    try {
      out.push(toTicket(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')))
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.id - a.id)
}

export function getTicket(repoRoot: string, slug: string): Ticket | null {
  const safe = slug.replace(/[^\w-]/g, '')
  const p = join(backlogDir(repoRoot), `${safe}.md`)
  if (!existsSync(p)) return null
  return toTicket(safe, readFileSync(p, 'utf8'))
}

// Both mutations delegate to the consolidated writer in
// bin/lib/backlog-core.mjs — the single allocator + frontmatter shape shared
// with bin/terminal-mcp-server (file_ticket/update_ticket) and
// bin/terminal-cli (ticket). Cut-over repos (.projection marker, ADR-0002)
// reroute to the vault. See vault tasks TerMinal-001/003.

type RouteSettings = {
  vaultPath?: string
  projectsDir?: string
  vaultCarveOuts?: { template?: string[]; collaborator?: string[] }
}

function cfgSettings(): RouteSettings {
  try {
    return (
      JSON.parse(
        readFileSync(join(homedir(), '.config', 'TerMinal', 'settings.json'), 'utf8'),
      ) ?? {}
    )
  } catch {
    return {}
  }
}

const pad4 = (n: number) => String(n).padStart(4, '0')

function builtTicket(input: NewTicket, id: number, slug: string): Ticket {
  return {
    slug,
    id,
    title: input.title,
    status: input.status || 'open',
    priority: input.priority || 'medium',
    horizon: 'now',
    hitl: false,
    type: input.type || 'feature',
    source: input.source || 'TerMinal',
    created: todayStr(),
    updated: todayStr(),
    prs: [],
    refs: [],
    depends_on: [],
    body: input.body || '',
  }
}

// In-place edit of a ticket's frontmatter (status/priority/prs list ops),
// preserving everything else.
export function updateTicket(
  repoRoot: string,
  slug: string,
  patch: { status?: string; priority?: string; appendPrUrl?: string; removePrUrl?: string },
  settingsOverride?: RouteSettings,
): boolean {
  const dir = backlogDir(repoRoot)
  if (hasProjectionMarker(dir)) {
    // Projected view (ADR-0002): the filename's NNNN is the source_id —
    // patch the owning vault task, never the view.
    const route = resolveRoute(repoRoot, settingsOverride ?? cfgSettings(), process.env)
    if (route.mode !== 'vault') return false
    const srcId = Number.parseInt(slug.slice(0, 4), 10)
    if (!Number.isFinite(srcId)) return false
    const vaultTask = findVaultTaskBySourceId(route.vaultPath, route.slug, srcId)
    return vaultTask ? updateTicketFile(vaultTask, patch) : false
  }
  const safe = slug.replace(/[^\w-]/g, '')
  const p = join(dir, `${safe}.md`)
  if (!existsSync(p)) return false
  return updateTicketFile(p, patch)
}

export function createTicket(
  repoRoot: string,
  input: NewTicket,
  settingsOverride?: RouteSettings,
): Ticket {
  const dir = backlogDir(repoRoot)
  if (!existsSync(dir)) throw new Error('no backlog/ in this repo')
  if (hasProjectionMarker(dir)) {
    const route = resolveRoute(repoRoot, settingsOverride ?? cfgSettings(), process.env)
    if (route.mode !== 'vault') {
      throw new Error(
        `backlog/ has a .projection marker but "${route.slug}" is carve-out-listed — fix settings.vaultCarveOuts (ADR-0002)`,
      )
    }
    if (existsSync(route.vaultPath)) {
      const r = createVaultTicketFile(route, input)
      return builtTicket(input, r.sourceId, `${pad4(r.sourceId)}-${slugify(input.title)}`)
    }
    // Vault unreachable (volume unmounted) — queue atomically, never lose it
    const pendingDir = join(dir, '.pending')
    mkdirSync(pendingDir, { recursive: true })
    const r = createTicketFile(pendingDir, input)
    return builtTicket(input, r.id, r.slug)
  }
  const { slug } = createTicketFile(dir, input)
  const written = getTicket(repoRoot, slug)
  if (!written) throw new Error(`ticket ${slug} written but unreadable`)
  return written
}

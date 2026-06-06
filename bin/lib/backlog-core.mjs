// backlog-core.mjs — THE single ticket writer (vault TerMinal-001).
// Consumed by: src/main/backlog.ts (app IPC), bin/terminal-mcp-server
// (file_ticket / update_ticket), bin/terminal-cli (ticket). Plain ESM with
// no deps so the launchd installer can copy bin/lib/ alongside the deployed
// scripts (~/.config/TerMinal/bin/lib/) — they import it relative to
// themselves and work both in-repo and installed.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'untitled'

export const todayStr = () => new Date().toISOString().slice(0, 10)

// Atomic create-only write ('wx' = O_CREAT|O_EXCL). false = lost the race;
// the existing file is never touched.
export function writeExclusive(path, content) {
  try {
    writeFileSync(path, content, { flag: 'wx' })
    return true
  } catch (e) {
    if (e && e.code === 'EEXIST') return false
    throw e
  }
}

function maxExistingId(backlogDir) {
  return readdirSync(backlogDir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .reduce((m, f) => Math.max(m, parseInt(f.slice(0, 4), 10)), 0)
}

function nextIdHint(backlogDir) {
  try {
    const raw = readFileSync(join(backlogDir, '.next-id'), 'utf8').trim()
    // strict whole-string parse: a corrupted hint ("10000junk") is ignored,
    // not truncated by parseInt into a huge bogus id (review finding)
    if (!/^\d{1,9}$/.test(raw)) return 0
    return parseInt(raw, 10)
  } catch {
    return 0
  }
}

// One allocator for every writer: max(existing files + 1, .next-id hint).
// Heals a stale-low .next-id (the app/cli writers historically never bumped
// it — observed drifted in 3 of 5 repos) and respects a .next-id that is
// deliberately ahead (reserved ids, template semantics). The create is
// atomic; a collision increments the LOCAL candidate — guaranteed to
// terminate even when the colliding file is invisible to the 4-digit max
// scan (e.g. a 5-digit id), which a recompute loop would spin on forever.
export function createTicketFile(backlogDir, input) {
  if (!existsSync(backlogDir)) throw new Error(`${backlogDir} does not exist`)
  const title = input.title || 'Untitled'
  const today = todayStr()
  let id = Math.max(maxExistingId(backlogDir) + 1, nextIdHint(backlogDir))
  for (;;) {
    const slug = `${String(id).padStart(4, '0')}-${slugify(title)}`
    const path = join(backlogDir, `${slug}.md`)
    const md = [
      '---',
      `id: ${id}`,
      `title: ${JSON.stringify(title)}`,
      `status: ${input.status || 'open'}`,
      `priority: ${input.priority || 'medium'}`,
      'horizon: now',
      'hitl: false',
      `type: ${input.type || 'feature'}`,
      `source: ${input.source || 'TerMinal'}`,
      `created: ${today}`,
      `updated: ${today}`,
      'prs: []',
      'refs: []',
      'depends_on: []',
      '---',
      '',
      (input.body || '').trim(),
      '',
    ].join('\n')
    if (writeExclusive(path, md)) {
      try {
        writeFileSync(join(backlogDir, '.next-id'), `${String(id + 1)}\n`)
      } catch {
        /* hint file is best-effort; the file scan is the source of truth */
      }
      return { id, slug, path }
    }
    id += 1
  }
}

// ---------------------------------------------------------------------------
// Vault-mode (Cross-Project ADR-0002): the vault is the only writable store
// for cut-over repos; their backlog/ is a read-only projection branded by a
// .projection marker. Writers redirect on the marker; until a repo is cut
// over, none of this path runs.
// ---------------------------------------------------------------------------

export function hasProjectionMarker(backlogDir) {
  return existsSync(join(backlogDir, '.projection'))
}

const KIND_NORMALIZE = { perf: 'performance' }

function vaultTasksDir(vaultPath, slug) {
  return join(vaultPath, 'Projects', slug, 'Tasks')
}

// Writes one vault task with the full ADR-0002 frontmatter. Vault NNN comes
// from the exactly-3-digit file max (timestamp ids can't poison it);
// source_id — the projection round-trip key — continues from the project
// max with a STRICT 1-9 digit parse (garbage/oversized values are ignored,
// never propagated). Both maxes are rescanned on every retry: a lost
// filename race means another writer just landed, and their file carries
// the source_id that must advance ours — allocating source_id outside the
// loop could mint duplicates under concurrency (review finding). Local
// floors keep both ids monotone even against scan-invisible colliders, so
// the loop always terminates.
export function createVaultTicketFile(route, input) {
  const { vaultPath, slug } = route
  const tasksDir = vaultTasksDir(vaultPath, slug)
  mkdirSync(tasksDir, { recursive: true })
  const today = todayStr()
  const title = input.title || 'Untitled'
  const kindRaw = input.type || 'feature'
  const kind = KIND_NORMALIZE[kindRaw] ?? kindRaw

  const list = (v) => `[${(v ?? []).map((x) => JSON.stringify(String(x))).join(', ')}]`
  let lastNNN = 0
  let lastSource = 0
  for (;;) {
    let maxSource = 0
    let maxNNN = 0
    for (const f of readdirSync(tasksDir)) {
      if (!f.endsWith('.md')) continue
      const m = f.match(/-(\d{3})\.md$/)
      if (m) maxNNN = Math.max(maxNNN, parseInt(m[1], 10))
      try {
        const sm = readFileSync(join(tasksDir, f), 'utf8').match(/^source_id:\s*(\d{1,9})\s*$/m)
        if (sm) maxSource = Math.max(maxSource, parseInt(sm[1], 10))
      } catch {
        /* unreadable file — skip */
      }
    }
    const nnn = Math.max(maxNNN + 1, lastNNN + 1)
    const sourceId = Math.max(maxSource + 1, lastSource + 1)
    lastNNN = nnn
    lastSource = sourceId
    const id = `${slug}-${String(nnn).padStart(3, '0')}`
    const path = join(tasksDir, `${id}.md`)
    const md = [
      '---',
      'type: "task"',
      `id: "${id}"`,
      `project: "${slug}"`,
      `status: "${input.status || 'open'}"`,
      `horizon: "${input.horizon || 'now'}"`,
      'hitl: false',
      `source_id: ${sourceId}`,
      `priority: ${input.priority || 'medium'}`,
      `kind: ${kind}`,
      ...(input.size ? [`size: ${input.size}`] : []),
      `source: ${input.source || 'TerMinal'}`,
      `created: ${today}`,
      `updated: ${today}`,
      `prs: ${list(input.prs)}`,
      `refs: ${list(input.refs)}`,
      `depends_on: ${list(input.depends_on)}`,
      '---',
      '',
      `# ${title}`,
      '',
      '## Goal',
      '',
      `${title}.`,
      '',
      '## Context',
      '',
      (input.body || '').trim(),
      '',
      '## Notes',
      '',
      `- ${today}: filed via vault-mode writer (${input.source || 'TerMinal'}).`,
      '',
    ].join('\n')
    if (writeExclusive(path, md)) {
      return { id, sourceId, path }
    }
    // lost the race — loop rescans both maxes (the winner's file is visible)
  }
}

// Projected slugs/filenames carry the original integer id — map it back to
// the vault task that owns it.
export function findVaultTaskBySourceId(vaultPath, slug, sourceId) {
  const tasksDir = vaultTasksDir(vaultPath, slug)
  if (!existsSync(tasksDir)) return null
  const re = new RegExp(`^source_id:\\s*${Number(sourceId)}\\s*$`, 'm')
  for (const f of readdirSync(tasksDir)) {
    if (!f.endsWith('.md')) continue
    try {
      if (re.test(readFileSync(join(tasksDir, f), 'utf8'))) return join(tasksDir, f)
    } catch {
      /* skip unreadable */
    }
  }
  return null
}

// In-place frontmatter patch (status / priority / prs list ops); always
// bumps updated:. Scoped to the frontmatter block so body text can't match.
export function updateTicketFile(path, patch) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const m = raw.match(/^(---\n[\s\S]*?\n---)([\s\S]*)$/)
  if (!m) return false
  let fm = m[1]
  // Quote-preserving: vault tasks serialize status as `status: "open"`,
  // backlog tickets as `status: open` — patching must not change the style
  // (vault conventions grep the quoted form).
  const setField = (key, val) => {
    const re = new RegExp(`^(${key}:[ \\t]*)(.*)$`, 'm')
    const existing = fm.match(re)
    if (existing) {
      const quoted = existing[2].trim().startsWith('"')
      fm = fm.replace(re, `$1${quoted ? `"${val}"` : val}`)
    } else {
      fm = fm.replace(/\n---$/, `\n${key}: ${val}\n---`)
    }
  }
  if (patch.status) setField('status', patch.status)
  if (patch.priority) setField('priority', patch.priority)
  setField('updated', todayStr())
  if (patch.appendPrUrl || patch.removePrUrl) {
    const prsMatch = fm.match(/^prs:\s*(.*)$/m)
    let prs = []
    if (prsMatch) {
      const rawList = prsMatch[1].trim()
      if (rawList.startsWith('[') && rawList.endsWith(']')) {
        prs = rawList
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
      }
    }
    if (patch.appendPrUrl && !prs.includes(patch.appendPrUrl)) prs.push(patch.appendPrUrl)
    if (patch.removePrUrl) prs = prs.filter((p) => p !== patch.removePrUrl)
    const formatted = `[${prs.map((p) => JSON.stringify(p)).join(', ')}]`
    if (prsMatch) fm = fm.replace(/^prs:\s*.*$/m, `prs: ${formatted}`)
    else fm = fm.replace(/\n---$/, `\nprs: ${formatted}\n---`)
  }
  try {
    writeFileSync(path, fm + m[2])
    return true
  } catch {
    return false
  }
}

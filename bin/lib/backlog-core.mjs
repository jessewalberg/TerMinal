// backlog-core.mjs — THE single ticket writer (vault TerMinal-001).
// Consumed by: src/main/backlog.ts (app IPC), bin/terminal-mcp-server
// (file_ticket / update_ticket), bin/terminal-cli (ticket). Plain ESM with
// no deps so the launchd installer can copy bin/lib/ alongside the deployed
// scripts (~/.config/TerMinal/bin/lib/) — they import it relative to
// themselves and work both in-repo and installed.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
    const n = parseInt(readFileSync(join(backlogDir, '.next-id'), 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

// One allocator for every writer: max(existing files + 1, .next-id hint).
// Heals a stale-low .next-id (the app/cli writers historically never bumped
// it — observed drifted in 3 of 5 repos) and respects a .next-id that is
// deliberately ahead (reserved ids, template semantics). The create is
// atomic; losing a cross-process race reallocates — the winner's file
// raises the max, so the loop converges.
export function createTicketFile(backlogDir, input) {
  if (!existsSync(backlogDir)) throw new Error(`${backlogDir} does not exist`)
  const title = input.title || 'Untitled'
  const today = todayStr()
  for (;;) {
    const id = Math.max(maxExistingId(backlogDir) + 1, nextIdHint(backlogDir))
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
  }
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
  const setField = (key, val) => {
    const re = new RegExp(`^(${key}:[ \\t]*).*$`, 'm')
    if (re.test(fm)) fm = fm.replace(re, `$1${val}`)
    else fm = fm.replace(/\n---$/, `\n${key}: ${val}\n---`)
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

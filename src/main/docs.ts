import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative, basename, sep } from 'node:path'

// GitBook-style docs surface for a repo. Lists every markdown file under
// docs/ + reports/ + a root CHANGELOG.md, grouped by category for the
// renderer's sidebar.
//
// Categories (per project-template convention):
//   - changelog   — root CHANGELOG.md only (pinned)
//   - maintainer  — docs/maintainer/**.md (auto-docs agent)
//   - developer   — docs/developer/**.md  (auto-docs agent)
//   - personal    — docs/personal/**.md   (auto-docs agent)
//   - reports     — reports/<kind>/**.md  (scheduled-agent run artifacts;
//                   each kind sub-grouped in the sidebar via DocEntry.subgroup)
//   - other       — everything else under docs/**.md (human-authored runbooks,
//                   ADRs, architecture.md at root, etc.)

export type DocCategory = 'changelog' | 'maintainer' | 'developer' | 'personal' | 'reports' | 'other'

export type DocEntry = {
  path: string // relative to repoRoot, forward slashes
  title: string // first H1 or filename basename
  category: DocCategory
  managedBy?: string // agent name if a "managed by:" header is present
  subgroup?: string // for 'reports': the agent name (second path segment)
}

export type DocsTree = {
  categories: { id: DocCategory; label: string; items: DocEntry[] }[]
}

const CATEGORY_LABEL: Record<DocCategory, string> = {
  changelog: 'Changelog',
  maintainer: 'Maintainer',
  developer: 'Developer',
  personal: 'Personal',
  reports: 'Reports',
  other: 'Other',
}

// Order in the sidebar.
const CATEGORY_ORDER: DocCategory[] = ['changelog', 'maintainer', 'developer', 'personal', 'reports', 'other']

const MARKDOWN_RE = /\.(md|mdx|markdown)$/i
const MANAGED_BY_RE = /<!--\s*managed by:\s*([a-z0-9-]+)/i

function readTitle(content: string, fallback: string): string {
  const h1 = content.match(/^#\s+(.+?)\s*$/m)
  if (h1) return h1[1].trim()
  return fallback
}

function categorize(rel: string): DocCategory {
  const norm = rel.split(sep).join('/')
  if (norm === 'CHANGELOG.md') return 'changelog'
  if (norm.startsWith('docs/maintainer/')) return 'maintainer'
  if (norm.startsWith('docs/developer/')) return 'developer'
  if (norm.startsWith('docs/personal/')) return 'personal'
  if (norm.startsWith('reports/')) return 'reports'
  if (norm.startsWith('checks/')) return 'reports' // checks/ surfaces alongside reports/
  return 'other'
}

function reportSubgroup(rel: string): string | undefined {
  const parts = rel.split(sep).join('/').split('/')
  // reports/<kind>/<file>.md → "<kind>"
  // checks/<kind>/<file>.md  → "<kind>"
  if (parts.length >= 3 && (parts[0] === 'reports' || parts[0] === 'checks')) return parts[1]
  return undefined
}

function walk(root: string, dir: string, out: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(root, full, out)
    else if (st.isFile() && MARKDOWN_RE.test(name)) out.push(relative(root, full))
  }
}

// listDocs walks docs/ + reports/ + checks/ and reads every markdown body to
// extract titles. The Reports tab badge calls it on every gt:tick (sub-second
// while an agent streams), so a short TTL collapses those bursts into at most
// one walk per repo per few seconds — staleness a badge can easily tolerate.
const docsCache = new Map<string, { exp: number; tree: DocsTree }>()
const DOCS_TTL_MS = 3000
export function listDocs(repoRoot: string): DocsTree {
  const now = Date.now()
  const hit = docsCache.get(repoRoot)
  if (hit && hit.exp > now) return hit.tree
  const tree = computeDocs(repoRoot)
  docsCache.set(repoRoot, { exp: now + DOCS_TTL_MS, tree })
  return tree
}

function computeDocs(repoRoot: string): DocsTree {
  const empty: DocsTree = { categories: CATEGORY_ORDER.map((id) => ({ id, label: CATEGORY_LABEL[id], items: [] })) }
  if (!repoRoot || !existsSync(repoRoot)) return empty
  const paths: string[] = []
  const docsDir = join(repoRoot, 'docs')
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) walk(repoRoot, docsDir, paths)
  const reportsDir = join(repoRoot, 'reports')
  if (existsSync(reportsDir) && statSync(reportsDir).isDirectory()) walk(repoRoot, reportsDir, paths)
  const checksDir = join(repoRoot, 'checks')
  if (existsSync(checksDir) && statSync(checksDir).isDirectory()) walk(repoRoot, checksDir, paths)
  const changelog = join(repoRoot, 'CHANGELOG.md')
  if (existsSync(changelog)) paths.push('CHANGELOG.md')

  const entries: DocEntry[] = []
  for (const rel of paths) {
    const norm = rel.split(sep).join('/')
    let content = ''
    try {
      content = readFileSync(join(repoRoot, rel), 'utf8')
    } catch {
      /* skip */
    }
    const managed = content.match(MANAGED_BY_RE)
    const category = categorize(norm)
    entries.push({
      path: norm,
      title: readTitle(content, basename(norm, '.md')),
      category,
      managedBy: managed ? managed[1] : undefined,
      subgroup: category === 'reports' ? reportSubgroup(norm) : undefined,
    })
  }

  const byCategory = new Map<DocCategory, DocEntry[]>()
  for (const e of entries) {
    const list = byCategory.get(e.category) ?? []
    list.push(e)
    byCategory.set(e.category, list)
  }
  for (const list of byCategory.values()) list.sort((a, b) => a.path.localeCompare(b.path))

  return {
    categories: CATEGORY_ORDER.map((id) => ({
      id,
      label: CATEGORY_LABEL[id],
      items: byCategory.get(id) ?? [],
    })),
  }
}

// Path-guarded read: only files inside repoRoot, only markdown.
export function readDoc(repoRoot: string, relPath: string): string {
  if (!repoRoot || !relPath) return ''
  if (!MARKDOWN_RE.test(relPath)) return ''
  const norm = relPath.split('/').join(sep)
  const full = join(repoRoot, norm)
  // prevent path traversal
  if (!full.startsWith(repoRoot + sep) && full !== join(repoRoot, basename(norm))) return ''
  try {
    return readFileSync(full, 'utf8')
  } catch {
    return ''
  }
}

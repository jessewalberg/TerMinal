import { useEffect, useMemo, useState } from 'react'
import { BookText, FileText, Sparkles, ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { Badge } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import type { Tab, TabContext, DocsTree, DocEntry, DocCategory } from '../../lib/types'

// A node in the per-category folder tree (GitHub-style).
type TreeNode =
  | { type: 'file'; key: string; entry: DocEntry }
  | { type: 'dir'; key: string; name: string; children: TreeNode[] }

const CATEGORY_PREFIX: Partial<Record<DocCategory, string>> = {
  maintainer: 'docs/maintainer/',
  developer: 'docs/developer/',
  personal: 'docs/personal/',
  reports: 'reports/',
  other: 'docs/',
}

function buildTree(items: DocEntry[], stripPrefix = ''): TreeNode[] {
  // Sort items by path so siblings come out in stable order.
  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path))
  // Build a synthetic root and walk each path into it.
  type DirAccum = { type: 'dir'; key: string; name: string; children: TreeNode[] }
  const root: DirAccum = { type: 'dir', key: '', name: '', children: [] }
  for (const e of sorted) {
    const trimmed = stripPrefix && e.path.startsWith(stripPrefix) ? e.path.slice(stripPrefix.length) : e.path
    const parts = trimmed.split('/').filter(Boolean)
    let cur: DirAccum = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      const dirKey = cur.key ? `${cur.key}/${name}` : name
      let next = cur.children.find((c): c is DirAccum => c.type === 'dir' && c.name === name)
      if (!next) {
        next = { type: 'dir', key: dirKey, name, children: [] }
        cur.children.push(next)
      }
      cur = next
    }
    cur.children.push({ type: 'file', key: e.path, entry: e })
  }
  // Within each dir put folders first, then files (matches GitHub).
  const sortDir = (n: DirAccum): void => {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      const an = a.type === 'dir' ? a.name : (a.entry.title || a.entry.path)
      const bn = b.type === 'dir' ? b.name : (b.entry.title || b.entry.path)
      return an.localeCompare(bn)
    })
    for (const c of n.children) if (c.type === 'dir') sortDir(c as DirAccum)
  }
  sortDir(root)
  return root.children
}

// GitBook-style Docs tab. Left: tree nav grouped by category (Changelog,
// Maintainer, Developer, Personal, Other). Right: rendered markdown. The
// tripartite categories are managed by the auto-docs agent (project-template
// convention); CHANGELOG.md is sole-writer-owned by the changelog agent.

const CATEGORY_HINT: Record<DocCategory, string> = {
  changelog: 'maintained by the changelog agent',
  maintainer: 'maintained by the auto-docs agent — contributor reference',
  developer: 'maintained by the auto-docs agent — public API + integration',
  personal: 'maintained by the auto-docs agent — what shipped + what is in flight',
  reports: 'scheduled-agent run artifacts, grouped by kind',
  other: 'human-authored (handbook, runbooks, ADRs, architecture overview)',
}


function categoryStorageKey(repoRoot: string) {
  return `gt.docs.lastPath.${repoRoot}`
}

function DocsTab({ ctx }: { ctx: TabContext }) {
  const [tree, setTree] = useState<DocsTree | null>(null)
  const [selected, setSelected] = useState<DocEntry | null>(null)
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggleDir = (key: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })

  // Load tree on mount + when repo changes.
  useEffect(() => {
    let alive = true
    window.gt.docs.list().then((t) => {
      if (!alive) return
      setTree(t)
      // Restore the last-viewed doc for this repo, else default to a useful first doc.
      const lastPath = localStorage.getItem(categoryStorageKey(ctx.repoRoot))
      const all = t.categories.flatMap((c) => c.items)
      const restored = (lastPath && all.find((e) => e.path === lastPath)) || null
      const fallback =
        all.find((e) => e.category === 'changelog') ||
        all.find((e) => e.category === 'maintainer') ||
        all[0] ||
        null
      const initial = restored || fallback
      if (initial) setSelected(initial)
    })
    return () => {
      alive = false
    }
  }, [ctx.repoRoot])

  // Load the body whenever selection changes.
  useEffect(() => {
    if (!selected) {
      setBody('')
      return
    }
    let alive = true
    setLoading(true)
    setBody('')
    window.gt.docs.get(selected.path).then((b) => {
      if (alive) {
        setBody(b)
        setLoading(false)
      }
    })
    localStorage.setItem(categoryStorageKey(ctx.repoRoot), selected.path)
    return () => {
      alive = false
    }
  }, [selected?.path, ctx.repoRoot])

  // Search filters across categories.
  const filtered = useMemo(() => {
    if (!tree) return null
    if (!query.trim()) return tree
    const q = query.toLowerCase()
    return {
      categories: tree.categories.map((c) => ({
        ...c,
        items: c.items.filter((e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q)),
      })),
    }
  }, [tree, query])

  const allEntries = tree?.categories.flatMap((c) => c.items) ?? []
  const totalCount = allEntries.length

  return (
    <div className="flex h-full min-h-0 bg-[var(--gt-bg)]">
      {/* sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--gt-border)] bg-[var(--gt-panel)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gt-border)] px-3 py-2">
          <BookText size={14} strokeWidth={2} className="text-[var(--gt-accent-light)]" />
          <span className="text-[12px] font-semibold text-zinc-200">Docs</span>
          <span className="text-[11px] text-zinc-600">{totalCount}</span>
        </div>
        <div className="shrink-0 border-b border-[var(--gt-border)] p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="w-full rounded-md border border-[var(--gt-border)] bg-black/30 px-2 py-1 text-[11.5px] text-zinc-200 outline-none focus:border-[var(--gt-accent)]/60"
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!filtered ? (
            <div className="px-2 py-3 text-[11px] text-zinc-600">Loading…</div>
          ) : totalCount === 0 ? (
            <div className="px-2 py-3 text-[11px] text-zinc-600">
              No docs yet. The auto-docs agent will populate{' '}
              <span className="font-mono text-zinc-500">docs/maintainer/</span>,{' '}
              <span className="font-mono text-zinc-500">docs/developer/</span>, and{' '}
              <span className="font-mono text-zinc-500">docs/personal/</span> on its first run; the changelog agent
              maintains <span className="font-mono text-zinc-500">CHANGELOG.md</span>.
            </div>
          ) : (
            filtered.categories
              .filter((c) => c.items.length > 0)
              .map((c) => {
                const trees = buildTree(c.items, CATEGORY_PREFIX[c.id] ?? '')
                const renderNode = (n: TreeNode, depth: number) => {
                  if (n.type === 'file') {
                    const on = selected?.path === n.entry.path
                    return (
                      <button
                        key={n.key}
                        onClick={() => setSelected(n.entry)}
                        style={{ paddingLeft: 8 + depth * 12 }}
                        className={`group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12px] transition-colors ${
                          on
                            ? 'bg-[var(--gt-accent)]/20 text-zinc-100'
                            : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                        }`}
                      >
                        <FileText
                          size={11}
                          strokeWidth={2}
                          className={on ? 'text-[var(--gt-accent-light)]' : 'text-zinc-600'}
                        />
                        <span className="min-w-0 flex-1 truncate">{n.entry.title}</span>
                        {n.entry.managedBy && (
                          <Sparkles
                            size={10}
                            strokeWidth={2}
                            className="shrink-0 text-[var(--gt-accent-light)] opacity-70"
                            aria-label={`managed by ${n.entry.managedBy}`}
                          />
                        )}
                      </button>
                    )
                  }
                  const dirKey = `${c.id}:${n.key}`
                  const isCollapsed = collapsed.has(dirKey)
                  return (
                    <div key={n.key}>
                      <button
                        onClick={() => toggleDir(dirKey)}
                        style={{ paddingLeft: 8 + depth * 12 }}
                        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                      >
                        {isCollapsed ? (
                          <ChevronRight size={11} strokeWidth={2} className="text-zinc-600" />
                        ) : (
                          <ChevronDown size={11} strokeWidth={2} className="text-zinc-600" />
                        )}
                        {isCollapsed ? (
                          <Folder size={11} strokeWidth={2} className="text-zinc-600" />
                        ) : (
                          <FolderOpen size={11} strokeWidth={2} className="text-[var(--gt-accent-light)]/80" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{n.name}</span>
                      </button>
                      {!isCollapsed && n.children.map((child) => renderNode(child, depth + 1))}
                    </div>
                  )
                }
                return (
                  <div key={c.id} className="mb-3">
                    <div
                      title={CATEGORY_HINT[c.id]}
                      className="mb-1 flex items-center gap-1.5 px-2 text-[9.5px] font-bold uppercase tracking-[0.16em] text-zinc-600"
                    >
                      {c.label}
                      <span className="text-zinc-700">·</span>
                      <span className="text-zinc-700">{c.items.length}</span>
                    </div>
                    {trees.map((n) => renderNode(n, 0))}
                  </div>
                )
              })
          )}
        </nav>
      </aside>

      {/* content */}
      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gt-border)] px-5 py-2.5">
              <span className="text-[11px] text-zinc-600">{selected.category}</span>
              <span className="text-zinc-700">›</span>
              <span className="font-mono text-[11px] text-zinc-500">{selected.path}</span>
              {selected.managedBy && (
                <Badge tone="blue">
                  <Sparkles size={9} strokeWidth={2.5} className="mr-0.5" />
                  managed by {selected.managedBy}
                </Badge>
              )}
            </header>
            <article className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
              <div className="mx-auto max-w-3xl">
                {loading ? (
                  <div className="text-[12px] text-zinc-600">Loading…</div>
                ) : body ? (
                  <Markdown>{body}</Markdown>
                ) : (
                  <div className="text-[12px] text-zinc-600">(empty document)</div>
                )}
              </div>
            </article>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-zinc-600">
            Pick a document on the left.
          </div>
        )}
      </section>
    </div>
  )
}

const tab: Tab = {
  id: 'docs',
  title: 'Docs',
  icon: BookText,
  order: 5.5, // alongside Notes / Files
  appliesTo: () => true,
  Component: DocsTab,
}
export default tab

import { useEffect, useMemo, useState } from 'react'
import { ClipboardList, FileText, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Badge } from '../../components/ui'
import type { BadgeTone } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import type { Tab, TabContext, DocsTree, DocEntry } from '../../lib/types'

// Reports viewer — focused, status-aware sibling to the Docs tab. Groups
// reports/<kind>/<sha>.md by agent kind, parses each run's frontmatter to show
// a status badge + key metrics + PR/ticket links inline, and renders the
// markdown body on selection. Reuses docs IPC; no new main-side surface.

// ---- frontmatter parser ----------------------------------------------------
// Reports use a small, predictable YAML head (per the .agents/<kind>.md
// schemas): flat keys + a few one-line lists. We don't need a real YAML
// parser; a regex pass is enough for top-level keys.

type ReportMeta = {
  kind?: string
  generated?: string
  sha?: string
  last_scanned?: string
  status?: string
  pr_opened?: string
  hitl_filed?: boolean
  tickets_filed?: string[]
  // a few common metric fields we surface as inline badges
  total_coverage_pct?: number
  delta_pct?: number
  flakes_detected?: number
  entries_added?: number
  categories_regenerated?: string[]
  files_changed?: number
  findings?: number
  benchmarks_run?: number
  status_summary?: string
} & Record<string, unknown>

function parseFrontmatter(md: string): { meta: ReportMeta; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: md }
  const meta: ReportMeta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const lm = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!lm) continue
    let raw = lm[2].trim()
    if (raw === '') continue // nested block — skip (we only surface top-level scalars)
    let val: unknown = raw
    if (raw === 'true' || raw === 'false') val = raw === 'true'
    else if (/^-?\d+(\.\d+)?$/.test(raw)) val = Number(raw)
    else if (raw.startsWith('"') && raw.endsWith('"')) val = raw.slice(1, -1)
    else if (raw.startsWith('[') && raw.endsWith(']'))
      val = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    ;(meta as Record<string, unknown>)[lm[1]] = val
  }
  return { meta, body: m[2] || '' }
}

// ---- status tone -----------------------------------------------------------
function statusTone(status?: string): BadgeTone {
  if (!status) return 'mute'
  const s = status.toLowerCase()
  if (s === 'healthy' || s === 'ok' || s === 'pass') return 'green'
  if (s === 'degraded' || s === 'warn' || s === 'not-configured') return 'yellow'
  if (s === 'unhealthy' || s === 'error' || s === 'fail' || s === 'blocked') return 'red'
  return 'blue'
}

// ---- metric chips ----------------------------------------------------------
// A few well-known frontmatter fields rendered as compact inline chips so the
// sidebar tells you what the run found at a glance.
function metricChips(meta: ReportMeta): { label: string; tone?: BadgeTone }[] {
  const chips: { label: string; tone?: BadgeTone }[] = []
  if (typeof meta.total_coverage_pct === 'number') {
    chips.push({ label: `${meta.total_coverage_pct}% cov` })
    if (typeof meta.delta_pct === 'number')
      chips.push({ label: `${meta.delta_pct >= 0 ? '+' : ''}${meta.delta_pct}%`, tone: meta.delta_pct >= 0 ? 'green' : 'red' })
  }
  if (typeof meta.flakes_detected === 'number' && meta.flakes_detected > 0)
    chips.push({ label: `${meta.flakes_detected} flake${meta.flakes_detected === 1 ? '' : 's'}`, tone: 'yellow' })
  if (typeof meta.entries_added === 'number')
    chips.push({ label: `+${meta.entries_added} entries` })
  if (Array.isArray(meta.categories_regenerated) && meta.categories_regenerated.length > 0)
    chips.push({ label: meta.categories_regenerated.join(', ') })
  if (typeof meta.files_changed === 'number' && meta.files_changed > 0)
    chips.push({ label: `${meta.files_changed} files` })
  if (typeof meta.findings === 'number' && meta.findings > 0)
    chips.push({ label: `${meta.findings} findings`, tone: 'yellow' })
  if (typeof meta.benchmarks_run === 'number')
    chips.push({ label: `${meta.benchmarks_run} benches` })
  if (meta.hitl_filed === true) chips.push({ label: 'HITL', tone: 'red' })
  return chips
}

// ---- helpers ---------------------------------------------------------------
function reltime(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = (Date.now() - t) / 1000
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

type RunEntry = { entry: DocEntry; meta: ReportMeta; body: string }
type KindGroup = { kind: string; runs: RunEntry[] }

function ReportsTab({ ctx }: { ctx: TabContext }) {
  const [tree, setTree] = useState<DocsTree | null>(null)
  const [runs, setRuns] = useState<RunEntry[] | null>(null)
  const [selectedKind, setSelectedKind] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<RunEntry | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  // Load tree + fetch every report's body so we can parse frontmatter inline.
  // Reports are small markdown — this is cheap even at ~hundreds of files.
  useEffect(() => {
    let alive = true
    setRuns(null)
    setSelectedRun(null)
    window.gt.docs.list().then(async (t) => {
      if (!alive) return
      setTree(t)
      const reportEntries = t.categories.find((c) => c.id === 'reports')?.items ?? []
      const fetched = await Promise.all(
        reportEntries.map(async (entry) => {
          const body = await window.gt.docs.get(entry.path).catch(() => '')
          const { meta, body: stripped } = parseFrontmatter(body)
          return { entry, meta, body: stripped }
        }),
      )
      if (!alive) return
      // newest first by generated, fallback to path
      fetched.sort((a, b) => {
        const at = a.meta.generated ? Date.parse(a.meta.generated) : 0
        const bt = b.meta.generated ? Date.parse(b.meta.generated) : 0
        if (at !== bt) return bt - at
        return b.entry.path.localeCompare(a.entry.path)
      })
      setRuns(fetched)
    })
    return () => {
      alive = false
    }
  }, [ctx.repoRoot])

  const groups: KindGroup[] = useMemo(() => {
    if (!runs) return []
    const byKind = new Map<string, RunEntry[]>()
    for (const r of runs) {
      const k = r.entry.subgroup || r.meta.kind || 'other'
      const list = byKind.get(k) ?? []
      list.push(r)
      byKind.set(k, list)
    }
    return [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, runs]) => ({ kind, runs }))
  }, [runs])

  const toggleKind = (k: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })

  // Default: keep all kinds expanded so the operator sees the latest run per kind at a glance.
  return (
    <div className="flex h-full min-h-0 bg-[var(--gt-bg)]">
      {/* sidebar — kinds + runs */}
      <aside className="flex w-[28rem] shrink-0 flex-col border-r border-[var(--gt-border)] bg-[var(--gt-panel)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gt-border)] px-3 py-2">
          <ClipboardList size={14} strokeWidth={2} className="text-[var(--gt-accent-light)]" />
          <span className="text-[12px] font-semibold text-zinc-200">Reports</span>
          <span className="text-[11px] text-zinc-600">{runs?.length ?? 0}</span>
          <span className="ml-auto text-[10px] text-zinc-700">
            {ctx.repoPath || ctx.repoRoot.replace(/^.*\//, '')}
          </span>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {runs === null ? (
            <div className="px-2 py-3 text-[11px] text-zinc-600">Loading reports…</div>
          ) : runs.length === 0 ? (
            <div className="px-2 py-3 text-[11px] leading-relaxed text-zinc-600">
              No reports yet. Scheduled agents (changelog, drift, coverage, deps-quality, perf, health, auto-docs)
              write here on each run. Wire them up in the Schedules tab.
            </div>
          ) : (
            groups.map((g) => {
              const isCollapsed = collapsed.has(g.kind)
              const latest = g.runs[0]
              return (
                <div key={g.kind} className="mb-3">
                  <button
                    onClick={() => {
                      toggleKind(g.kind)
                      setSelectedKind(g.kind)
                    }}
                    className="mb-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-white/5"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={11} strokeWidth={2.5} className="text-zinc-600" />
                    ) : (
                      <ChevronDown size={11} strokeWidth={2.5} className="text-zinc-600" />
                    )}
                    <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">{g.kind}</span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-[10px] tabular-nums text-zinc-600">{g.runs.length}</span>
                    {latest?.meta.status && (
                      <Badge tone={statusTone(latest.meta.status)}>{latest.meta.status}</Badge>
                    )}
                    <span className="ml-auto text-[9.5px] text-zinc-700">{reltime(latest?.meta.generated)}</span>
                  </button>
                  {!isCollapsed &&
                    g.runs.map((r) => {
                      const on = selectedRun?.entry.path === r.entry.path
                      const chips = metricChips(r.meta)
                      return (
                        <button
                          key={r.entry.path}
                          onClick={() => {
                            setSelectedKind(g.kind)
                            setSelectedRun(r)
                          }}
                          className={`flex w-full flex-col items-start gap-1 rounded-md px-2.5 py-1.5 text-left ${
                            on ? 'bg-[var(--gt-accent)]/20 text-zinc-100' : 'hover:bg-white/5'
                          }`}
                        >
                          <div className="flex w-full items-center gap-1.5">
                            <FileText
                              size={10}
                              strokeWidth={2}
                              className={on ? 'text-[var(--gt-accent-light)]' : 'text-zinc-600'}
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">
                              {r.meta.sha || r.entry.title}
                            </span>
                            {r.meta.status && <Badge tone={statusTone(r.meta.status)}>{r.meta.status}</Badge>}
                            <span className="text-[9.5px] text-zinc-600">{reltime(r.meta.generated)}</span>
                          </div>
                          {chips.length > 0 && (
                            <div className="flex flex-wrap gap-1 pl-4">
                              {chips.map((c, i) => (
                                <Badge key={i} tone={c.tone || 'mute'}>
                                  {c.label}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </button>
                      )
                    })}
                </div>
              )
            })
          )}
        </nav>
      </aside>

      {/* content */}
      <section className="flex min-w-0 flex-1 flex-col">
        {selectedRun ? (
          <>
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gt-border)] px-5 py-2.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                {selectedRun.meta.kind || selectedKind}
              </span>
              <span className="text-zinc-700">›</span>
              <span className="font-mono text-[11px] text-zinc-400">{selectedRun.meta.sha || selectedRun.entry.title}</span>
              {selectedRun.meta.status && (
                <Badge tone={statusTone(selectedRun.meta.status)}>{selectedRun.meta.status}</Badge>
              )}
              <span className="text-[10.5px] text-zinc-600">{reltime(selectedRun.meta.generated)}</span>
              <div className="flex-1" />
              {selectedRun.meta.pr_opened && (
                <button
                  onClick={() => window.gt.openExternal(selectedRun.meta.pr_opened as string)}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-0.5 text-[11px] text-zinc-300 hover:border-[var(--gt-accent)]/60"
                >
                  PR
                  <ExternalLink size={10} strokeWidth={2} />
                </button>
              )}
              {Array.isArray(selectedRun.meta.tickets_filed) && selectedRun.meta.tickets_filed.length > 0 && (
                <Badge tone="blue">{selectedRun.meta.tickets_filed.length} tickets</Badge>
              )}
            </header>
            <article className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
              <div className="mx-auto max-w-3xl">
                {selectedRun.meta.status_summary && (
                  <div className="mb-4 rounded-lg border border-[var(--gt-border)] bg-black/20 p-3 text-[12.5px] italic text-zinc-300">
                    {selectedRun.meta.status_summary}
                  </div>
                )}
                {selectedRun.body ? (
                  <Markdown>{selectedRun.body}</Markdown>
                ) : (
                  <div className="text-[12px] text-zinc-600">(no body — frontmatter only)</div>
                )}
              </div>
            </article>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center text-[12px] text-zinc-600">
            <ClipboardList size={28} strokeWidth={1.5} className="mb-3 text-zinc-700" />
            <div className="max-w-md">
              Scheduled-agent run reports live here. Pick a run on the left to see its details, or expand a kind
              to compare recent runs. The latest status per kind shows on the group headers — green / yellow / red.
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

const tab: Tab = {
  id: 'reports',
  title: 'Reports',
  icon: ClipboardList,
  order: 3.62, // after Factory (3.6); distinct value avoids the alpha tie-break
  appliesTo: () => true,
  badge: async (gt) => {
    // Surface a red count when any latest-per-kind report is unhealthy/error/fail.
    try {
      const t = await gt.docs.list()
      const reportEntries = t.categories.find((c) => c.id === 'reports')?.items ?? []
      if (reportEntries.length === 0) return 0
      // Bucket by kind; sort by path desc to approximate "newest" (filename = sha,
      // so this is best-effort but stable). Read only the latest per kind to keep
      // the badge poll cheap.
      const byKind = new Map<string, string>()
      for (const e of reportEntries) {
        const k = e.subgroup || 'other'
        const prev = byKind.get(k)
        if (!prev || e.path > prev) byKind.set(k, e.path)
      }
      let unhealthy = 0
      for (const path of byKind.values()) {
        const body = await gt.docs.get(path).catch(() => '')
        const m = body.match(/^status:\s*(\S+)/m)
        if (m && /^(unhealthy|error|fail|blocked)$/i.test(m[1])) unhealthy++
      }
      return unhealthy
    } catch {
      return 0
    }
  },
  Component: ReportsTab,
}
export default tab

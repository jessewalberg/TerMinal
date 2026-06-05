import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Zap, Loader2 } from 'lucide-react'
import type { RepoInventory } from '../lib/types'
import { navigateTo } from '../lib/nav'

// ⌘K task composer — the task-first entry point. Type a task, confirm the
// repo, go: the main process routes plan→code→review→verify to the engines
// in Settings → Role routing. No engine picking, no terminal session.
//
// Opened by the global ⌘K handler in App.tsx, or pre-seeded from anywhere via
//   window.dispatchEvent(new CustomEvent('gt:task-compose', { detail: { text, repoRoot } }))
// (the Tickets tab uses this to launch a task from a ticket).

const LAST_REPO_KEY = 'gt.taskComposer.lastRepo'

export type TaskComposerSeed = { text?: string; repoRoot?: string }

export function TaskComposer({
  seed,
  activeRepoRoot,
  onClose,
}: {
  seed: TaskComposerSeed
  /** The active workspace's repo — first choice for the default target. */
  activeRepoRoot: string
  onClose: () => void
}) {
  const [text, setText] = useState(seed.text ?? '')
  const [repos, setRepos] = useState<RepoInventory[] | null>(null)
  const [repoRoot, setRepoRoot] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    taRef.current?.focus()
    window.gt
      .fleetRepos()
      .then((rs) => setRepos(rs.filter((r) => !r.hidden)))
      .catch(() => setRepos([]))
  }, [])

  // Default repo precedence: explicit seed (ticket launch) > active workspace
  // > last used > most recently active in the fleet.
  useEffect(() => {
    if (repoRoot || repos === null) return
    const last = localStorage.getItem(LAST_REPO_KEY) || ''
    const candidates = [seed.repoRoot, activeRepoRoot, last]
    const known = (p?: string) => !!p && repos.some((r) => r.path === p)
    const pick = candidates.find(known) ?? repos[0]?.path ?? ''
    setRepoRoot(pick)
  }, [repos, repoRoot, seed.repoRoot, activeRepoRoot])

  const sorted = useMemo(
    () => (repos ?? []).slice().sort((a, b) => b.lastActivityMs - a.lastActivityMs),
    [repos],
  )

  const start = async () => {
    if (!text.trim() || !repoRoot || busy) return
    setBusy(true)
    setError('')
    const r = await window.gt.tasks.start(repoRoot, text)
    setBusy(false)
    if ('error' in r) {
      setError(r.error)
      return
    }
    localStorage.setItem(LAST_REPO_KEY, repoRoot)
    onClose()
    navigateTo('runs', { runId: r.id })
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 pt-[18vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[620px] max-w-[92vw] rounded-xl border border-[var(--gt-border)] bg-[var(--gt-bg)] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[var(--gt-border)]/60 px-4 py-2.5">
          <Zap size={14} strokeWidth={2} className="text-[var(--gt-accent)]" />
          <span className="flex-1 text-[12px] font-semibold text-zinc-200">New task</span>
          <span className="text-[10px] text-zinc-600">
            plan → code → review → verify · engines from Settings → Role routing
          </span>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:text-zinc-200">
            <X size={13} />
          </button>
        </div>
        <div className="p-4">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void start()
              }
              if (e.key === 'Escape') onClose()
            }}
            placeholder="Describe the task — what should change, and how you'll know it worked…"
            rows={4}
            spellCheck={false}
            className="w-full resize-none rounded-lg border border-[var(--gt-border)] bg-black/30 px-3 py-2 text-[12.5px] leading-relaxed text-zinc-200 outline-none focus:border-[var(--gt-accent)]/60"
          />
          <div className="mt-3 flex items-center gap-2">
            <label className="text-[11px] text-zinc-500">repo</label>
            <select
              value={repoRoot}
              onChange={(e) => setRepoRoot(e.target.value)}
              className="min-w-0 flex-1 truncate rounded-md border border-[var(--gt-border)] bg-black/30 px-2 py-1 text-[11.5px] text-zinc-200 outline-none"
            >
              {sorted.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
              {repos !== null && sorted.length === 0 && <option value="">no repos found</option>}
            </select>
            <button
              onClick={() => void start()}
              disabled={!text.trim() || !repoRoot || busy}
              className="flex items-center gap-1.5 rounded-md bg-[var(--gt-accent)]/80 px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-[var(--gt-accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Start
              <span className="ml-0.5 text-[9.5px] opacity-70">⌘↩</span>
            </button>
          </div>
          {error && (
            <div className="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

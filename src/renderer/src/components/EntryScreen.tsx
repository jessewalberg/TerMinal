import { useEffect, useState } from 'react'
import { X, FolderOpen, Plus, GitBranch, FolderGit2, SquareTerminal } from 'lucide-react'
import type { SessionEngine, SessionMeta } from '../lib/types'
import { EngineLogo } from './EngineLogo'
import { pickDefaultEngine, underDir } from '../lib/pickDefaultEngine'
import logo from '../assets/logo.png'

export type Choice = { mode: 'new' | 'resume'; engine: SessionEngine; sessionId?: string; cwd?: string; name?: string }

function rel(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

export function EntryScreen({
  onChoose,
  onCancel,
  lockedCwd,
}: {
  onChoose: (c: Choice) => void
  onCancel?: () => void
  /** When set, the EntryScreen is being opened inside an existing workspace to
   *  add a session — the repo is fixed, so the cwd picker and the scaffold/
   *  project-browser sections are hidden. Resume listing is auto-filtered to
   *  this repo. */
  lockedCwd?: string
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [cwd, setCwd] = useState(lockedCwd || '') // new-session target
  const [filterDir, setFilterDir] = useState(lockedCwd || '') // resume filter ('' = all)
  const [engine, setEngine] = useState<SessionEngine>('local')
  const [name, setName] = useState('')
  // "new project from template" scaffold form
  const [projName, setProjName] = useState('')
  const [projParent, setProjParent] = useState('')
  const [scaffoldBusy, setScaffoldBusy] = useState(false)
  const [scaffoldErr, setScaffoldErr] = useState('')
  const [defaultParent, setDefaultParent] = useState('') // configured projects dir ('' → ~)
  const parentLabel = defaultParent ? tilde(defaultParent) : '~'

  const pickParent = async () => {
    const d = await window.gt.pickDir()
    if (d) setProjParent(d)
  }
  const createProject = async () => {
    if (!projName.trim() || scaffoldBusy) return
    setScaffoldBusy(true)
    setScaffoldErr('')
    const r = await window.gt.scaffoldProject(projName.trim(), projParent || undefined)
    setScaffoldBusy(false)
    if (r.ok && r.path) onChoose({ mode: 'new', engine, cwd: r.path })
    else setScaffoldErr(r.error || 'scaffold failed')
  }

  useEffect(() => {
    window.gt.listSessions().then((s) => {
      setSessions(s)
      if (s[0]?.cwd) setCwd(s[0].cwd)
      // Default the engine selector to a data-driven choice so the Resume list
      // isn't empty on open: `local` sessions are never resumable, so picking
      // them showed 0 entries even with hundreds of claude/codex sessions.
      setEngine(pickDefaultEngine(s, lockedCwd || undefined))
    })
    window.gt.settings.get().then((s) => {
      setDefaultParent(s.projectsDir)
    })
  }, [])

  // selecting a folder targets the new session there AND filters resume to it
  const selectDir = (path: string) => {
    setCwd(path)
    setFilterDir(path)
  }
  const browse = async () => {
    const dir = await window.gt.pickDir()
    if (dir) selectDir(dir)
  }

  const all = sessions || []
  const byEngine = all.filter((s) => s.engine === engine)
  const shown = filterDir ? byEngine.filter((s) => underDir(s.cwd, filterDir)) : byEngine

  const sel =
    'rounded-lg border border-[var(--gt-border)] bg-black/30 px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-[var(--gt-accent)]/60'

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--gt-bg)]">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <div className="mb-1 flex items-center gap-2.5">
          <img src={logo} alt="" draggable={false} className="h-9 w-9 rounded-lg" />
          <h1 className="gt-grad-text text-2xl font-bold tracking-tight">TerMinal</h1>
          <div className="flex-1" />
          {onCancel && (
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
            >
              <X size={13} strokeWidth={2} />
              cancel
            </button>
          )}
        </div>
        <p className="mb-6 text-sm text-zinc-500">
          {lockedCwd ? (
            <>
              New session in{' '}
              <span className="font-mono text-zinc-300">{tilde(lockedCwd)}</span> — pick "Start"
              for a fresh session or attach to a prior one below.
            </>
          ) : (
            <>
              Start Claude, Codex, or a local shell. This window pins to one session so workspace
              tabs track the same repo.
            </>
          )}
        </p>

        {/* Recently closed workspaces. Click to re-open as a fresh session on
            that repo. Only shown for the "+ workspace" flow — inside a locked
            workspace the recents are irrelevant. */}
        {!lockedCwd &&
          (() => {
            let recents: string[] = []
            try {
              recents = JSON.parse(localStorage.getItem('gt.recentWorkspaces') || '[]')
            } catch {
              /* ignore */
            }
            recents = recents.filter((x) => typeof x === 'string').slice(0, 6)
            if (!recents.length) return null
            return (
              <div className="mb-4">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                  Recent
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {recents.map((r) => (
                    <button
                      key={r}
                      onClick={() => onChoose({ mode: 'new', engine, cwd: r })}
                      title={r}
                      className="rounded-lg border border-[var(--gt-border)] bg-[var(--gt-panel)] px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:border-[var(--gt-accent)]/60"
                    >
                      {r.replace(/\/$/, '').split('/').pop() || r}
                    </button>
                  ))}
                </div>
              </div>
            )
          })()}

        {/* new project from template — hidden when adding inside an existing
            workspace (the repo is fixed) */}
        {!lockedCwd && (
        <div className="mb-4 rounded-2xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-4">
          <div className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-400">
            <FolderGit2 size={13} strokeWidth={2} />
            New project from template
          </div>
          <div className="flex items-center gap-2">
            <input
              value={projName}
              onChange={(e) => {
                setProjName(e.target.value)
                setScaffoldErr('')
              }}
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
              placeholder="project-name"
              spellCheck={false}
              className={`${sel} min-w-0 flex-1 font-mono`}
            />
            <button
              onClick={pickParent}
              title="Choose parent directory"
              className={`${sel} inline-flex shrink-0 items-center gap-1.5 hover:border-[var(--gt-accent)]/60`}
            >
              <FolderOpen size={13} strokeWidth={2} />
              {projParent ? tilde(projParent) : parentLabel}
            </button>
            <button
              onClick={createProject}
              disabled={!projName.trim() || scaffoldBusy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--gt-accent)] px-4 py-2 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              <Plus size={14} strokeWidth={2.5} />
              {scaffoldBusy ? 'Creating…' : 'Create'}
            </button>
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            Copies <span className="font-mono text-zinc-500">project-template</span> →{' '}
            <span className="font-mono text-zinc-500">
              {(projParent ? tilde(projParent) : parentLabel)}/{projName.trim() || 'name'}
            </span>
            , runs <span className="font-mono text-zinc-500">git init</span>, and opens a session there.
          </div>
          {scaffoldErr && <div className="mt-1 text-[11px] text-[var(--gt-red)]">{scaffoldErr}</div>}
        </div>
        )}

        {/* start new */}
        <div className="mb-6 rounded-2xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-4">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-400">
            Start a new session
          </div>
          <div className="mb-2 grid grid-cols-4 gap-2">
            {(['local', 'claude', 'codex', 'cursor'] as SessionEngine[]).map((e) => (
              <button
                key={e}
                onClick={() => setEngine(e)}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium ${
                  engine === e
                    ? 'border-[var(--gt-accent)] bg-[var(--gt-accent)]/15 text-zinc-100'
                    : 'border-[var(--gt-border)] bg-black/20 text-zinc-400 hover:border-[var(--gt-accent)]/50 hover:text-zinc-200'
                }`}
              >
                {e === 'local' ? <SquareTerminal size={14} strokeWidth={2} /> : <EngineLogo engine={e} size={14} />}
                {e}
              </button>
            ))}
          </div>
          {!lockedCwd && (
            <div className="mb-2 flex items-center gap-2">
              <button
                onClick={browse}
                className={`${sel} inline-flex shrink-0 items-center gap-1.5 hover:border-[var(--gt-accent)]/60`}
              >
                <FolderOpen size={13} strokeWidth={2} />
                Folder
              </button>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~ (home)"
                spellCheck={false}
                className={`${sel} min-w-0 flex-1 font-mono`}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="session name (optional)"
              className={`${sel} min-w-0 flex-1`}
            />
            <button
              onClick={() =>
                onChoose({ mode: 'new', engine, cwd: cwd.trim() || undefined, name: name.trim() || undefined })
              }
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--gt-accent)] px-4 py-2 text-[12px] font-semibold text-white hover:opacity-90"
            >
              <Plus size={14} strokeWidth={2.5} />
              New session
            </button>
          </div>
        </div>

        {/* resume */}
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-400">
            Resume {engine}{filterDir ? ` · ${filterDir.split('/').pop()}` : ''} ({shown.length})
          </span>
          {filterDir && (
            <button
              onClick={() => setFilterDir('')}
              className="text-[11px] text-[var(--gt-accent-2)] hover:underline"
            >
              show all
            </button>
          )}
        </div>
        {sessions === null ? (
          <div className="py-6 text-center text-[12px] text-zinc-600">Scanning sessions…</div>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--gt-border)] p-6 text-center text-[12px] text-zinc-600">
            {filterDir ? 'No sessions for this folder — start a new one above.' : `No prior ${engine} sessions found.`}
          </div>
        ) : (
          <div className="space-y-2">
            {shown.slice(0, 300).map((s) => (
              <button
                key={s.id}
                onClick={() => onChoose({ mode: 'resume', engine: s.engine, sessionId: s.id, cwd: s.cwd })}
                className="flex w-full items-center gap-3 rounded-xl border border-[var(--gt-border)] bg-[var(--gt-panel)] p-3 text-left hover:border-[var(--gt-accent)]/60 hover:bg-white/5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-zinc-100">
                    {s.firstUserText || <span className="italic text-zinc-500">untitled session</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 truncate text-[11px] text-zinc-500">
                    <EngineLogo engine={s.engine} size={10} />
                    <span className="font-mono">{tilde(s.cwd) || '~'}</span>
                    {s.gitBranch && (
                      <span className="inline-flex items-center gap-0.5 text-zinc-600">
                        <GitBranch size={11} strokeWidth={2} />
                        {s.gitBranch}
                      </span>
                    )}
                    <span className="text-zinc-600">· {s.turns} turn{s.turns === 1 ? '' : 's'}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right text-[10.5px] text-zinc-500">
                  <div>{rel(s.mtime)}</div>
                  <div className="font-mono text-zinc-600">{s.id.slice(0, 8)}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

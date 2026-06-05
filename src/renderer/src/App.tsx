import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import {
  Columns2,
  Grid2x2,
  LayoutDashboard,
  Plus,
  Settings as SettingsIcon,
  Square,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react'
import { EntryScreen, type Choice } from './components/EntryScreen'
import { FleetView } from './components/FleetView'
import { SettingsPanel } from './components/SettingsPanel'
import { TaskComposer, type TaskComposerSeed } from './components/TaskComposer'
import { Onboarding } from './components/Onboarding'
import { SessionView, type Info } from './SessionView'
import logo from './assets/logo.png'
import { ALL_TABS } from './tabs/registry'
import { navigateTo } from './lib/nav'
import { resolveWorkspaceHotkey, cycleIndex } from './lib/hotkeys'
import type { Engine, FleetSession, SessionEngine, TabContext } from './lib/types'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

type Sess = { key: string; choice: Choice; info: Info }
export type TerminalLayout = 'single' | 'split' | 'grid4'

const cwdOf = (s: Sess) => s.info.cwd || s.choice.cwd || ''
const repoLabelOf = (cwd: string) => cwd.replace(/\/$/, '').split('/').pop() || cwd || 'untitled'
const loadTerminalLayout = (): TerminalLayout => {
  try {
    const raw = localStorage.getItem('gt.terminalLayout')
    if (raw === 'single' || raw === 'split' || raw === 'grid4') return raw
  } catch {
    /* ignore */
  }
  return 'single'
}
const loadTerminalSessionOrder = (): Record<string, string[]> => {
  try {
    const raw = localStorage.getItem('gt.terminalSessionOrder')
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => Array.isArray(value))
        .map(([root, value]) => [root, (value as unknown[]).filter((x): x is string => typeof x === 'string')]),
    )
  } catch {
    return {}
  }
}

// A workspace groups every session that lives under the same repo root. The
// top tab bar shows ONE pill per workspace with the sessions rendered inline
// inside it — so the model maps to the user's mental model ("project →
// terminals") instead of the old session-first flat list.
type Workspace = { repoRoot: string; label: string; sessions: Sess[] }

// Trim a transcript's first user message into a session-tab-friendly label.
// 24 chars fits comfortably in the in-Terminal session sub-bar. We drop
// leading skill-style triggers ("/something …") so the label reads as the
// task intent, not the command surface.
const labelFromPrompt = (raw: string): string => {
  let s = raw.replace(/\s+/g, ' ').trim()
  if (s.startsWith('/')) {
    const space = s.indexOf(' ')
    if (space > 0) s = s.slice(space + 1).trim()
  }
  if (!s) return ''
  if (s.length <= 24) return s
  return s.slice(0, 23).trimEnd() + '…'
}

const labelForSession = (
  s: Sess,
  indexInWorkspace: number,
  autoNamesByKey: Map<string, string>,
) => {
  if (s.choice.name) return s.choice.name
  const auto = autoNamesByKey.get(s.key)
  if (auto) return auto
  if (s.choice.mode === 'resume' && s.choice.sessionId) return s.choice.sessionId.slice(0, 6)
  // Default is the session's ordinal within the workspace — short and stable
  // (1, 2, 3 within "Repo-A"). Index is computed at render time.
  return `S${indexInWorkspace + 1}`
}

// open sessions persist to localStorage so the window reopens to your workspace
type Saved = {
  key: string
  sessionId: string
  cwd: string
  name: string
  engine?: SessionEngine
  mode?: 'new' | 'resume'
}
const restored: Saved[] = (() => {
  try {
    return JSON.parse(localStorage.getItem('gt.openSessions') || '[]')
  } catch {
    return []
  }
})().filter((s: Saved) => s?.sessionId)

export default function App() {
  const [sessions, setSessions] = useState<Sess[]>(() =>
    restored.map((s) => {
      const engine = s.engine || 'claude'
      return {
        key: s.key,
        choice: {
          mode: s.mode || 'resume',
          engine,
          sessionId: s.sessionId,
          cwd: s.cwd,
          name: s.name,
        },
        info: { sessionId: s.sessionId, cwd: s.cwd },
      }
    }),
  )
  const [activeKey, setActiveKey] = useState<string | null>(restored[restored.length - 1]?.key ?? null)
  // adding === 'workspace' → EntryScreen pick a repo (free cwd)
  // adding === { repoRoot } → EntryScreen inside an existing workspace, cwd locked
  // false → no overlay
  const [adding, setAdding] = useState<false | 'workspace' | { repoRoot: string }>(
    restored.length === 0 ? 'workspace' : false,
  )

  // persist the open sessions (only those with a real session id, i.e. started)
  useEffect(() => {
    const data: Saved[] = sessions
      .map((s) => ({
        key: s.key,
        sessionId: s.info.sessionId || (s.choice.mode === 'resume' ? s.choice.sessionId || '' : ''),
        cwd: s.info.cwd || s.choice.cwd || '',
        name: s.choice.name || '',
        engine: s.choice.engine || 'claude',
        mode: s.choice.mode,
      }))
      .filter((s) => s.sessionId)
    localStorage.setItem('gt.openSessions', JSON.stringify(data))
  }, [sessions])
  const [fullscreen, setFullscreen] = useState(false)
  const [fleet, setFleet] = useState(false)
  const [terminalLayout, setTerminalLayout] = useState<TerminalLayout>(loadTerminalLayout)
  const [terminalSessionOrder, setTerminalSessionOrder] =
    useState<Record<string, string[]>>(loadTerminalSessionOrder)
  const [draggingSessionKey, setDraggingSessionKey] = useState<string | null>(null)
  const [fleetData, setFleetData] = useState<FleetSession[]>([])
  const [activeCtx, setActiveCtx] = useState<TabContext | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // null = closed; {} = open empty; seeded = open pre-filled (ticket launch)
  const [taskComposer, setTaskComposer] = useState<TaskComposerSeed | null>(null)
  const [onboarded, setOnboarded] = useState<boolean | null>(null) // null = loading

  // first-run gate: show onboarding until the user completes (or skips) it
  useEffect(() => {
    window.gt.settings.get().then((s) => setOnboarded(s.onboarded))
  }, [])

  // macOS hides the traffic lights in fullscreen — drop the 78px reserve for them
  useEffect(() => {
    window.gt.isFullscreen().then(setFullscreen)
    return window.gt.onFullscreen(setFullscreen)
  }, [])

  // poll the fleet snapshot for the overview + live status dots on the tabs
  useEffect(() => {
    if (sessions.length === 0) return
    const tick = () => window.gt.fleet().then(setFleetData)
    tick()
    const id = setInterval(tick, 3000)
    return () => clearInterval(id)
  }, [sessions.length])
  useEffect(() => {
    localStorage.setItem('gt.terminalLayout', terminalLayout)
  }, [terminalLayout])
  useEffect(() => {
    localStorage.setItem('gt.terminalSessionOrder', JSON.stringify(terminalSessionOrder))
  }, [terminalSessionOrder])
  const statusByKey = Object.fromEntries(fleetData.map((f) => [f.key, f.status]))

  useEffect(() => {
    if (!activeKey || adding !== false || sessions.length === 0) return
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      window.gt
        .tabContext()
        .then((ctx) => {
          if (!cancelled) setActiveCtx(ctx)
        })
        .catch(() => {
          if (!cancelled) setActiveCtx(null)
        })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [activeKey, adding, sessions.length])

  // Fire the IPC immediately AND flip activeKey in the same tick. Main
  // processes IPCs FIFO — so any tabContext / tick / data IPC the newly-active
  // SessionView fires next will see the post-setActiveSession cur(). The old
  // await pattern (await IPC → setActiveKey) made switching feel sluggish
  // because the visibility flip waited for the IPC roundtrip; dropping the
  // await keeps the visual swap snappy without introducing a real race.
  const activate = (key: string) => {
    setActiveKey(key)
    window.gt.setActiveSession(key).catch(() => {
      /* main rejected (e.g. session removed) — UI already flipped, accept */
    })
  }

  const addSession = (choice: Choice) => {
    const key = crypto.randomUUID()
    setSessions((s) => [...s, { key, choice, info: { sessionId: '', cwd: '' } }])
    activate(key)
    setAdding(false)
  }
  const closeSession = (key: string) => {
    window.gt.stopSession(key)
    setSessions((s) => {
      const next = s.filter((x) => x.key !== key)
      if (activeKey === key) {
        const fallback = next[next.length - 1]?.key ?? null
        if (fallback) activate(fallback)
        else setActiveKey(null)
      }
      if (next.length === 0) setAdding('workspace')
      return next
    })
  }
  const setInfo = (key: string, info: Info) =>
    setSessions((s) => s.map((x) => (x.key === key ? { ...x, info } : x)))
  const renameSession = (key: string, name: string) =>
    setSessions((s) =>
      s.map((x) => (x.key === key ? { ...x, choice: { ...x.choice, name } } : x)),
    )

  // Auto-naming: for any session WITHOUT an explicit user-set name, poll the
  // first user prompt and use a truncated version as the auto-label. Polls
  // every 4s until we have one (transcripts grow during the session). Once
  // landed, we stop polling for that session — the user can either keep the
  // auto-name or override with double-click rename.
  const [autoNamesByKey, setAutoNamesByKey] = useState<Map<string, string>>(() => new Map())
  useEffect(() => {
    const sessionsToPoll = sessions.filter(
      (s) => !s.choice.name && (s.info.sessionId || s.choice.sessionId) && !autoNamesByKey.has(s.key),
    )
    if (sessionsToPoll.length === 0) return
    let cancelled = false
    const poll = async () => {
      for (const s of sessionsToPoll) {
        const sid = s.info.sessionId || s.choice.sessionId
        if (!sid) continue
        try {
          const first = await window.gt.firstPrompt(sid)
          const label = labelFromPrompt(first || '')
          if (!cancelled && label) {
            setAutoNamesByKey((prev) => {
              if (prev.has(s.key)) return prev
              const next = new Map(prev)
              next.set(s.key, label)
              return next
            })
          }
        } catch {
          /* ignore */
        }
      }
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sessions, autoNamesByKey])

  // Clear auto-name for a session when it's removed so the Map doesn't grow
  // forever as sessions cycle through.
  useEffect(() => {
    const liveKeys = new Set(sessions.map((s) => s.key))
    if ([...autoNamesByKey.keys()].some((k) => !liveKeys.has(k))) {
      setAutoNamesByKey((prev) => {
        const next = new Map<string, string>()
        for (const [k, v] of prev) if (liveKeys.has(k)) next.set(k, v)
        return next
      })
    }
  }, [sessions, autoNamesByKey])

  // Group sessions by repo root so the top bar can render workspace pills.
  // We key on cwd verbatim — two sessions at the same path are siblings, two
  // at different paths are different workspaces even if the basenames collide.
  const workspaces: Workspace[] = useMemo(() => {
    const map = new Map<string, Workspace>()
    for (const s of sessions) {
      const root = cwdOf(s) || '(no cwd)'
      if (!map.has(root)) map.set(root, { repoRoot: root, label: repoLabelOf(root), sessions: [] })
      map.get(root)!.sessions.push(s)
    }
    return [...map.values()].map((ws) => {
      const order = terminalSessionOrder[ws.repoRoot] ?? []
      const rank = new Map(order.map((key, i) => [key, i]))
      return {
        ...ws,
        sessions: ws.sessions
          .map((session, originalIndex) => ({ session, originalIndex }))
          .sort((a, b) => {
            const aRank = rank.get(a.session.key)
            const bRank = rank.get(b.session.key)
            if (aRank !== undefined || bRank !== undefined) {
              return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER)
            }
            return a.originalIndex - b.originalIndex
          })
          .map(({ session }) => session),
      }
    })
  }, [sessions, terminalSessionOrder])
  const activeWorkspaceRoot = useMemo(() => {
    const s = sessions.find((x) => x.key === activeKey)
    return s ? cwdOf(s) : ''
  }, [sessions, activeKey])
  const activeWorkspaceSessions = useMemo(
    () => workspaces.find((w) => w.repoRoot === activeWorkspaceRoot)?.sessions ?? [],
    [workspaces, activeWorkspaceRoot],
  )

  // Cmd+1..9 jumps to a workspace (activating its first session); Cmd+Shift+[ ]
  // cycles. Keyboard quick-switch for the growing top bar — ticket #18.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hk = resolveWorkspaceHotkey(e, workspaces.length)
      if (!hk) return
      e.preventDefault()
      let idx = -1
      if (hk.kind === 'select') idx = hk.index
      else {
        const cur = workspaces.findIndex((w) => w.repoRoot === activeWorkspaceRoot)
        idx = cycleIndex(cur < 0 ? 0 : cur, workspaces.length, hk.kind)
      }
      const first = workspaces[idx]?.sessions[0]?.key
      if (first) activate(first)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [workspaces, activeWorkspaceRoot])

  // ⌘K opens the task composer from ANY tab — the task-first entry point
  // (type a task; role routing picks the engines; no session needed). Other
  // surfaces (Tickets tab rows) pre-seed it via the gt:task-compose event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        setTaskComposer((cur) => (cur ? cur : {}))
      }
    }
    const onCompose = (e: Event) => {
      const detail = (e as CustomEvent).detail as TaskComposerSeed | undefined
      setTaskComposer(detail ?? {})
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('gt:task-compose', onCompose)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('gt:task-compose', onCompose)
    }
  }, [])
  const visibleSessionOrder = useMemo(() => {
    if (!activeKey) return []
    if (terminalLayout === 'single') return [activeKey]
    const limit = terminalLayout === 'split' ? 2 : 4
    const keys = activeWorkspaceSessions.map((s) => s.key)
    const visible = keys.slice(0, limit)
    if (activeKey && !visible.includes(activeKey) && visible.length > 0) {
      visible[visible.length - 1] = activeKey
    }
    return visible
  }, [activeKey, activeWorkspaceSessions, terminalLayout])
  const visibleSessionKeys = useMemo(() => new Set(visibleSessionOrder), [visibleSessionOrder])
  const visibleSessionRank = useMemo(
    () => new Map(visibleSessionOrder.map((key, i) => [key, i])),
    [visibleSessionOrder],
  )
  const multiTerminal = terminalLayout !== 'single' && visibleSessionKeys.size > 1

  // Pre-compute peer-session lists ONCE per workspace, then look up by session
  // key in the map. Without this, every App re-render (every fleet tick, every
  // status-by-key change) generates a fresh peerSessions array for each
  // SessionView prop, which makes React see "new" props on every render and
  // bypass any downstream memoization in SessionView.
  const peersByKey = useMemo(() => {
    const m = new Map<
      string,
      { key: string; label: string; status: string; mode: 'new' | 'resume'; engine: SessionEngine }[]
    >()
    for (const ws of workspaces) {
      const peers = ws.sessions.map((x, i) => ({
        key: x.key,
        label: labelForSession(x, i, autoNamesByKey),
        status: statusByKey[x.key] || 'idle',
        mode: x.choice.mode,
        engine: x.choice.engine,
      }))
      for (const s of ws.sessions) m.set(s.key, peers)
    }
    return m
  }, [workspaces, statusByKey, autoNamesByKey])

  const closeWorkspace = (root: string) => {
    const ws = workspaces.find((w) => w.repoRoot === root)
    if (!ws) return
    if (ws.sessions.length > 1) {
      if (!confirm(`Close all ${ws.sessions.length} sessions in ${ws.label}?`)) return
    }
    for (const s of ws.sessions) window.gt.stopSession(s.key)
    setSessions((prev) => prev.filter((x) => cwdOf(x) !== root))
    // Push to recents so it shows up on the EntryScreen for one-click reopen.
    try {
      const prev = (JSON.parse(localStorage.getItem('gt.recentWorkspaces') || '[]') as string[])
        .filter((x) => typeof x === 'string' && x !== root)
      localStorage.setItem('gt.recentWorkspaces', JSON.stringify([root, ...prev].slice(0, 8)))
    } catch {
      /* localStorage glitch — best effort */
    }
    if (activeWorkspaceRoot === root) {
      const fallback = sessions.find((x) => cwdOf(x) !== root)?.key ?? null
      if (fallback) activate(fallback)
      else {
        setActiveKey(null)
        setAdding('workspace')
      }
    }
  }

  const reorderSession = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return
    const ws = workspaces.find((w) => w.sessions.some((s) => s.key === fromKey))
    if (!ws || !ws.sessions.some((s) => s.key === toKey)) return
    const keys = ws.sessions.map((s) => s.key)
    const fromIndex = keys.indexOf(fromKey)
    const toIndex = keys.indexOf(toKey)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = keys.splice(fromIndex, 1)
    keys.splice(keys.indexOf(toKey), 0, moved)
    setTerminalSessionOrder((prev) => ({ ...prev, [ws.repoRoot]: keys }))
  }

  const handleSessionChipDrop = (e: DragEvent, toKey: string) => {
    e.preventDefault()
    const fromKey = e.dataTransfer.getData('application/x-terminal-session') || draggingSessionKey
    if (fromKey) reorderSession(fromKey, toKey)
    setDraggingSessionKey(null)
  }

  const showEntry = adding !== false || sessions.length === 0
  const layoutButton = (
    mode: TerminalLayout,
    title: string,
    Icon: LucideIcon,
    disabled = false,
  ) => (
    <button
      key={mode}
      style={noDrag}
      onClick={() => !disabled && setTerminalLayout(mode)}
      disabled={disabled}
      title={title}
      className={`flex h-6 w-7 items-center justify-center rounded-md transition-colors ${
        terminalLayout === mode
          ? 'bg-[var(--gt-accent)]/25 text-zinc-100'
          : disabled
            ? 'cursor-not-allowed text-zinc-700'
            : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200'
      }`}
    >
      <Icon size={13} strokeWidth={2} />
    </button>
  )
  // hold the UI until we know onboarding state (avoids the entry screen flashing
  // before first-run setup)
  if (onboarded === null)
    return (
      <div className="flex h-full items-center justify-center bg-[var(--gt-bg)]">
        <img src={logo} alt="" draggable={false} className="h-12 w-12 animate-pulse rounded-xl" />
      </div>
    )
  if (!onboarded)
    return (
      <div className="h-full bg-[var(--gt-bg)]">
        <Onboarding onDone={() => setOnboarded(true)} />
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      {/* session tab bar (top-level, also the window drag region) */}
      <header
        style={drag}
        className={`flex h-9 shrink-0 items-center border-b border-[var(--gt-border)] bg-[var(--gt-bg)] pr-2 ${
          fullscreen ? 'pl-3' : 'pl-[78px]'
        }`}
      >
        {/* brand mark — the logo asset is already tightly cropped, so it fills
            the box at scale-1 (no extra zoom) */}
        <div className="mr-2.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-[5px]">
          <img
            src={logo}
            alt="TerMinal"
            draggable={false}
            className="h-full w-full object-cover"
          />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {workspaces.map((ws) => {
            const workspaceActive = ws.repoRoot === activeWorkspaceRoot
            // Workspace pill is intentionally minimal: label + count + close.
            // Switching between sessions inside the workspace happens in the
            // Terminal-tab session sub-bar inside SessionView — top bar shows
            // PROJECTS, not pty instances.
            const anyWorking = ws.sessions.some((s) => statusByKey[s.key] === 'working')
            return (
              <div
                key={ws.repoRoot}
                style={noDrag}
                title={ws.repoRoot}
                onClick={() =>
                  activate(
                    ws.sessions.find((s) => s.key === activeKey)?.key || ws.sessions[0].key,
                  )
                }
                className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] ${
                  workspaceActive
                    ? 'border-[var(--gt-accent)]/50 bg-[var(--gt-accent)]/15 text-zinc-100'
                    : 'border-[var(--gt-border)] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span
                  title={anyWorking ? 'a session is working' : 'idle'}
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    anyWorking ? 'bg-[var(--gt-green)] gt-pulse' : 'bg-[var(--gt-accent-2)]'
                  }`}
                />
                <span className="max-w-[180px] truncate font-semibold">{ws.label}</span>
                {ws.sessions.length > 1 && (
                  <span className="rounded-full bg-black/30 px-1 text-[9.5px] tabular-nums text-zinc-500">
                    {ws.sessions.length}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeWorkspace(ws.repoRoot)
                  }}
                  title={
                    ws.sessions.length > 1
                      ? `Close ${ws.label} (${ws.sessions.length} sessions)`
                      : `Close ${ws.label}`
                  }
                  className="ml-0.5 flex items-center rounded p-0.5 text-zinc-600 hover:bg-white/10 hover:text-zinc-200"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
            )
          })}
          <button
            style={noDrag}
            onClick={() => setAdding('workspace')}
            title="New workspace"
            className="flex shrink-0 items-center gap-1 rounded-md border border-dashed border-[var(--gt-border)] px-1.5 py-1 text-[11px] text-zinc-500 hover:border-[var(--gt-accent)]/60 hover:text-zinc-200"
          >
            <Plus size={12} strokeWidth={2.5} />
            workspace
          </button>
        </div>
        {sessions.length > 0 && (
          <button
            style={noDrag}
            onClick={() => setFleet((f) => !f)}
            title="Fleet overview — all sessions at a glance"
            className={`ml-1 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ${
              fleet
                ? 'bg-[var(--gt-accent)]/20 text-zinc-100'
                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            <LayoutDashboard size={13} strokeWidth={2} />
            Fleet
          </button>
        )}
        <button
          style={noDrag}
          onClick={() => setShowSettings(true)}
          title="Settings"
          className="ml-1 flex shrink-0 items-center rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
        >
          <SettingsIcon size={14} strokeWidth={2} />
        </button>
      </header>

      {/* one SessionView per session; all mounted (PTYs persist), selected sessions visible.
          The entry screen overlays (rather than replacing) so existing sessions
          stay mounted and their ptys aren't respawned. */}
      <div className="relative min-h-0 flex-1">
        {multiTerminal && !showEntry && (
          <div className="absolute inset-x-0 top-0 z-10 flex h-8 items-center gap-0.5 border-b border-[var(--gt-border)] bg-[var(--gt-bg)] px-2 text-zinc-300">
            <button
              style={noDrag}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--gt-accent)]/20 px-2.5 py-1 text-[11px] font-medium text-zinc-100"
            >
              <SquareTerminal size={13} strokeWidth={2} />
              Terminal
            </button>
            {activeCtx &&
              ALL_TABS.filter((t) => t.appliesTo(activeCtx)).map((t) => (
                <button
                  key={t.id}
                  style={noDrag}
                  onClick={() => {
                    setTerminalLayout('single')
                    requestAnimationFrame(() => navigateTo(t.id))
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                >
                  <t.icon size={13} strokeWidth={2} />
                  {t.id === 'mrs' ? `${activeCtx.forgeLabel}s` : t.title}
                </button>
              ))}
          </div>
        )}
        {multiTerminal && !showEntry && (
          <div className="absolute inset-x-0 top-8 z-10 flex h-7 items-center gap-1 border-b border-[var(--gt-border)] bg-[var(--gt-panel)]/70 px-2 text-[11px]">
            <span className="mr-1 text-[9.5px] uppercase tracking-wider text-zinc-600">
              terminal
            </span>
            {(peersByKey.get(activeKey || '') || []).map((p) => {
              const visible = visibleSessionKeys.has(p.key)
              return (
                <button
                  key={p.key}
                  draggable
                  onDragStart={(e) => {
                    setDraggingSessionKey(p.key)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('application/x-terminal-session', p.key)
                  }}
                  onDragOver={(e) => {
                    if (draggingSessionKey && draggingSessionKey !== p.key) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }
                  }}
                  onDrop={(e) => handleSessionChipDrop(e, p.key)}
                  onDragEnd={() => setDraggingSessionKey(null)}
                  onClick={() => {
                    navigateTo('terminal')
                    activate(p.key)
                  }}
                  className={`flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 ${
                    p.key === activeKey
                      ? 'bg-[var(--gt-accent)]/25 text-zinc-100'
                      : draggingSessionKey === p.key
                        ? 'text-zinc-500 opacity-60'
                      : visible
                        ? 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
                        : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200'
                  }`}
                >
                  <span
                    title={p.status === 'working' ? 'working' : 'idle'}
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      p.status === 'working' ? 'bg-[var(--gt-green)] gt-pulse' : 'bg-[var(--gt-accent-2)]'
                    }`}
                  />
                  <span className="max-w-[120px] truncate">{p.label}</span>
                </button>
              )
            })}
            <button
              onClick={() => setAdding({ repoRoot: activeWorkspaceRoot || '' })}
              title="New session in this workspace"
              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            >
              <Plus size={11} strokeWidth={2.5} />
            </button>
            <div className="flex-1" />
            <div
              style={noDrag}
              className="flex h-7 shrink-0 items-center rounded-lg border border-[var(--gt-border)] bg-[var(--gt-panel)]/70 p-0.5"
            >
              {layoutButton('single', 'Single terminal with cockpit', Square)}
              {layoutButton('split', 'Split terminal columns', Columns2, activeWorkspaceSessions.length < 2)}
              {layoutButton('grid4', 'Four-terminal grid', Grid2x2, activeWorkspaceSessions.length < 2)}
            </div>
          </div>
        )}
        <div
          className={`absolute inset-0 ${
            multiTerminal ? 'grid gap-px bg-[var(--gt-border)] pt-[60px]' : ''
          }`}
          style={
            multiTerminal
              ? {
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gridTemplateRows:
                    terminalLayout === 'grid4' ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
                }
              : undefined
          }
        >
        {sessions.map((s) => {
          const peers = peersByKey.get(s.key)
          const visible = !showEntry && visibleSessionKeys.has(s.key)
          const status = statusByKey[s.key] || 'idle'
          return (
            <div
              key={s.key}
              onPointerDownCapture={() => {
                if (multiTerminal && s.key !== activeKey) activate(s.key)
              }}
              onFocusCapture={() => {
                if (multiTerminal && s.key !== activeKey) activate(s.key)
              }}
              className={
                visible
                  ? multiTerminal
                    ? `relative min-h-0 min-w-0 overflow-hidden border bg-[var(--gt-bg)] ${
                        status === 'working'
                          ? 'border-[var(--gt-green)]/25'
                          : 'border-[var(--gt-yellow)]/60'
                      } ${
                        s.key === activeKey
                          ? 'outline outline-1 -outline-offset-1 outline-[var(--gt-accent)]/70'
                          : ''
                      }`
                    : 'absolute inset-0'
                  : 'absolute inset-0'
              }
              style={{
                visibility: visible ? 'visible' : 'hidden',
                order: multiTerminal ? visibleSessionRank.get(s.key) : undefined,
              }}
            >
              <SessionView
                sessionKey={s.key}
                choice={s.choice}
                active={!showEntry && s.key === activeKey}
                onStarted={(i) => setInfo(s.key, i)}
                peerSessions={peers}
                onSwitchSession={activate}
                onAddSession={() => setAdding({ repoRoot: cwdOf(s) || '' })}
                onCloseSession={closeSession}
                onRenameSession={renameSession}
                onReorderSession={reorderSession}
                terminalTile={multiTerminal}
                terminalLayout={terminalLayout}
                onTerminalLayoutChange={setTerminalLayout}
                canSplitTerminal={activeWorkspaceSessions.length >= 2}
                focusTerminal={s.key === activeKey}
              />
            </div>
          )
        })}
        </div>
        {fleet && !showEntry && (
          <div className="absolute inset-0 z-40 bg-[var(--gt-bg)]">
            <FleetView
              sessions={fleetData}
              activeKey={activeKey}
              onPick={(key) => {
                activate(key)
                setFleet(false)
              }}
              onNew={() => {
                setFleet(false)
                setAdding('workspace')
              }}
              onClose={() => setFleet(false)}
            />
          </div>
        )}
        {showEntry && (
          <div className="absolute inset-0 z-50 bg-[var(--gt-bg)]">
            <EntryScreen
              onChoose={(c) => {
                // When entering inside an existing workspace, force the cwd
                // even if the user typed something else (defensive — the UI
                // hides the cwd input but onChoose can still set it).
                if (adding && typeof adding === 'object') {
                  addSession({ ...c, cwd: adding.repoRoot })
                } else {
                  addSession(c)
                }
              }}
              onCancel={sessions.length ? () => setAdding(false) : undefined}
              lockedCwd={adding && typeof adding === 'object' ? adding.repoRoot : undefined}
            />
          </div>
        )}
      </div>
      {taskComposer && (
        <TaskComposer
          seed={taskComposer}
          activeRepoRoot={activeWorkspaceRoot}
          onClose={() => setTaskComposer(null)}
        />
      )}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onRerunSetup={() => {
            setShowSettings(false)
            setOnboarded(false)
          }}
        />
      )}
    </div>
  )
}

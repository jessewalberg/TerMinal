import { app, shell, BrowserWindow, ipcMain, dialog, clipboard, Tray, Menu, nativeImage, safeStorage } from 'electron'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { statSync, existsSync, readdirSync, readFileSync, writeFileSync, openSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn as cpSpawn, execFileSync } from 'node:child_process'
import * as pty from 'node-pty'

// The main bundle is ESM (package.json "type": "module"), so __dirname doesn't
// exist — derive the module dir the ESM-canonical way or the window never opens.
const moduleDir = dirname(fileURLToPath(import.meta.url))

function sourceCheckoutRoot(marker: string): string {
  const candidates = [
    process.env.GT_TERMINAL_REPO || '',
    process.cwd(),
    app.getAppPath(),
    join(moduleDir, '..', '..'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, marker))) return c
  }
  return ''
}

// Ordered template dirs to probe for bootstrap.sh. A configured *local path*
// points straight at the template dir; the source-checkout roots need the
// templates/project-template suffix appended. The packaged app matches none of
// these (templates/ isn't bundled) and falls back to a clone — see
// workspace:bootstrap.
function templateDirCandidates(): string[] {
  const configured = resolvedTemplateRepo()
  const dirs: string[] = []
  if (configured && !isTemplateUrl(configured)) dirs.push(configured)
  const roots = [
    process.env.GT_TERMINAL_REPO || '',
    process.cwd(),
    app.getAppPath(),
    join(moduleDir, '..', '..'),
  ].filter(Boolean)
  for (const r of roots) dirs.push(join(r, 'templates', 'project-template'))
  return dirs
}

// Shallow-clone the template repo into a temp dir; null when the clone yields no
// usable checkout (offline, unreachable repo, or no bootstrap.sh). Caller owns cleanup.
function cloneTemplateToTmp(repo: string): TemplateSource | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'gt-bootstrap-'))
    execFileSync('git', ['clone', '--depth', '1', repo, dir], { stdio: 'ignore', timeout: 60_000 })
    if (!existsSync(join(dir, 'bootstrap.sh'))) {
      rmSync(dir, { recursive: true, force: true })
      return null
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  } catch {
    return null
  }
}
import {
  readTranscriptStats,
  readCursorStats,
  readHarnessTdd,
  listSessions,
  findSessionFile,
  readSessionTasks,
  lastAssistantTurn,
} from './data'
import { fixPath, detectEnv, installGtNotify } from './env'
import { emitActivity, readActivity, clearActivity, onActivity, startActivityTail } from './events'
import { readUsage } from './usage'
import { listCommandWidgets, runCommand } from './widgets'
import { repoRootOf, repoForCwd, gitStatus } from './repo'
import { listTickets, getTicket, createTicket, updateTicket, type NewTicket } from './backlog'
import { listMrs, getMr, getMrDiff, getMrCi, mergeMr, mrSummary } from './mrs'
import { listSkills } from './skills'
import { forgeFor } from './forge'
import { readNotes, writeNotes, type NotesScope } from './notes'
import { listDir, readFile, writeFile, searchRepo, createEntry, renameEntry, removeEntry } from './files'
import { listProjectSessions, getProjectSession, hasSessions as repoHasSessions } from './sessions'
import { listDocs, readDoc } from './docs'
import {
  listDisabled,
  setDisabled as setAgentDisabled,
  setAllDisabled as setAllSchedulesDisabled,
} from './agents-disabled'
import { scaffoldProject } from './scaffold'
import { pickTemplateSource, isTemplateUrl, type TemplateSource } from './template'
import {
  readSettings,
  patchSettings,
  initSecretSealer,
  telegramControlEnabled,
  resolvedProjectsDir,
  resolvedEditorApp,
  resolvedBrowserApp,
  resolvedTemplateRepo,
  enginePath,
  type SettingsPatch,
} from './settings'
import {
  configureTelegramControl,
  markTelegramControlEnabled,
  pollTelegramOnce,
  testTelegram,
} from './telegram'
import {
  readAgents,
  saveAgent,
  resetAgent,
  hasAgents as repoHasAgents,
  runAgent,
  runTicketAgent,
  runTicketSpawn,
  runFactorySpawn,
  runDesignerSpawn,
  runScheduleDesignerSpawn,
  locateScript,
  readAgentState,
  resetAgentState,
  convertAgentToScript,
  runPrAgent,
  listPipelines,
  listRuns,
  readAgentRunLog,
  cancelRun,
  removeWorktree,
  onAgentEvent,
  loadPersistedRuns,
  type Engine,
  type PrAgentKind,
} from './agents'
import {
  readSchedules,
  addSchedule,
  updateSchedule,
  removeSchedule,
  toggleSchedule,
  getSchedule,
  type NewSchedule,
} from './schedules'
import {
  installRunner,
  installCli,
  installMcpServer,
  // mcp-register pulled separately below; not part of launchd helpers.
  reconcileSchedules,
  syncSchedule,
  unscheduleJob,
  removeAllJobs,
  runScheduleNow,
} from './launchd'
import { rerunRun } from './rerun'
import type { UnifiedRun } from './cron-runs'
import { registerMcpEverywhere } from './mcp-register'
import { readCronRuns, readCronRunLog, listAllRuns, sweepStaleCronRuns } from './cron-runs'
import { watchCronRuns, type CronRunsWatcher } from './cron-run-watch'
import { publishRunsChanged, shouldPublishRunsChanged } from './run-change-events'
import { summaryFor, agentROI, dailySpend, listAIRuns, type Range } from './ai-runs'
import { startAICollectionLoop } from './ai-collectors'
import { knownModels } from './ai-pricing'
import { startMenuBar } from './tray'
import {
  readBudgets,
  setDailyCap,
  setAgentCap,
  setOverride,
  gateSpawn,
  startBudgetWatcher,
} from './budgets'
import {
  spawnBgTask,
  listBgTasks,
  getBgTask,
  cancelBgTask,
  readBgTaskLog,
  startBgWatcher,
  type BgTask,
} from './bg-tasks'
import { startCiWebhookServer, stopCiWebhookServer } from './ci-webhook'
import { readHitl, fileHitl, resolveHitl, removeHitl, type HitlItem } from './hitl'
import { factoryHealth } from './factory-health'
import { describeSpec, nextRun, type ScheduleSpec } from './cron'
import { readPersonas } from './personas'

const LOGIN_SHELL = process.env.SHELL || '/bin/zsh'

let win: BrowserWindow | null = null
let cronRunsWatcher: CronRunsWatcher | null = null

// Safe send: the PTY + watcher keep firing during window reload/close, and
// win.webContents may already be destroyed — sending then throws an uncaught
// "Object has been destroyed" that crashes the main process.
function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

function sendRunsChanged() {
  publishRunsChanged((channel, payload) => send(channel, payload), listAllRuns)
}

function ensureCronRunsWatcher() {
  if (!cronRunsWatcher) cronRunsWatcher = watchCronRuns(sendRunsChanged)
}

// One window now hosts MANY sessions, each its own PTY, keyed by a renderer-
// generated tab key. Data IPC reads the *active* session; PTY IPC is routed by
// key so every (even backgrounded) terminal keeps streaming.
type SessionEngine = Engine | 'local'
type Pinned = {
  sessionId: string
  cwd: string
  mode: '' | 'new' | 'resume'
  name: string
  engine: SessionEngine
  startedAt: number // ms — used to attribute the cursor chat store this session created
}
const sessions = new Map<string, { pty: pty.IPty; pinned: Pinned }>()
let activeKey = ''
const cur = (): Pinned =>
  sessions.get(activeKey)?.pinned ?? { sessionId: '', cwd: '', mode: '', name: '', engine: 'claude', startedAt: 0 }

type StartOpts = {
  mode: 'new' | 'resume'
  engine?: SessionEngine
  sessionId?: string
  cwd?: string
  name?: string
  cols: number
  rows: number
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`)

function startSession(key: string, opts: StartOpts) {
  sessions.get(key)?.pty.kill()

  const cwd = opts.cwd || homedir()
  const engine = opts.engine || 'claude'
  const args: string[] = []
  let sessionId: string

  if (engine === 'local') {
    sessionId = opts.sessionId || randomUUID()
  } else if (engine === 'codex') {
    args.push('-s', 'danger-full-access', '-a', 'never')
    if (opts.mode === 'resume' && opts.sessionId) {
      sessionId = opts.sessionId
      args.push('resume', sessionId)
    } else {
      sessionId = randomUUID()
    }
  } else if (engine === 'cursor') {
    // cursor-agent owns its own chat id; we key the session by our own uuid and
    // launch with --force (run-everything), the interactive equivalent of
    // codex's danger-full-access. Resume is via cursor's own --resume/--continue
    // TUI inside the session (we don't enumerate ~/.cursor for the picker).
    if (opts.mode === 'resume' && opts.sessionId) {
      sessionId = opts.sessionId
      args.push('--resume', sessionId)
    } else {
      sessionId = randomUUID()
      args.push('--force')
    }
  } else if (opts.mode === 'resume' && opts.sessionId) {
    sessionId = opts.sessionId
    args.push('--resume', sessionId)
  } else {
    sessionId = randomUUID()
    args.push('--session-id', sessionId)
    if (opts.name) args.push('--name', opts.name)
  }

  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: process.env.TERM_PROGRAM || 'TerMinal',
    CLICOLOR: '1',
  } as Record<string, string>
  delete env.NO_COLOR

  const proc =
    engine === 'local'
      ? pty.spawn(LOGIN_SHELL, ['-l'], {
          name: 'xterm-256color',
          cols: opts.cols || 80,
          rows: opts.rows || 30,
          cwd,
          env,
        })
      : pty.spawn(LOGIN_SHELL, ['-l', '-c', [enginePath(engine), ...args].map(shq).join(' ')], {
          name: 'xterm-256color',
          cols: opts.cols || 80,
          rows: opts.rows || 30,
          cwd,
          env,
        })
  proc.onData((d) => send('pty:data', key, d))
  proc.onExit(({ exitCode }) => send('pty:exit', key, exitCode))

  sessions.set(key, {
    pty: proc,
    pinned: { sessionId, cwd, mode: opts.mode, name: opts.name || '', engine, startedAt: Date.now() },
  })
  activeKey = key
  watchSession()
  emitActivity({
    kind: 'session-start',
    title: `${opts.name || basename(cwd) || 'session'} · ${engine} · ${opts.mode === 'resume' ? 'resumed' : 'started'}`,
    detail: cwd.replace(homedir(), '~'),
    repo: repoForCwd(cwd)?.path || basename(repoRootOf(cwd) || ''),
    repoRoot: repoRootOf(cwd),
    sessionId,
  })
  return { sessionId, cwd }
}

function setActiveSession(key: string) {
  if (sessions.has(key)) {
    activeKey = key
    watchSession()
  }
}

function stopSession(key: string) {
  const s = sessions.get(key)
  if (s) {
    try {
      s.pty.kill()
    } catch {
      /* already gone */
    }
    sessions.delete(key)
  }
  if (activeKey === key) {
    activeKey = sessions.keys().next().value ?? ''
    watchSession()
  }
}

// Watch the ACTIVE session's transcript and push a tick the instant it grows
// (i.e. as the agent writes each turn / tool call) so realtime widgets refresh
// without waiting for their poll interval. A cheap stat — no Claude hook needed.
let watchTimer: ReturnType<typeof setInterval> | null = null
let watchedFile = ''
let lastMtime = 0
function watchSession() {
  if (watchTimer) clearInterval(watchTimer)
  watchedFile = ''
  lastMtime = 0
  watchTimer = setInterval(() => {
    const sid = cur().sessionId
    if (!sid) return
    if (!watchedFile) {
      const f = findSessionFile(sid)
      if (!f) return
      watchedFile = f
    }
    try {
      const m = statSync(watchedFile).mtimeMs
      if (m !== lastMtime) {
        lastMtime = m
        send('gt:tick')
      }
    } catch {
      watchedFile = ''
    }
  }, 400)
}

// Per-session turn watcher → activity feed + notifications. Watches EVERY
// running session's transcript (backgrounded ones too — that's the point) and
// fires a "ready" event the moment a turn completes (stop_reason 'end_turn'),
// deduped by the assistant message id so it fires once per turn.
type TurnWatch = { file: string; mtime: number; lastTurnId: string }
const turnWatch = new Map<string, TurnWatch>()
let activityTimer: ReturnType<typeof setInterval> | null = null
let telegramTimer: ReturnType<typeof setInterval> | null = null
function pollActivity() {
  for (const [key, s] of sessions) {
    const sid = s.pinned.sessionId
    if (!sid) continue
    let w = turnWatch.get(key)
    if (!w) {
      const file = findSessionFile(sid)
      if (!file) continue
      // seed without firing: record the current turn so we only notify on NEW ones
      const seed = lastAssistantTurn(file)
      w = { file, mtime: 0, lastTurnId: seed?.endTurn ? seed.id : '' }
      try {
        w.mtime = statSync(file).mtimeMs
      } catch {
        /* ignore */
      }
      turnWatch.set(key, w)
      continue
    }
    let m = 0
    try {
      m = statSync(w.file).mtimeMs
    } catch {
      continue
    }
    if (m === w.mtime) continue
    w.mtime = m
    const t = lastAssistantTurn(w.file)
    if (!t || !t.endTurn || t.id === w.lastTurnId) continue
    w.lastTurnId = t.id
    const focusedHere = key === activeKey && (win?.isFocused() ?? false)
    const label = s.pinned.name || basename(s.pinned.cwd) || 'session'
    const st = readTranscriptStats(sid)
    emitActivity(
      {
        kind: 'task-complete',
        title: `${label} · ready`,
        detail: st.aiTitle || (st.lastAction ? `done — ${st.lastAction.tool}` : 'Turn complete'),
        repo: repoForCwd(s.pinned.cwd)?.path || basename(repoRootOf(s.pinned.cwd) || ''),
        repoRoot: repoRootOf(s.pinned.cwd),
        sessionId: sid,
      },
      // don't ping for the session you're actively looking at
      { notify: !focusedHere },
    )
  }
  for (const k of turnWatch.keys()) if (!sessions.has(k)) turnWatch.delete(k)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 820,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hidden',
    // explicit position so the ●●● controls sit visible + vertically centered in
    // the 36px (h-9) tab bar, instead of being clipped/mis-aligned by the default
    trafficLightPosition: { x: 14, y: 11 },
    title: 'TerMinal',
    icon: join(moduleDir, '../../build/icon.png'),
    webPreferences: { preload: join(moduleDir, '../preload/index.mjs'), sandbox: false, webviewTag: true },
  })

  // The macOS traffic lights are hidden in fullscreen, so the renderer should
  // drop its left reserve for them. Broadcast the fullscreen state.
  const sendFullscreen = () => send('window:fullscreen', win?.isFullScreen() ?? false)
  win.on('enter-full-screen', sendFullscreen)
  win.on('leave-full-screen', sendFullscreen)
  win.on('ready-to-show', () => {
    win?.show()
    sendFullscreen()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('render-process-gone', (_e, d) =>
    console.error('[gt] renderer gone:', d.reason),
  )

  // push activity events to the renderer; poll all sessions for turn completion
  onActivity((ev) => send('activity:event', ev))
  startActivityTail() // surface externally-appended events (skills) live
  onAgentEvent((channel, payload) => {
    send(channel, payload)
    if (shouldPublishRunsChanged(channel)) sendRunsChanged()
  })
  loadPersistedRuns() // restore past agent runs
  ensureCronRunsWatcher()
  if (!activityTimer) activityTimer = setInterval(pollActivity, 1500)
  // Real cron: install the headless runner at its stable path, then reconcile
  // launchd ↔ schedules.json (loads enabled jobs, removes any orphans). Jobs
  // fire via launchd even when the app is closed — no in-app ticker.
  const runnerSrc = app.isPackaged
    ? join(process.resourcesPath, 'terminal-cron')
    : join(moduleDir, '../../bin/terminal-cron')
  installRunner(runnerSrc)
  const cliSrc = app.isPackaged
    ? join(process.resourcesPath, 'terminal-cli')
    : join(moduleDir, '../../bin/terminal-cli')
  installCli(cliSrc)
  const mcpSrc = app.isPackaged
    ? join(process.resourcesPath, 'terminal-mcp-server')
    : join(moduleDir, '../../bin/terminal-mcp-server')
  installMcpServer(mcpSrc)
  // Once the MCP binary is on disk, register it with Claude Code (~/.claude.json)
  // and Codex CLI (~/.codex/config.toml) so every spawned agent — TerMinal's own
  // or ad-hoc — discovers the harness tools natively without per-repo config.
  // Idempotent: stale registrations are updated to the current bun path; no-op
  // when already correct.
  try {
    const r = registerMcpEverywhere()
    if (!r.claude.ok) console.warn(`mcp register claude: ${r.claude.action} (${r.claude.error || ''})`)
    if (!r.codex.ok) console.warn(`mcp register codex: ${r.codex.action} (${r.codex.error || ''})`)
  } catch (e) {
    console.warn(`mcp register failed: ${(e as Error).message}`)
  }
  try {
    reconcileSchedules()
  } catch {
    /* launchd unavailable — schedules still listable */
  }

  // Telegram AFK control: enumerate run targets from open sessions, prime the
  // cursor if control was left on, and poll for inbound commands.
  configureTelegramControl({
    repos: () => {
      const seen = new Set<string>()
      const out: { label: string; repoRoot: string }[] = []
      for (const s of sessions.values()) {
        const root = repoRootOf(s.pinned.cwd)
        if (!root || seen.has(root)) continue
        seen.add(root)
        out.push({ label: repoForCwd(s.pinned.cwd)?.path || basename(root), repoRoot: root })
      }
      return out
    },
    active: () => {
      const root = repoRootOf(cur().cwd)
      return root ? { label: repoForCwd(cur().cwd)?.path || basename(root), repoRoot: root } : null
    },
  })
  if (telegramControlEnabled()) markTelegramControlEnabled(true, false) // restore cursor quietly
  if (!telegramTimer) telegramTimer = setInterval(pollTelegramOnce, 5000)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(moduleDir, '../renderer/index.html'))
  }
}

// ---- session IPC ----
ipcMain.handle('sessions:list', () => listSessions())
ipcMain.handle('session:start', (_e, key: string, opts: StartOpts) => startSession(key, opts))
ipcMain.handle('session:setActive', (_e, key: string) => setActiveSession(key))
ipcMain.handle('session:stop', (_e, key: string) => stopSession(key))
// Fleet snapshot: a summary of every live session (for the cross-session
// overview + the live status dots on the session tabs).
ipcMain.handle('fleet:list', () => {
  const out = []
  for (const [key, s] of sessions) {
    const sid = s.pinned.sessionId
    const st = readTranscriptStats(sid)
    let status: 'working' | 'idle' | 'awaiting' = 'idle'
    const f = sid ? findSessionFile(sid) : null
    if (f) {
      const t = lastAssistantTurn(f)
      if (t?.awaiting)
        status = 'awaiting' // parked at a permission gate or asked a question — needs you
      else if (t && !t.endTurn) status = 'working'
    }
    out.push({
      key,
      sessionId: sid,
      name: s.pinned.name || basename(s.pinned.cwd) || 'session',
      cwd: s.pinned.cwd,
      repo: repoForCwd(s.pinned.cwd)?.path || basename(repoRootOf(s.pinned.cwd) || s.pinned.cwd),
      branch: st.gitBranch,
      model: st.model,
      status,
      contextPct: st.contextPct,
      contextTokens: st.contextTokens,
      contextLimit: st.contextLimit,
      turns: st.turns,
      aiTitle: st.aiTitle,
      lastAction: st.lastAction,
    })
  }
  return out
})
// Cross-repo PR/MR triage: bucket counts (ready / changes / needs-review) for
// every KNOWN repo (open sessions + scheduled), so "which PRs are ready across
// everything" has one home. Reuses the 60s-cached mrSummary per repo; fetched
// on-demand by the Triage tab, not polled (the forge CLI is slow to fan out).
ipcMain.handle('fleet:mrs', async () => {
  const roots = new Map<string, string>() // repoRoot → display label
  for (const s of sessions.values()) {
    const root = repoRootOf(s.pinned.cwd)
    if (root) roots.set(root, repoForCwd(s.pinned.cwd)?.path || basename(root))
  }
  for (const sc of readSchedules(Date.now())) {
    if (sc.repoRoot && !roots.has(sc.repoRoot)) roots.set(sc.repoRoot, sc.repoLabel || basename(sc.repoRoot))
  }
  const rows = await Promise.all(
    [...roots.entries()].map(async ([repoRoot, repo]) => {
      try {
        const m = await mrSummary(repoRoot)
        return { repo, repoRoot, label: m.label, open: m.open, approve: m.approve, changes: m.changes, needsReview: m.needsReview }
      } catch {
        return null
      }
    }),
  )
  return rows.filter((r): r is NonNullable<typeof r> => !!r && r.open > 0)
})
ipcMain.handle('dirs:projects', () => {
  const base = resolvedProjectsDir()
  try {
    return readdirSync(base)
      .filter((n) => !n.startsWith('.'))
      .map((n) => ({ name: n, path: join(base, n) }))
      .filter((d) => {
        try {
          return statSync(d.path).isDirectory()
        } catch {
          return false
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
})
ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: homedir(),
  })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('project:scaffold', (_e, name: string, parentDir?: string) =>
  scaffoldProject(name, parentDir),
)
ipcMain.handle('window:is-fullscreen', () => win?.isFullScreen() ?? false)
ipcMain.handle('activity:list', () => readActivity())
ipcMain.handle('activity:clear', () => clearActivity())
ipcMain.handle('env:detect', () => detectEnv())
ipcMain.handle('env:install-gt-notify', () => installGtNotify())
ipcMain.handle('telegram:test', () => testTelegram())
ipcMain.handle('settings:get', () => readSettings())
ipcMain.handle('settings:patch', (_e, patch: SettingsPatch) => {
  const before = readSettings()
  const next = patchSettings(patch)
  // react when the AFK-control toggle actually flips
  if (next.telegram.control !== before.telegram.control) {
    markTelegramControlEnabled(next.telegram.control)
  }
  return next
})
ipcMain.handle('agents:list', () => readAgents(repoRootOf(cur().cwd)))
ipcMain.handle('agents:save', (_e, agent: { id: string; title: string; prompt: string }) =>
  saveAgent(repoRootOf(cur().cwd), agent),
)
ipcMain.handle('agents:reset', (_e, id: string) => resetAgent(repoRootOf(cur().cwd), id))
// Read the script body for an agent if .agents/<id>.sh (or global) exists. Returns
// { path, body } when found, null otherwise — used by the Agents tab to render
// the bash inline alongside the prompt.
ipcMain.handle('agents:convert', (_e, id: string) =>
  convertAgentToScript(repoRootOf(cur().cwd) || '', id),
)
ipcMain.handle('agents:script', (_e, id: string) => {
  const root = repoRootOf(cur().cwd) || ''
  const p = locateScript(root, id)
  if (!p) return null
  try {
    return { path: p, body: readFileSync(p, 'utf8') }
  } catch {
    return null
  }
})
ipcMain.handle('agents:state', (_e, id: string) => {
  const root = repoRootOf(cur().cwd) || ''
  return readAgentState(root, id)
})
ipcMain.handle('agents:state-reset', (_e, id: string) => {
  const root = repoRootOf(cur().cwd) || ''
  return resetAgentState(root, id)
})
ipcMain.handle(
  'agents:design',
  (_e, text: string, engine: Engine, scope: 'repo' | 'global', model?: string) =>
    runDesignerSpawn(repoRootOf(cur().cwd), text, engine, scope, model),
)
ipcMain.handle('schedules:design', (_e, text: string, engine: Engine) =>
  runScheduleDesignerSpawn(repoRootOf(cur().cwd), text, engine),
)
ipcMain.handle('agents:pipelines', () => listPipelines())
ipcMain.handle('personas:list', () => readPersonas(repoRootOf(cur().cwd)))
ipcMain.handle('agents:run', (_e, agentId: string, engine?: Engine, persona?: string, pipeline?: string, model?: string) =>
  runAgent(repoRootOf(cur().cwd), agentId, engine, persona, pipeline, model),
)
ipcMain.handle('agents:run-ticket', (_e, slug: string, engine: Engine, persona?: string, pipeline?: string, model?: string) => {
  const root = repoRootOf(cur().cwd)
  const t = getTicket(root, slug)
  return t
    ? runTicketAgent(root, { id: t.id, title: t.title, body: t.body }, engine, persona, pipeline, model)
    : { error: 'ticket not found' }
})
ipcMain.handle(
  'agents:run-pr',
  (
    _e,
    pr: { iid: number; sourceBranch: string; title?: string; webUrl?: string },
    kind: PrAgentKind,
    engine: Engine,
    persona?: string,
    pipeline?: string,
    model?: string,
  ) => runPrAgent(repoRootOf(cur().cwd), pr, kind, engine, persona, pipeline, model),
)
ipcMain.handle('agents:runs', () => listRuns())
ipcMain.handle('agents:cancel', (_e, runId: string) => {
  const canceled = cancelRun(runId)
  sendRunsChanged()
  return canceled
})
ipcMain.handle('agents:remove-worktree', (_e, runId: string) => removeWorktree(runId))
// Schedules are backed by real launchd jobs; every mutation syncs launchd in
// lockstep, and `enriched` annotates each with its human cadence + next fire.
ipcMain.handle('schedules:list', () => {
  const now = Date.now()
  return readSchedules(now).map((s) => ({ ...s, describe: describeSpec(s.spec), nextRun: nextRun(s.spec, now) }))
})
ipcMain.handle(
  'schedules:save',
  (
    _e,
    input: {
      id?: string
      agentId: string
      engine: Engine
      model?: string
      spec: ScheduleSpec
      enabled?: boolean
      env?: Record<string, string>
    },
  ) => {
    const root = repoRootOf(cur().cwd)
    if (!root) return { error: 'not a git repo' }
    const agent = readAgents(root).find((a) => a.id === input.agentId)
    if (!agent) return { error: 'unknown agent' }
    const base: NewSchedule = {
      repoRoot: root,
      repoLabel: repoForCwd(cur().cwd)?.path || basename(root),
      agentId: agent.id,
      agentTitle: agent.title,
      engine: input.engine || agent.engine || 'codex',
      model: input.model ?? agent.model,
      prompt: agent.prompt, // snapshot — runner uses this offline
      spec: input.spec,
      enabled: input.enabled ?? true,
      // Drop empty/whitespace-only keys so a half-filled editor doesn't pollute
      // the spawn env with bogus blanks; treat missing field as "no env vars".
      env: sanitizeScheduleEnv(input.env),
    }
    const sched = input.id ? updateSchedule(input.id, base) : addSchedule(base)
    if (!sched) return { error: 'schedule not found' }
    const r = syncSchedule(sched)
    if (!r.ok) return { error: `launchd: ${r.error}` }
    return { ok: true, id: sched.id }
  },
)

function sanitizeScheduleEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim()
    if (!key) continue
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue // POSIX-shaped var names only
    out[key] = String(v ?? '')
  }
  return Object.keys(out).length ? out : undefined
}
ipcMain.handle('schedules:remove', (_e, id: string) => {
  unscheduleJob(id)
  return removeSchedule(id)
})
ipcMain.handle('schedules:toggle', (_e, id: string, enabled: boolean) => {
  const ok = toggleSchedule(id, enabled)
  const s = getSchedule(id)
  if (s) {
    try {
      syncSchedule(s)
    } catch {
      /* best effort */
    }
  }
  return ok
})
ipcMain.handle('schedules:run-now', (_e, id: string) => {
  runScheduleNow(id)
  return { ok: true }
})
ipcMain.handle('schedules:runs', (_e, id?: string) => readCronRuns(id))
ipcMain.handle('runs:all', () => listAllRuns())
ipcMain.handle('runs:rerun', (_e, run: UnifiedRun) =>
  rerunRun(run, {
    scheduleExists: (id) => !!getSchedule(id),
    runSchedule: runScheduleNow,
    runTicket: (repoRoot, ticketId, engine, personaTitle, pipelineTitle) => {
      const ticket = listTickets(repoRoot).find((t) => t.id === ticketId)
      if (!ticket) return { error: `ticket #${ticketId} not found` }
      const personaId = personaTitle
        ? readPersonas(repoRoot).find((p) => p.id === personaTitle || p.title === personaTitle)?.id
        : undefined
      const pipelineId = pipelineTitle
        ? listPipelines().find((p) => p.id === pipelineTitle || p.title === pipelineTitle)?.id
        : undefined
      return runTicketAgent(repoRoot, ticket, engine || 'codex', personaId, pipelineId)
    },
    runAgent,
  }),
)
ipcMain.handle('runs:log', (_e, source: 'cron' | 'agent', runId: string) => {
  if (source === 'cron') return readCronRunLog(runId)
  // Prefer the durable log file. In-memory output can be stale if the renderer
  // missed the final stream chunk or the app stayed open across a late flush.
  return readAgentRunLog(runId, listRuns().find((r) => r.id === runId)?.output || '')
})
ipcMain.handle('schedules:disabled-list', () => listDisabled())
ipcMain.handle('schedules:disabled-toggle', (_e, id: string, disabled: boolean) => setAgentDisabled(id, disabled))
ipcMain.handle('schedules:disabled-all', (_e, disabled: boolean) =>
  setAllSchedulesDisabled(
    readSchedules(Date.now()).map((s) => s.id),
    disabled,
  ),
)
ipcMain.handle('schedules:run-log', (_e, runId: string) => readCronRunLog(runId))
ipcMain.handle('schedules:reconcile', () => reconcileSchedules())
// Global HITL inbox (cross-repo). Filing fires a blocked notification (TG + macOS).
ipcMain.handle('hitl:list', () => readHitl())
ipcMain.handle('hitl:file', (_e, item: Omit<HitlItem, 'id' | 'status' | 'createdAt'>) => fileHitl(item))
ipcMain.handle('hitl:resolve', (_e, id: string, resolved?: boolean) => resolveHitl(id, resolved ?? true))
ipcMain.handle('hitl:remove', (_e, id: string) => removeHitl(id))
// Factory: read-only cross-repo health roll-up + start the orchestrator in-place.
ipcMain.handle('factory:health', () => factoryHealth())
ipcMain.handle('factory:start', (_e, engine: Engine) => runFactorySpawn(repoRootOf(cur().cwd), engine || 'codex'))
ipcMain.handle('schedules:remove-all', () => {
  const n = removeAllJobs()
  for (const s of readSchedules()) removeSchedule(s.id)
  return { removed: n }
})
// ---- PTY IPC (routed by session key) ----
ipcMain.on('pty:input', (_e, key: string, data: string) => sessions.get(key)?.pty.write(data))
ipcMain.on('pty:resize', (_e, key: string, size: { cols: number; rows: number }) => {
  try {
    sessions.get(key)?.pty.resize(size.cols, size.rows)
  } catch {
    /* ignore transient resize errors */
  }
})

// ---- data IPC (plugin pollers; all keyed to the attached session) ----
ipcMain.handle('data:transcript', () => {
  const c = cur()
  // Cursor sessions read their (best-effort) telemetry from the ~/.cursor chat
  // store; claude/codex read the claude-format transcript by session id.
  return c.engine === 'cursor' ? readCursorStats(c.cwd, c.startedAt) : readTranscriptStats(c.sessionId)
})
ipcMain.handle('data:harness-tdd', () => readHarnessTdd(cur().cwd))
ipcMain.handle('data:usage', () => readUsage())
ipcMain.handle('data:git-status', () => gitStatus(cur().cwd))
ipcMain.handle('data:session-tasks', () => readSessionTasks(cur().sessionId))
ipcMain.handle('data:mr-summary', () => mrSummary(repoRootOf(cur().cwd)))
ipcMain.handle('data:meta', () => ({ ...cur(), claude: enginePath('claude') }))

// ---- command widgets (declarative, per-repo extensible) ----
ipcMain.handle('widgets:list', () => listCommandWidgets(cur().cwd))
ipcMain.handle('widgets:run', (_e, command: string) => runCommand(command, cur().cwd))

// ---- tabs: repo context + tickets/MRs (scoped to the session's repo) ----
ipcMain.handle('tab:context', () => {
  const repoRoot = repoRootOf(cur().cwd)
  const repo = repoForCwd(cur().cwd)
  const forge = forgeFor(repoRoot)
  return {
    cwd: cur().cwd,
    sessionId: cur().sessionId,
    repoRoot,
    repoPath: repo?.path || '',
    repoHost: repo?.host || '',
    forgeKind: forge.kind,
    forgeLabel: forge.label,
    forgeSym: forge.sym,
    hasBacklog: !!repoRoot && existsSync(join(repoRoot, 'backlog')),
    hasSessions: repoHasSessions(repoRoot),
    hasAgents: repoHasAgents(repoRoot),
  }
})
ipcMain.handle('docs:list', () => listDocs(repoRootOf(cur().cwd) || ''))
ipcMain.handle('docs:get', (_e, relPath: string) => readDoc(repoRootOf(cur().cwd) || '', relPath))
ipcMain.handle('sessions:project-list', () => listProjectSessions(repoRootOf(cur().cwd)))
ipcMain.handle('sessions:project-get', (_e, slug: string) =>
  getProjectSession(repoRootOf(cur().cwd), slug),
)
ipcMain.handle('tickets:list', () => listTickets(repoRootOf(cur().cwd)))
ipcMain.handle('tickets:get', (_e, slug: string) => getTicket(repoRootOf(cur().cwd), slug))
ipcMain.handle('tickets:create', (_e, input: NewTicket) => {
  const root = repoRootOf(cur().cwd)
  const t = createTicket(root, input)
  emitActivity({
    kind: 'ticket-filed',
    title: `Ticket filed · #${t.id}`,
    detail: t.title,
    repo: repoForCwd(cur().cwd)?.path || basename(root || ''),
    repoRoot: root,
    sessionId: cur().sessionId,
    ref: { ticket: t.id },
  })
  return t
})
ipcMain.handle('tickets:spawn', (_e, text: string, engine: Engine, model?: string) =>
  runTicketSpawn(repoRootOf(cur().cwd), text, engine, model),
)
ipcMain.handle('tickets:update', (_e, slug: string, patch: { status?: string; priority?: string }) => {
  const root = repoRootOf(cur().cwd)
  const ok = updateTicket(root, slug, patch)
  if (ok && patch.status === 'closed') {
    const t = getTicket(root, slug)
    emitActivity({
      kind: 'ticket-closed',
      title: `Ticket closed · #${t?.id ?? slug}`,
      detail: t?.title,
      repo: repoForCwd(cur().cwd)?.path || basename(root || ''),
      repoRoot: root,
      sessionId: cur().sessionId,
      ref: t?.id ? { ticket: t.id } : undefined,
    })
  }
  return ok
})
ipcMain.handle('skills:list', () => listSkills(repoRootOf(cur().cwd)))
ipcMain.handle('mrs:list', () => listMrs(repoRootOf(cur().cwd)))
ipcMain.handle('mrs:get', (_e, iid: number) => getMr(repoRootOf(cur().cwd), iid))
ipcMain.handle('mrs:diff', (_e, iid: number) => getMrDiff(repoRootOf(cur().cwd), iid))
ipcMain.handle('mrs:ci', (_e, iid: number) => getMrCi(repoRootOf(cur().cwd), iid))
ipcMain.handle('mrs:merge', (_e, iid: number) => mergeMr(repoRootOf(cur().cwd), iid))
ipcMain.handle('ci:list', async (_e, limit?: number) => {
  const { listCiRuns } = await import('./ci')
  return listCiRuns(repoRootOf(cur().cwd), limit)
})
ipcMain.handle('ci:jobs', async (_e, runId: string) => {
  const { listCiJobs } = await import('./ci')
  return listCiJobs(repoRootOf(cur().cwd), runId)
})
ipcMain.handle('ci:log', async (_e, jobId: string) => {
  const { fetchCiLog } = await import('./ci')
  return fetchCiLog(repoRootOf(cur().cwd), jobId)
})
ipcMain.handle('open:external', (_e, url: string) => shell.openExternal(url))
// Reveal ~/.config/TerMinal/ in Finder. Power-user QoL for editing
// schedules.json, settings.json, or per-(repo, agent) state sidecars by hand.
ipcMain.handle('open:config-dir', () => shell.openPath(join(homedir(), '.config', 'TerMinal')))

// Install the MCP server entry into ~/.claude/mcp.json (and ~/.codex's
// equivalent if it exists). Read-only, stdio transport. Idempotent —
// re-running just updates the binary path.
ipcMain.handle('mcp:install', () => {
  const binPath = join(homedir(), '.config', 'TerMinal', 'bin', 'terminal-mcp-server')
  if (!existsSync(binPath)) {
    return { error: `terminal-mcp-server not installed at ${binPath}` }
  }
  const installed: string[] = []
  // Claude Code: ~/.claude/mcp.json (per Anthropic CLI docs)
  try {
    const claudeMcp = join(homedir(), '.claude', 'mcp.json')
    let cfg: any = {}
    if (existsSync(claudeMcp)) {
      try {
        cfg = JSON.parse(readFileSync(claudeMcp, 'utf8'))
      } catch {
        cfg = {}
      }
    }
    cfg.mcpServers ??= {}
    cfg.mcpServers['terminal-harness'] = {
      command: binPath,
      args: [],
    }
    mkdirSync(dirname(claudeMcp), { recursive: true })
    writeFileSync(claudeMcp, JSON.stringify(cfg, null, 2))
    installed.push('Claude Code (~/.claude/mcp.json)')
  } catch (e) {
    return { error: `failed to write Claude config: ${(e as Error).message}` }
  }
  return { ok: true, installed }
})

// Workspace bootstrap helpers.
// "Bootstrapped" === the project-template machinery is present in the repo
// (we check .agents/ as a low-effort proxy — the other dirs come together
// with it). Used by the in-session banner.
// First-user-prompt for an arbitrary session id (not just the active one).
// Used by the auto-naming flow in App.tsx — labels brand-new sessions with a
// truncated version of what the user actually asked Claude to do, instead of
// the bare "S1"/"S2" ordinal. The firstUserText is already extracted +
// capped to 140 chars by parseTranscriptFile.
ipcMain.handle('data:first-prompt', (_e, sessionId: string) => {
  if (!sessionId) return ''
  return readTranscriptStats(sessionId).firstUserText || ''
})

ipcMain.handle('workspace:is-bootstrapped', (_e, repoRoot: string) => {
  if (!repoRoot) return { bootstrapped: true }
  return { bootstrapped: existsSync(join(repoRoot, '.agents')) }
})
// Run project-template/bootstrap.sh against a repo. The script is idempotent
// and skips clobbering existing files (it writes `<name>.workflow` sidecars
// for conflicts). Streams nothing — we just wait and return ok/error.
ipcMain.handle('workspace:bootstrap', async (_e, repoRoot: string) => {
  if (!repoRoot) return { error: 'no repoRoot' }
  // Prefer a local checkout; the packaged app has none, so fall back to cloning
  // the configured template repo to a temp dir (cleaned up in finally).
  const src = pickTemplateSource({
    candidates: templateDirCandidates(),
    hasBootstrap: (d) => existsSync(join(d, 'bootstrap.sh')),
    templateRepo: resolvedTemplateRepo(),
    cloneToTmp: cloneTemplateToTmp,
  })
  if ('error' in src) return { error: src.error }
  const script = join(src.dir, 'bootstrap.sh')
  try {
    return await new Promise<{ ok: true } | { error: string }>((resolve) => {
      const p = cpSpawn('bash', [script, repoRoot], { stdio: 'pipe' })
      let stderr = ''
      p.stderr.on('data', (d) => (stderr += d.toString()))
      p.on('exit', (code) => {
        if (code === 0) resolve({ ok: true })
        else resolve({ error: `bootstrap exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}` })
      })
      p.on('error', (e) => resolve({ error: e.message }))
    })
  } finally {
    src.cleanup?.()
  }
})

// In-app rebuild. Spawns bin/release fully detached and routes its output to
// a log file the renderer can tail. The release script kills the running
// TerMinal mid-flow (so it can replace /Applications/TerMinal.app); the
// detached child outlives the parent and finishes the install + relaunch.
//
// Why detached + own process group: bin/release does `pkill -f
// "/Applications/TerMinal.app/Contents/MacOS"` which would otherwise kill the
// build itself. Putting the child in its own group + ignoring stdio + unref()
// makes it a true daemon — the harness exits cleanly and the script lands a
// fresh app in /Applications a minute or so later.
const RELEASE_LOG = join(homedir(), '.config', 'TerMinal', 'release.log')
let releasePid: number | null = null
ipcMain.handle('release:start', () => {
  if (releasePid) {
    try {
      process.kill(releasePid, 0) // throws if process is gone
      return { error: 'release already running' }
    } catch {
      releasePid = null
    }
  }
  // Resolve the repo root from this app's bundle. In dev this is the source
  // tree; in the packaged build there's no bin/release (packaged users would
  // need the source checkout). Refuse cleanly if it's missing.
  // We probe a few candidates: GT_REPO env var (dev override) → process.cwd()
  // → __dirname climb-up. This is enough for the dev / source-installed
  // workflow TerMinal actually runs in.
  const repoRoot = sourceCheckoutRoot(join('bin', 'release'))
  if (!repoRoot) {
    return {
      error:
        'bin/release not found — set GT_TERMINAL_REPO to your source checkout, or run from the repo directory',
    }
  }
  // Truncate the log so each rebuild starts fresh.
  try {
    writeFileSync(RELEASE_LOG, `▸ rebuild started ${new Date().toISOString()}\n▸ repo: ${repoRoot}\n`)
  } catch {
    /* best-effort */
  }
  const out = openSync(RELEASE_LOG, 'a')
  const child = cpSpawn('bin/release', [], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
  releasePid = child.pid || null
  return { ok: true, pid: releasePid, log: RELEASE_LOG, repoRoot }
})
ipcMain.handle('release:tail', () => {
  try {
    return readFileSync(RELEASE_LOG, 'utf8')
  } catch {
    return ''
  }
})
// Harness self-status. Meta-observability snapshot so the operator can see
// how the harness itself is doing without ls-ing config dirs. Cheap: one
// directory listing + the in-memory run map.
// Background tasks IPCs. /bg <prompt> fires a detached run.
ipcMain.handle('bg:list', () => listBgTasks())
ipcMain.handle('bg:get', (_e, id: string) => getBgTask(id))
ipcMain.handle('bg:log', (_e, id: string) => readBgTaskLog(id))
ipcMain.handle(
  'bg:spawn',
  (_e, input: { repoRoot: string; prompt: string; engine?: Engine; model?: string }) =>
    spawnBgTask(input),
)
ipcMain.handle('bg:cancel', (_e, id: string) => cancelBgTask(id))

// OpenRouter IPCs — test connectivity + chat passthrough.
ipcMain.handle('openrouter:test', async () => {
  const { testOpenRouter } = await import('./openrouter')
  return testOpenRouter()
})
ipcMain.handle('openrouter:chat', async (_e, opts: Parameters<typeof import('./openrouter').openrouterChat>[0]) => {
  const { openrouterChat } = await import('./openrouter')
  return openrouterChat(opts)
})
ipcMain.handle('openrouter:presets', async () => {
  const m = await import('./openrouter')
  return { free: m.FREE_MODEL_PRESETS, cheapPaid: m.CHEAP_PAID_PRESETS }
})

// Cheap one-shot LLM call — smart-routes Anthropic models to `claude -p`
// (free via Max subscription) and non-Anthropic to OpenRouter.
ipcMain.handle('llm:cheap', async (_e, opts: Parameters<typeof import('./cheap-llm').cheapCall>[0]) => {
  const { cheapCall } = await import('./cheap-llm')
  return cheapCall(opts)
})

// Classifier IPCs — exposed so scripts/dashboard can use them too.
ipcMain.handle('classify:ci', async (_e, rawLog: string) => {
  const { classifyCiFailure } = await import('./ci-failure-classifier')
  return classifyCiFailure(rawLog)
})
ipcMain.handle('classify:risk', async (_e, input: Parameters<typeof import('./pr-risk-classifier').classifyRisk>[0]) => {
  const { classifyRisk } = await import('./pr-risk-classifier')
  return classifyRisk(input)
})

// MR authorship sniffer — runs git log over the MR's range.
// `refine: true` runs LLM (claude -p haiku via Max, or OpenRouter) on the
// ambiguous commits to catch AI-authored ones missing known footers.
ipcMain.handle('mrs:authorship', async (_e, iid: number, opts?: { refine?: boolean }) => {
  const { getMr } = await import('./mrs')
  const { authorshipForRange, refineAuthorshipWithLlm } = await import('./mr-authorship')
  const repoRoot = repoRootOf(cur().cwd)
  if (!repoRoot) return null
  const mr = await getMr(repoRoot, iid)
  if (!mr) return null
  const base = mr.targetBranch || 'main'
  const head = mr.sourceBranch
  // Use origin/<base>..origin/<head> for accuracy against remote state
  const range = `origin/${base}..origin/${head}`
  let summary
  try {
    summary = authorshipForRange(repoRoot, range)
  } catch {
    // Fallback: try local-only range
    summary = authorshipForRange(repoRoot, `${base}..${head}`)
  }
  if (opts?.refine) {
    try {
      summary = await refineAuthorshipWithLlm(summary)
    } catch {
      /* ignore */
    }
  }
  return summary
})

// Budget IPCs (#0002).
ipcMain.handle('budgets:get', () => readBudgets())
ipcMain.handle('budgets:setDaily', (_e, usd: number) => setDailyCap(usd))
ipcMain.handle('budgets:setAgent', (_e, agentId: string, usd: number) => setAgentCap(agentId, usd))
ipcMain.handle('budgets:override', (_e, durationMs: number) => setOverride(durationMs))
ipcMain.handle('budgets:gate', (_e, agentId?: string) => gateSpawn(agentId))

// AI fleet observability IPCs. Pull from the per-run AI ledger.
ipcMain.handle('observability:summary', (_e, range: Range = 'today') => summaryFor(range))
ipcMain.handle('observability:byAgent', (_e, range: Range = 'week') => agentROI(range))
ipcMain.handle('observability:daily', (_e, days: number = 7) => dailySpend(days))
ipcMain.handle('observability:runs', (_e, limit: number = 100) => listAIRuns(limit))
ipcMain.handle('observability:models', () => knownModels())

ipcMain.handle('harness:status', () => {
  const cfgDir = join(homedir(), '.config', 'TerMinal')
  const cronRunsDir = join(cfgDir, 'cron-runs')
  let cronRunFiles = 0
  let cronWorktrees = 0
  if (existsSync(cronRunsDir)) {
    try {
      cronRunFiles = readdirSync(cronRunsDir).filter((f) => f.endsWith('.json')).length
    } catch {
      /* ignore */
    }
  }
  const wtDir = join(cfgDir, 'cron-worktrees')
  if (existsSync(wtDir)) {
    try {
      cronWorktrees = readdirSync(wtDir).length
    } catch {
      /* ignore */
    }
  }
  const cronRuns = readCronRuns(undefined, 1000)
  const running = cronRuns.filter((r) => r.status === 'running').length
  const failed24h = cronRuns.filter(
    (r) => r.status === 'failed' && r.startedAt >= Date.now() - 86_400_000,
  ).length
  const paused = listDisabled().length
  const inProcessRunning = listRuns().filter((r) => r.status === 'running').length
  return {
    cronRunFiles,
    cronWorktrees,
    cronRunsRunning: running,
    cronFailed24h: failed24h,
    inProcessRunning,
    schedulesPaused: paused,
    configDir: cfgDir,
  }
})
ipcMain.handle('release:status', () => {
  if (!releasePid) return { running: false }
  try {
    process.kill(releasePid, 0)
    return { running: true, pid: releasePid }
  } catch {
    return { running: false, pid: releasePid }
  }
})
// Hand a target to a configured external app via `open -a <App>` (robust, no
// PATH/CLI dependency), falling back to the OS default if the app isn't there.
function openInApp(appName: string, target: string, fallback: () => void) {
  try {
    const p = cpSpawn('open', ['-a', appName, target], { stdio: 'ignore' })
    p.on('error', fallback)
    p.on('exit', (code) => {
      if (code !== 0) fallback()
    })
  } catch {
    fallback()
  }
}
// "Open in browser" — the configured browser (default Brave) with its extensions/wallet.
ipcMain.handle('open:in-browser', (_e, url: string) =>
  openInApp(resolvedBrowserApp(), url, () => shell.openExternal(url)),
)
// "Open in editor" — the configured editor (default Cursor). Opens a path; defaults
// to the active session's repo root.
ipcMain.handle('open:in-editor', (_e, path?: string) => {
  const target = path || repoRootOf(cur().cwd) || cur().cwd || homedir()
  openInApp(resolvedEditorApp(), target, () => shell.openPath(target))
})
ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
ipcMain.handle('clipboard:read', () => clipboard.readText())

// ---- notes (repo-bound + global, persisted) ----
ipcMain.handle('notes:read', (_e, scope: NotesScope) => readNotes(scope, repoRootOf(cur().cwd)))
ipcMain.handle('notes:write', (_e, scope: NotesScope, content: string) =>
  writeNotes(scope, content, repoRootOf(cur().cwd)),
)

// ---- files (Cursor-like editor; scoped to repo root / cwd) ----
const filesRoot = () => repoRootOf(cur().cwd) || cur().cwd || homedir()
ipcMain.handle('files:list', (_e, rel: string) => listDir(filesRoot(), rel || ''))
ipcMain.handle('files:read', (_e, rel: string) => readFile(filesRoot(), rel))
ipcMain.handle('files:write', (_e, rel: string, content: string) =>
  writeFile(filesRoot(), rel, content),
)
ipcMain.handle('files:search', (_e, q: string) => searchRepo(filesRoot(), q))
ipcMain.handle('files:create', (_e, rel: string, dir: boolean) => createEntry(filesRoot(), rel, dir))
ipcMain.handle('files:rename', (_e, from: string, to: string) => renameEntry(filesRoot(), from, to))
ipcMain.handle('files:delete', (_e, rel: string) => removeEntry(filesRoot(), rel))

// Safety net: never let a stray async error (e.g. a late PTY write) take down
// the whole app.
process.on('uncaughtException', (e) => console.error('[gt] uncaught:', e))

app.whenReady().then(() => {
  // Encrypt credential fields in settings.json at rest (macOS Keychain). Must
  // run before anything reads settings so encrypted values decrypt correctly.
  initSecretSealer(safeStorage)
  fixPath() // packaged app has a minimal PATH — recover brew CLIs (glab/gh/…)
  createWindow()
  // App-side watchdog. Catches phantom cron runs (schedule deleted before
  // runner finalized, terminal closed mid-run, OOM) that the per-schedule
  // sweep in bin/terminal-cron can't reach when no schedules are firing.
  sweepStaleCronRuns()
  setInterval(sweepStaleCronRuns, 30 * 60 * 1000)
  // AI fleet observability — periodic transcript scans for cost/token rollups.
  startAICollectionLoop()
  // Menu-bar fleet status (NSStatusItem). 5s poll of HITL/runs/spend.
  startMenuBar()
  // Background-task watcher (#0004) — reconciles bg-tasks.json state with
  // actual PIDs, sweeps completed tasks, fires Telegram pings on MR ready.
  startBgWatcher()
  // CI pipeline webhook (:4848) — spawns .agents/ci-watchdog.sh on failed pipelines.
  startCiWebhookServer()
  // Budget watcher — fires HITL pings at warnAt thresholds.
  startBudgetWatcher()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (watchTimer) clearInterval(watchTimer)
  if (activityTimer) clearInterval(activityTimer)
  if (telegramTimer) clearInterval(telegramTimer)
  stopCiWebhookServer()
  for (const s of sessions.values()) s.pty.kill()
  sessions.clear()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  cronRunsWatcher?.close()
  cronRunsWatcher = null
})

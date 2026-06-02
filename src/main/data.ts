import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { repoForCwd, repoRootOf } from './repo'
import { reviewForPrDir, newestReviewDirForRepo } from './review'
import { lookupPrice } from './ai-pricing'

// ---------------------------------------------------------------------------
// Claude Code transcript reader
//
// Claude Code writes one JSONL transcript per session at
//   ~/.claude/projects/<cwd-hash>/<session-id>.jsonl
// The filename is the session id; message lines carry usage, cwd, gitBranch.
//
// TerMinal attaches to ONE session for the life of the window — every
// reader here is keyed by session id, so context %, cost, etc. all describe
// that single session, never an aggregate.
// ---------------------------------------------------------------------------

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const TASKS_DIR = join(homedir(), '.claude', 'tasks')
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
const CURSOR_CHATS_DIR = join(homedir(), '.cursor', 'chats')

/** The agent's live todo list for a session (~/.claude/tasks/<id>/<n>.json). */
export function readSessionTasks(sessionId: string): TaskItem[] {
  if (!sessionId) return []
  const dir = join(TASKS_DIR, sessionId)
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const out: TaskItem[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      out.push({
        id: String(t.id ?? f.replace(/\.json$/, '')),
        subject: t.subject || '',
        status: t.status || 'pending',
        activeForm: t.activeForm || '',
      })
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id))
}

export type TranscriptStats = {
  ok: boolean
  sessionId: string
  model: string
  cwd: string
  gitBranch: string
  contextTokens: number
  contextLimit: number
  contextPct: number
  totalInputTokens: number
  totalOutputTokens: number
  estCostUsd: number
  turns: number
  lastAction: { tool: string; detail: string } | null
  firstUserText: string
  aiTitle: string
  permissionMode: string
  lastPrompt: string
  toolCounts: Record<string, number>
  mtime: number
  ts: number
}

export type TaskItem = { id: string; subject: string; status: string; activeForm: string }

export type SessionMeta = {
  id: string
  engine: 'claude' | 'codex'
  cwd: string
  gitBranch: string
  model: string
  turns: number
  firstUserText: string
  mtime: number
}

// opus 4.x blended estimate ($/token). Cache reads are ~10% of input price.
const PRICE = { input: 15 / 1e6, output: 75 / 1e6, cacheRead: 1.5 / 1e6 }

export function contextLimitFor(model: string, latestContext: number): number {
  if (process.env.GT_CONTEXT_LIMIT) return Number(process.env.GT_CONTEXT_LIMIT)
  // Single source of truth: the per-model registry in ai-pricing.ts (prefix-
  // matched, so dated ids like '…-4-8-20260115' resolve). Self-correct upward
  // if a session somehow carries more than mapped, so we never show >100%.
  let limit = lookupPrice(model).contextWindow
  while (latestContext > limit) limit = limit < 1_000_000 ? 1_000_000 : limit * 2
  return limit
}

function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  if (!input) return ''
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return pick('description') || pick('command').slice(0, 60)
    case 'Edit':
    case 'Write':
    case 'Read':
      return pick('file_path').split('/').slice(-2).join('/')
    case 'Task':
      return pick('description')
    default:
      return (pick('file_path') || pick('path') || pick('query') || pick('pattern')).slice(0, 60)
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as any).type === 'text')
      .map((b) => (b as any).text)
      .join(' ')
  }
  return ''
}

/** Locate a session's transcript file by id, across all project dirs. */
// A session's transcript path is stable for its lifetime, but fleet:list
// resolves it for every open session every 3s. Cache the resolution and
// validate with a single existsSync, falling back to the directory scan only
// on a miss — so the steady state is one stat, not readdir + N existsSync.
const sessionPathCache = new Map<string, string>()
export function findSessionFile(sessionId: string): string | null {
  if (!sessionId || !existsSync(PROJECTS_DIR)) return null
  const cached = sessionPathCache.get(sessionId)
  if (cached && existsSync(cached)) return cached
  for (const project of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, project, `${sessionId}.jsonl`)
    if (existsSync(p)) {
      sessionPathCache.set(sessionId, p)
      return p
    }
  }
  sessionPathCache.delete(sessionId)
  return null
}

/**
 * The most recent assistant turn in a transcript, by reading just the tail.
 * `endTurn` is true when that turn finished (stop_reason 'end_turn') vs. is
 * mid-work ('tool_use'); `id` dedupes so a completion fires once. Tail-only so
 * it's cheap to poll across many sessions.
 */
export type TurnState = { id: string; endTurn: boolean; awaiting: boolean }

/**
 * Pure: classify the last assistant turn from transcript tail lines.
 * `awaiting` = needs the human: either a trailing `tool_use` with no following
 * tool_result (parked at a permission gate) OR an `end_turn` whose text ends in
 * a question (clarifying). Heuristic — visual-only signal, no notifications.
 */
export function turnStateFromLines(lines: string[]): TurnState | null {
  let ai = -1
  let m: any = null
  let outer: any = null
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: any
    try {
      o = JSON.parse(lines[i])
    } catch {
      continue // first line in the window may be truncated — skip
    }
    if (o?.type === 'assistant') {
      ai = i
      outer = o
      m = o.message || {}
      break
    }
  }
  if (ai < 0) return null
  const id = String(m.id || outer.uuid || outer.timestamp || ai)
  const endTurn = m.stop_reason === 'end_turn'
  let awaiting = false
  if (m.stop_reason === 'tool_use') {
    // pending tool: no user/tool_result line follows the assistant's request
    let resultAfter = false
    for (let j = ai + 1; j < lines.length; j++) {
      let o: any
      try {
        o = JSON.parse(lines[j])
      } catch {
        continue
      }
      if (o?.type === 'user') {
        resultAfter = true
        break
      }
    }
    awaiting = !resultAfter
  } else if (endTurn) {
    awaiting = /\?\s*$/.test(textOf(m.content).trim())
  }
  return { id, endTurn, awaiting }
}

/**
 * The most recent assistant turn in a transcript, by reading just the tail.
 * Tail-only so it's cheap to poll across many sessions.
 */
export function lastAssistantTurn(file: string): TurnState | null {
  try {
    const size = statSync(file).size
    if (!size) return null
    const len = Math.min(size, 65536)
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    closeSync(fd)
    return turnStateFromLines(buf.toString('utf8').split('\n').filter(Boolean))
  } catch {
    return null // unreadable
  }
}

function emptyStats(sessionId = ''): TranscriptStats {
  return {
    ok: false,
    sessionId,
    model: 'unknown',
    cwd: '',
    gitBranch: '',
    contextTokens: 0,
    contextLimit: 200_000,
    contextPct: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estCostUsd: 0,
    turns: 0,
    lastAction: null,
    firstUserText: '',
    aiTitle: '',
    permissionMode: '',
    lastPrompt: '',
    toolCounts: {},
    mtime: 0,
    ts: Date.now(),
  }
}

/** Parse one transcript file into full stats. */
export function parseTranscriptFile(file: string, sessionId: string): TranscriptStats {
  let raw: string
  let mtime = 0
  try {
    raw = readFileSync(file, 'utf8')
    mtime = statSync(file).mtimeMs
  } catch {
    return emptyStats(sessionId)
  }

  let model = 'unknown'
  let cwd = ''
  let gitBranch = ''
  let firstUserText = ''
  let contextTokens = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let turns = 0
  let lastAction: { tool: string; detail: string } | null = null
  let aiTitle = ''
  let permissionMode = ''
  let lastPrompt = ''
  const toolCounts: Record<string, number> = {}

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
    if (!gitBranch && typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch
    // Claude writes these as standalone lines (no message); keep the latest.
    if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle
    else if (obj.type === 'permission-mode' && obj.permissionMode) permissionMode = obj.permissionMode
    else if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') lastPrompt = obj.lastPrompt

    const msg = obj.message
    if (!msg) continue

    if (msg.role === 'user' && !firstUserText) {
      const t = textOf(msg.content).trim()
      // skip tool_result-only / command-noise lines
      if (t && !t.startsWith('<') && !Array.isArray(msg.content)) firstUserText = t.slice(0, 140)
      else if (t && Array.isArray(msg.content) && !t.startsWith('<'))
        firstUserText = t.slice(0, 140)
    }

    if (msg.role !== 'assistant') continue
    const u = msg.usage
    if (u) {
      turns++
      if (msg.model) model = msg.model
      const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      const cacheRead = u.cache_read_input_tokens || 0
      const output = u.output_tokens || 0
      totalInput += input
      totalCacheRead += cacheRead
      totalOutput += output
      contextTokens = input + cacheRead + output
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_use') {
          lastAction = { tool: block.name, detail: summarizeToolInput(block.name, block.input) }
          toolCounts[block.name] = (toolCounts[block.name] || 0) + 1
        }
      }
    }
  }

  const contextLimit = contextLimitFor(model, contextTokens)
  return {
    ok: turns > 0,
    sessionId,
    model,
    cwd,
    gitBranch,
    contextTokens,
    contextLimit,
    contextPct: Math.min(100, (contextTokens / contextLimit) * 100),
    totalInputTokens: totalInput + totalCacheRead,
    totalOutputTokens: totalOutput,
    estCostUsd:
      totalInput * PRICE.input + totalCacheRead * PRICE.cacheRead + totalOutput * PRICE.output,
    turns,
    lastAction,
    firstUserText,
    aiTitle,
    permissionMode,
    lastPrompt,
    toolCounts,
    mtime,
    ts: Date.now(),
  }
}

/**
 * Stats for the attached session (by id). Cached by file mtime so the several
 * widgets that poll the transcript share one parse and fast polling stays cheap
 * — we only re-parse when the transcript actually grows.
 *
 * Keyed by sessionId (not a single slot): fleet:list polls every open session
 * every 3s, so a one-slot cache thrashed — each poll evicted every other
 * session and re-read its whole multi-MB transcript. A Map lets N concurrent
 * sessions each keep a warm entry.
 */
const tCache = new Map<string, { mtime: number; stats: TranscriptStats }>()
export function readTranscriptStats(sessionId: string): TranscriptStats {
  const file = sessionId ? findSessionFile(sessionId) : null
  if (!file) return emptyStats(sessionId)
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return emptyStats(sessionId)
  }
  const hit = tCache.get(sessionId)
  if (hit && hit.mtime === mtime) return hit.stats
  const stats = parseTranscriptFile(file, sessionId)
  tCache.set(sessionId, { mtime, stats })
  return stats
}

/** All sessions across all projects, newest first — for the entry picker. */
function listClaudeSessions(): SessionMeta[] {
  const out: SessionMeta[] = []
  if (!existsSync(PROJECTS_DIR)) return out
  for (const project of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, project)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const id = f.replace(/\.jsonl$/, '')
      const s = parseTranscriptFile(join(dir, f), id)
      if (!s.ok) continue // skip empty / never-used sessions
      out.push({
        id,
        engine: 'claude',
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        model: s.model,
        turns: s.turns,
        firstUserText: s.firstUserText,
        mtime: s.mtime,
      })
    }
  }
  return out
}

function walkJsonlFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = join(dir, entry)
    try {
      const st = statSync(p)
      if (st.isDirectory()) walkJsonlFiles(p, out, depth + 1)
      else if (entry.endsWith('.jsonl')) out.push(p)
    } catch {
      /* skip */
    }
  }
  return out
}

export function parseCodexSessionFile(file: string): SessionMeta | null {
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return null
  }

  let id = file.replace(/\.jsonl$/, '').split('/').pop() || ''
  id = id.replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '')
  let cwd = ''
  let model = ''
  let firstUserText = ''
  let turns = 0

  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const payload = obj.payload || {}
    if (obj.type === 'session_meta') {
      if (typeof payload.id === 'string') id = payload.id
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
    } else if (obj.type === 'turn_context') {
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.model === 'string') model = payload.model
    } else if (obj.type === 'event_msg' && payload.type === 'user_message') {
      turns++
      if (!firstUserText && typeof payload.message === 'string') firstUserText = payload.message
    } else if (obj.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      turns++
      if (!firstUserText) firstUserText = textOf(payload.content)
    }
  }

  if (!id || (!cwd && !firstUserText)) return null
  return {
    id,
    engine: 'codex',
    cwd,
    gitBranch: '',
    model: model || 'codex',
    turns,
    firstUserText,
    mtime,
  }
}

function listCodexSessions(): SessionMeta[] {
  if (!existsSync(CODEX_SESSIONS_DIR)) return []
  return walkJsonlFiles(CODEX_SESSIONS_DIR)
    .map(parseCodexSessionFile)
    .filter((s): s is SessionMeta => !!s)
}

/** All sessions across all engines, newest first — for the entry picker.
 *  Cursor is intentionally excluded: it mints its own chat id (we can't key the
 *  picker to a resumable id) and stores chats as SQLite, so resume is handled by
 *  cursor-agent's own --resume/--continue TUI inside the session. */
export function listSessions(): SessionMeta[] {
  const out = [...listClaudeSessions(), ...listCodexSessions()]
  return out.sort((a, b) => b.mtime - a.mtime)
}

// ---------------------------------------------------------------------------
// Cursor live-session telemetry (best-effort)
//
// cursor-agent stores each chat as a SQLite db at
//   ~/.cursor/chats/<chatId>/<groupUuid>/store.db   (+ -wal/-shm)
// Only the `meta` row is reliably plaintext JSON; the message tree is in
// partially-binary blobs we deliberately do NOT parse (we never fabricate
// context%/token gauges we can't read). So the cockpit gets session title +
// model + mode for a Cursor session, and the numeric widgets stay empty —
// the same honest bar Codex sits at today.
// ---------------------------------------------------------------------------

export type CursorChatMeta = {
  agentId: string
  name: string
  model: string
  mode: string
  isRunEverything: boolean
  createdAt: number
}

/** Pure: parse the `meta` row JSON of a cursor chat store.db. */
export function parseCursorMeta(json: string): CursorChatMeta | null {
  let o: any
  try {
    o = JSON.parse(json)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  return {
    agentId: typeof o.agentId === 'string' ? o.agentId : '',
    name: typeof o.name === 'string' ? o.name : '',
    model: typeof o.lastUsedModel === 'string' ? o.lastUsedModel : '',
    mode: typeof o.mode === 'string' ? o.mode : '',
    isRunEverything: o.isRunEverything === true,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  }
}

/** The store.db of the newest cursor chat whose db was written at or after
 *  `sinceMs` — i.e. the chat cursor-agent created for the session we launched.
 *  Attribution heuristic: cursor mints its own id and the Cursor IDE may have
 *  other chats open, so we scope to "appeared since our launch" and take the
 *  newest. Returns '' if none / store missing. */
function newestCursorChatDb(sinceMs: number): string {
  if (!existsSync(CURSOR_CHATS_DIR)) return ''
  let bestPath = ''
  let bestMtime = sinceMs
  let chatIds: string[]
  try {
    chatIds = readdirSync(CURSOR_CHATS_DIR)
  } catch {
    return ''
  }
  for (const chatId of chatIds) {
    const chatDir = join(CURSOR_CHATS_DIR, chatId)
    let groups: string[]
    try {
      groups = readdirSync(chatDir)
    } catch {
      continue
    }
    for (const g of groups) {
      const db = join(chatDir, g, 'store.db')
      try {
        const mt = statSync(db).mtimeMs
        if (mt >= bestMtime) {
          bestMtime = mt
          bestPath = db
        }
      } catch {
        /* not a chat dir */
      }
    }
  }
  return bestPath
}

/** Read the meta row of a cursor chat db via the sqlite3 CLI (no native dep —
 *  same shell-out pattern as git/gh; handles the -wal automatically). */
function readCursorMetaRow(db: string): CursorChatMeta | null {
  try {
    const out = execFileSync('sqlite3', [db, 'SELECT CAST(value AS TEXT) FROM meta LIMIT 1'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out ? parseCursorMeta(out) : null
  } catch {
    return null // sqlite3 missing, locked db, schema drift → graceful empty
  }
}

/** Best-effort cockpit stats for a live cursor session (title/model/mode). */
export function readCursorStats(cwd: string, startedAt: number): TranscriptStats {
  const base = emptyStats('')
  base.cwd = cwd
  const db = newestCursorChatDb(startedAt || 0)
  if (!db) return base
  const meta = readCursorMetaRow(db)
  if (!meta) return base
  return {
    ...base,
    ok: true,
    model: meta.model || 'cursor',
    aiTitle: meta.name,
    permissionMode: meta.isRunEverything ? 'run-everything' : meta.mode || '',
    mtime: meta.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Autopilot-harness TDD reader — scoped to the attached session's repo.
// Derives owner/repo from the cwd's git remote, reads that repo's newest
// tracked PR review artifact (shared logic in review.ts).
// ---------------------------------------------------------------------------

export type TddInfo = {
  ok: boolean
  repo: string
  number: number
  overall: number | null
  verdict: string
  testStatus: string
  stale: boolean
  commitsBehind: number
  ts: number
}

let tddCache: { cwd: string; ts: number; info: TddInfo } | null = null
export function readHarnessTdd(cwd: string): TddInfo {
  if (tddCache && tddCache.cwd === cwd && Date.now() - tddCache.ts < 2000) return tddCache.info
  const info = computeHarnessTdd(cwd)
  tddCache = { cwd, ts: Date.now(), info }
  return info
}

function computeHarnessTdd(cwd: string): TddInfo {
  const repo = repoForCwd(cwd)
  const base: TddInfo = {
    ok: false,
    repo: repo?.path || '',
    number: 0,
    overall: null,
    verdict: 'none',
    testStatus: 'none',
    stale: false,
    commitsBehind: 0,
    ts: Date.now(),
  }
  if (!repo) return base
  const dir = newestReviewDirForRepo(repoRootOf(cwd), repo.host, repo.path)
  if (!dir) return base
  const r = reviewForPrDir(dir)
  if (!r) return base
  return { ...base, ok: true, ...r }
}

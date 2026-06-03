// Wedged-session detector.
//
// Scans recently-active Claude transcripts for repeated tool errors that look
// like the session is looping on the same problem. When the same normalized
// error signature recurs N times inside a sliding window, files a HITL.
//
// Cheap by design: only reads jsonl files modified in the last `freshnessMs`
// (default 30 min) and only looks at the last `tailTurns` entries (default 60).
// No LLM. Dedup marker on disk so we don't re-file for the same wedge.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileHitl } from './hitl'
import { emitActivity } from './events'

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions')
const MARKER_FILE = join(homedir(), '.config', 'TerMinal', 'wedged-sessions.json')
const FRESHNESS_MS = 30 * 60_000
const TAIL_TURNS = 60
const WINDOW_MS = 10 * 60_000
const REPEAT_FLOOR = 3
const RE_NOTIFY_MS = 6 * 60 * 60_000 // don't re-file the same (session, sig) within 6h
const RECOVERY_WINDOW_MS = 2 * 60_000
const READ_BEFORE_WRITE_ERROR = 'File has not been read yet. Read it first before writing to it.'
const MODIFIED_SINCE_READ_ERROR =
  'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'
const WRITE_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const EXIT_CODE_BANNER_RE = /^Exit code \d+$/i
// Failure classes that are NOT wedges. Transient infra (rate limits, network) and
// deterministic config/transport errors can't be un-stuck by retrying — the agent
// backs off or routes around them — so they must not count toward a repeated-error
// wedge. NB: previews are scrubbed (4+ digit runs -> <n>), so match the 3-digit 429
// and the human phrase rather than relying on long numeric codes surviving.
const TRANSIENT_FAILURE_RE =
  /\b(429|502|503|504)\b|too many requests|rate[ -]?limit|\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED)\b|socket hang up|network (?:error|timeout)/i
const DETERMINISTIC_CONFIG_RE =
  /no repo matching|MCP error -|not authenticated|unauthorized|permission denied|\bEACCES\b/i
// Stricter signal for codex function_call_output: a bare "error" substring in a
// SUCCESS result (e.g. "All error handlers registered") must not count as a
// failure (#7 review finding). Require a real failure shape: an error keyword at
// the start of a line, a JSON error field, a 4xx/5xx status, an explicit failure
// word, or a non-zero exit.
const CODEX_ERROR_RE =
  /(^|\n)\s*(error|traceback|exception|fatal|panic)\b|"error"\s*:|"status"\s*:\s*[45]\d\d|\b(failed|enoent|eacces|killed)\b|\bexit code\s*[1-9]/i

type ErrorTurn = {
  ts: number
  signature: string
  preview: string
  eventIndex: number
  toolUseId: string
  toolName?: string
  filePath?: string
  command?: string
  // Was there a successful tool result after this error in the captured tail?
  // If so the session made progress past it and is not stuck (set after parse).
  successAfter: boolean
}

type ToolUseInfo = { toolName: string; filePath?: string; command?: string }
type TranscriptEvent =
  | ({ kind: 'tool_use'; ts: number; toolUseId: string } & ToolUseInfo)
  | ({ kind: 'tool_result'; ts: number; toolUseId: string; isError: boolean; text: string } & Partial<ToolUseInfo>)

export type WedgedSession = {
  sessionId: string
  cwd: string
  engine: 'claude' | 'codex'
  signature: string
  preview: string
  repeats: number
  windowMs: number
  lastSeenAt: number
}

type WedgePart = Pick<WedgedSession, 'signature' | 'preview' | 'repeats' | 'windowMs' | 'lastSeenAt'>

/** Pure: bucket error turns by signature and return every bucket that recurs
 *  >=REPEAT_FLOOR times inside WINDOW_MS. Shared by the Claude + Codex scans. */
function findWedges(errs: ErrorTurn[]): WedgePart[] {
  const out: WedgePart[] = []
  if (errs.length < REPEAT_FLOOR) return out
  const bySig = new Map<string, ErrorTurn[]>()
  for (const e of errs) {
    const arr = bySig.get(e.signature) || []
    arr.push(e)
    bySig.set(e.signature, arr)
  }
  for (const [sig, arr] of bySig) {
    if (arr.length < REPEAT_FLOOR) continue
    arr.sort((a, b) => a.ts - b.ts)
    // Liveness gate: a wedge only if the LATEST occurrence of this error is still
    // unresolved — no successful tool result came after it. A session that hit the
    // error and then made progress is not stuck, even if it repeated within window.
    if (arr[arr.length - 1].successAfter) continue
    // Find the first REPEAT_FLOOR-sized window that fits inside WINDOW_MS …
    let start = -1
    for (let i = 0; i + REPEAT_FLOOR - 1 < arr.length; i++) {
      if (arr[i + REPEAT_FLOOR - 1].ts - arr[i].ts <= WINDOW_MS) {
        start = i
        break
      }
    }
    if (start < 0) continue
    // … then report THAT qualifying cluster (extended to adjacent in-window hits),
    // not the whole bucket span, so the alert's "×N / window" reflects reality.
    let end = start + REPEAT_FLOOR - 1
    while (end + 1 < arr.length && arr[end + 1].ts - arr[start].ts <= WINDOW_MS) end++
    out.push({
      signature: sig,
      preview: arr[start].preview,
      repeats: end - start + 1,
      windowMs: arr[end].ts - arr[start].ts,
      lastSeenAt: arr[end].ts,
    })
  }
  return out
}

function readMarker(): Record<string, number> {
  try {
    const j = JSON.parse(readFileSync(MARKER_FILE, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function writeMarker(m: Record<string, number>) {
  try {
    mkdirSync(dirname(MARKER_FILE), { recursive: true })
    writeFileSync(MARKER_FILE, JSON.stringify(m, null, 2))
  } catch {
    /* best effort */
  }
}

/** The first line that actually describes the failure. Claude's Bash tool prepends
 *  a generic "Exit code N" banner on every non-zero exit, so unrelated commands
 *  would otherwise all share that line; skip it and key on the real message. */
function meaningfulErrorLine(s: string): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.find((l) => !EXIT_CODE_BANNER_RE.test(l)) || lines[0] || ''
}

function scrubLine(s: string): string {
  return s
    .replace(/\b\/[\w/.~-]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/:\d+:\d+/g, ':<lc>')
    .replace(/:\d+\)/g, ':<l>)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

/** Signature keys on the real error line AND the (scrubbed) command, so the SAME
 *  command failing the SAME way clusters into a wedge while unrelated failures that
 *  merely share an "Exit code N" banner stay distinct. preview is the human line. */
function normalizeErrorText(s: string, command?: string): { signature: string; preview: string } {
  const preview = scrubLine(meaningfulErrorLine(s))
  const cmdKey = command ? scrubLine(command).slice(0, 120) : ''
  const signature = createHash('sha1')
    .update(cmdKey + '\n' + preview)
    .digest('hex')
    .slice(0, 12)
  return { signature, preview }
}

function contentText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
      : ''
}

function toolUseInfo(c: any): ToolUseInfo | null {
  if (c?.type !== 'tool_use' || typeof c.id !== 'string' || typeof c.name !== 'string') return null
  const filePath = typeof c.input?.file_path === 'string' ? c.input.file_path : undefined
  const command = typeof c.input?.command === 'string' ? c.input.command : undefined
  return { toolName: c.name, filePath, command }
}

function isWriteTool(toolName?: string): boolean {
  return !!toolName && WRITE_TOOL_NAMES.has(toolName)
}

function isRecoverableEditConflict(error: ErrorTurn): boolean {
  return error.preview.includes(READ_BEFORE_WRITE_ERROR) || error.preview.includes(MODIFIED_SINCE_READ_ERROR)
}

function isRecoveredEditConflictError(error: ErrorTurn, events: TranscriptEvent[]): boolean {
  if (!isRecoverableEditConflict(error)) return false
  if (!error.filePath || !isWriteTool(error.toolName)) return false

  let readSucceeded = false
  for (let i = error.eventIndex + 1; i < events.length; i++) {
    const event = events[i]
    if (event.ts - error.ts > RECOVERY_WINDOW_MS) break
    if (event.kind !== 'tool_result' || event.filePath !== error.filePath || event.isError) continue

    if (event.toolName === 'Read') readSucceeded = true
    if (readSucceeded && isWriteTool(event.toolName)) return true
  }
  return false
}

function isSecondaryParallelCancellation(error: ErrorTurn): boolean {
  return error.preview.includes('Cancelled: parallel tool call')
}

/** Transient infra or deterministic config/transport failures — repeating these
 *  is not a wedge (retrying can't help; the agent backs off or routes around). */
function isTransientOrConfigFailure(error: ErrorTurn): boolean {
  return TRANSIENT_FAILURE_RE.test(error.preview) || DETERMINISTIC_CONFIG_RE.test(error.preview)
}

/** An edit-conflict whose recovery window has NOT yet elapsed in the captured
 *  data: the transcript is still growing and a re-Read+Edit may land within
 *  RECOVERY_WINDOW_MS. Defer it (don't count) rather than racing the file and
 *  declaring a wedge before the recovery could even be written. Next scan, once
 *  the window has closed in the data, a genuinely unrecovered conflict counts. */
function isUnconfirmedEditConflict(error: ErrorTurn, events: TranscriptEvent[]): boolean {
  if (!isRecoverableEditConflict(error)) return false
  if (isRecoveredEditConflictError(error, events)) return false
  const last = events[events.length - 1]
  return !!last && last.ts - error.ts < RECOVERY_WINDOW_MS
}

/** Index of the most recent successful tool result in the event stream, or -1. */
function lastSuccessfulResultIndex(events: TranscriptEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind === 'tool_result' && !ev.isError) return i
  }
  return -1
}

function extractErrorTurns(file: string): ErrorTurn[] {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((l) => l.trim())
  const tail = lines.slice(-TAIL_TURNS * 4)
  const toolUses = new Map<string, ToolUseInfo>()
  const events: TranscriptEvent[] = []
  const errs: ErrorTurn[] = []
  for (const line of tail) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const msg = obj.message
    if (!msg) continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    const ts = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp || '')
    const safeTs = Number.isFinite(ts) ? ts : Date.now()

    if (msg.role === 'assistant') {
      for (const c of content) {
        const info = toolUseInfo(c)
        if (!info) continue
        toolUses.set(c.id, info)
        events.push({ kind: 'tool_use', ts: safeTs, toolUseId: c.id, ...info })
      }
      continue
    }

    if (msg.role !== 'user') continue
    for (const c of content) {
      if (c?.type !== 'tool_result') continue
      const isError = c.is_error === true
      const text = contentText(c.content)
      if (!text) continue
      const toolUseId = typeof c.tool_use_id === 'string' ? c.tool_use_id : ''
      const info = toolUses.get(toolUseId)
      const eventIndex = events.push({
        kind: 'tool_result',
        ts: safeTs,
        toolUseId,
        isError,
        text,
        ...info,
      }) - 1
      // Only genuine failures (is_error) count. A successful result whose body
      // merely mentions "error"/"failed" is not a failure — and inspection tools
      // like Read/Grep routinely quote those words from file contents.
      if (!isError) continue
      const norm = normalizeErrorText(text, info?.command)
      errs.push({
        ts: safeTs,
        signature: norm.signature,
        preview: norm.preview,
        eventIndex,
        toolUseId,
        toolName: info?.toolName,
        filePath: info?.filePath,
        command: info?.command,
        successAfter: false,
      })
    }
  }
  const lastSuccessIdx = lastSuccessfulResultIndex(events)
  for (const e of errs) e.successAfter = e.eventIndex < lastSuccessIdx
  return errs.filter(
    (e) =>
      !isRecoveredEditConflictError(e, events) &&
      !isUnconfirmedEditConflict(e, events) &&
      !isSecondaryParallelCancellation(e) &&
      !isTransientOrConfigFailure(e),
  )
}

/** Latest timestamp of a genuine human REPL message in the file, or 0. Real user
 *  input is a user-role message whose content is a plain string; tool results are
 *  arrays and skill/system injections are {type:'text'} arrays, so neither counts.
 *  Used to skip attended sessions — a human typing is already on the problem. */
function lastHumanInputAt(file: string): number {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  let latest = 0
  const lines = raw.split('\n').filter((l) => l.trim())
  for (const line of lines.slice(-TAIL_TURNS * 4)) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.isMeta) continue
    const msg = obj.message
    if (!msg || msg.role !== 'user' || typeof msg.content !== 'string' || !msg.content.trim()) continue
    const ts = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp || '')
    if (Number.isFinite(ts) && ts > latest) latest = ts
  }
  return latest
}

function sessionCwd(file: string): string {
  try {
    const raw = readFileSync(file, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (typeof obj.cwd === 'string') return obj.cwd
      } catch {}
    }
  } catch {}
  return ''
}

function scanClaude(cutoff: number): WedgedSession[] {
  if (!existsSync(CLAUDE_PROJECTS)) return []
  const wedged: WedgedSession[] = []
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS)
  } catch {
    return []
  }
  for (const dir of projectDirs) {
    const p = join(CLAUDE_PROJECTS, dir)
    let files: string[] = []
    try {
      files = readdirSync(p)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const file = join(p, f)
      let mtime = 0
      try {
        mtime = statSync(file).mtimeMs
      } catch {
        continue
      }
      if (mtime < cutoff) continue
      const errs = extractErrorTurns(file)
      const parts = findWedges(errs)
      if (!parts.length) continue
      // Skip attended sessions: if a human typed into the REPL after the wedge's
      // last error, someone is already on it — only unattended agents need a HITL.
      const humanTs = lastHumanInputAt(file)
      const sessionId = f.replace(/\.jsonl$/, '')
      const cwd = sessionCwd(file)
      for (const part of parts) {
        if (humanTs > part.lastSeenAt) continue
        wedged.push({ sessionId, cwd, engine: 'claude', ...part })
      }
    }
  }
  return wedged
}

/** Recursively collect .jsonl files under `root` modified at/after `cutoff`.
 *  Codex nests sessions by date (sessions/YYYY/MM/DD/rollout-*.jsonl). */
function findRecentJsonl(root: string, cutoff: number, out: string[] = []): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(root, e)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) findRecentJsonl(full, cutoff, out)
    else if (e.endsWith('.jsonl') && st.mtimeMs >= cutoff) out.push(full)
  }
  return out
}

/** Reduce a codex function_call_output string to its most error-relevant line,
 *  dropping the "Wall time: …" / "Output:" preamble so the signature keys on the
 *  actual failure, not the (always-varying) wall-clock line. */
function codexErrorLine(output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^wall time:/i.test(l) && l !== 'Output:')
  const errLine = lines.find((l) => CODEX_ERROR_RE.test(l.slice(0, 400)))
  return errLine || lines[0] || output
}

/** Decide whether a codex function_call_output is a genuine failure. Codex wraps
 *  tool output in an execution envelope ("Process exited with code N") — when
 *  present, TRUST the exit code (code 0 = success even if the body contains
 *  "error"/"failed"/JSON examples). Only when there is no envelope do we fall
 *  back to the failure-shape heuristic. Prevents repeated SUCCESS outputs from
 *  tripping the wedge detector (#9 review follow-up). */
function codexOutputIsError(text: string): boolean {
  const exit = text.match(/exited with code\s+(\d+)/i)
  if (exit) return exit[1] !== '0'
  return CODEX_ERROR_RE.test(text.slice(0, 400))
}

function extractCodexErrorTurns(file: string): ErrorTurn[] {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((l) => l.trim())
  // Codex emits far more lines per turn than Claude (reasoning, web_search, …),
  // so widen the tail to cover a comparable number of tool calls.
  const tail = lines.slice(-TAIL_TURNS * 8)
  const errs: ErrorTurn[] = []
  let outputIdx = -1
  let lastSuccessIdx = -1
  for (const line of tail) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const p = obj.payload
    if (obj.type !== 'response_item' || p?.type !== 'function_call_output') continue
    const text = typeof p.output === 'string' ? p.output : contentText(p.output)
    if (!text) continue
    outputIdx++
    if (!codexOutputIsError(text)) {
      lastSuccessIdx = outputIdx
      continue
    }
    const ts = Date.parse(obj.timestamp || '')
    const safeTs = Number.isFinite(ts) ? ts : Date.now()
    const norm = normalizeErrorText(codexErrorLine(text))
    errs.push({
      ts: safeTs,
      signature: norm.signature,
      preview: norm.preview,
      eventIndex: outputIdx,
      toolUseId: typeof p.call_id === 'string' ? p.call_id : '',
      successAfter: false,
    })
  }
  for (const e of errs) e.successAfter = e.eventIndex < lastSuccessIdx
  return errs.filter((e) => !isTransientOrConfigFailure(e))
}

/** Session id + cwd from a codex rollout file (session_meta / turn_context). */
function codexSessionMeta(file: string): { sessionId: string; cwd: string } {
  let sessionId = (file.split('/').pop() || '').replace(/\.jsonl$/, '')
  let cwd = ''
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let obj: any
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const p = obj.payload
      if (obj.type === 'session_meta' && p) {
        if (typeof p.id === 'string') sessionId = p.id
        if (typeof p.cwd === 'string') cwd = p.cwd
      } else if (obj.type === 'turn_context' && p && !cwd && typeof p.cwd === 'string') {
        cwd = p.cwd
      }
      if (sessionId && cwd) break
    }
  } catch {
    /* best effort */
  }
  return { sessionId, cwd }
}

function scanCodex(cutoff: number): WedgedSession[] {
  if (!existsSync(CODEX_SESSIONS)) return []
  const wedged: WedgedSession[] = []
  for (const file of findRecentJsonl(CODEX_SESSIONS, cutoff)) {
    const parts = findWedges(extractCodexErrorTurns(file))
    if (!parts.length) continue
    const { sessionId, cwd } = codexSessionMeta(file)
    for (const part of parts) wedged.push({ sessionId, cwd, engine: 'codex', ...part })
  }
  return wedged
}

export function detectWedgedSessions(): WedgedSession[] {
  const cutoff = Date.now() - FRESHNESS_MS
  return [...scanClaude(cutoff), ...scanCodex(cutoff)]
}

export function runWedgedSessionScan(): { detected: number; filed: number } {
  const wedged = detectWedgedSessions()
  if (wedged.length === 0) return { detected: 0, filed: 0 }
  const marker = readMarker()
  const now = Date.now()
  let filed = 0
  for (const w of wedged) {
    const key = `${w.sessionId}::${w.signature}`
    const last = marker[key] || 0
    if (now - last < RE_NOTIFY_MS) continue
    fileHitl({
      source: 'wedged-detector',
      title: `Session likely wedged · same error ×${w.repeats}`,
      action: 'check the session log',
      detail:
        `engine: ${w.engine}\n` +
        `session: ${w.sessionId}\n` +
        (w.cwd ? `cwd: ${w.cwd}\n` : '') +
        `repeated error: ${w.preview}\n` +
        `window: ${Math.round(w.windowMs / 1000)}s`,
      repoRoot: w.cwd || undefined,
      sessionId: w.sessionId,
    })
    emitActivity({
      kind: 'check',
      title: `Wedged session · ${w.preview.slice(0, 80)}`,
      detail: `session ${w.sessionId} · ${w.repeats}× in ${Math.round(w.windowMs / 1000)}s`,
      repoRoot: w.cwd || undefined,
      sessionId: w.sessionId,
    })
    marker[key] = now
    filed++
  }
  // Prune marker entries older than 24h to avoid unbounded growth
  for (const k of Object.keys(marker)) {
    if (now - marker[k] > 24 * 60 * 60_000) delete marker[k]
  }
  writeMarker(marker)
  return { detected: wedged.length, filed }
}

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

function claudeProjectsDir(): string {
  const override = process.env.TERMINAL_CLAUDE_PROJECTS?.trim()
  return override || join(homedir(), '.claude', 'projects')
}
const MARKER_FILE = join(homedir(), '.config', 'TerMinal', 'wedged-sessions.json')
const FRESHNESS_MS = 30 * 60_000
const TAIL_TURNS = 60
const WINDOW_MS = 10 * 60_000
const REPEAT_FLOOR = 3
const RE_NOTIFY_MS = 6 * 60 * 60_000 // don't re-file the same (session, sig) within 6h
const RECOVERY_WINDOW_MS = 2 * 60_000
const READ_BEFORE_WRITE_ERROR = 'File has not been read yet. Read it first before writing to it.'
const WRITE_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

type ErrorTurn = {
  ts: number
  signature: string
  preview: string
  eventIndex: number
  toolUseId: string
  toolName?: string
  filePath?: string
}

type ToolUseInfo = { toolName: string; filePath?: string }
type TranscriptEvent =
  | ({ kind: 'tool_use'; ts: number; toolUseId: string } & ToolUseInfo)
  | ({ kind: 'tool_result'; ts: number; toolUseId: string; isError: boolean; text: string } & Partial<ToolUseInfo>)

export type WedgedSession = {
  sessionId: string
  cwd: string
  signature: string
  preview: string
  repeats: number
  windowMs: number
  lastSeenAt: number
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

function normalizeErrorText(s: string): { signature: string; preview: string } {
  const firstLine = (s.split('\n').find((l) => l.trim()) || '').trim()
  const cleaned = firstLine
    .replace(/\b\/[\w/.~-]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/:\d+:\d+/g, ':<lc>')
    .replace(/:\d+\)/g, ':<l>)')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
  const signature = createHash('sha1').update(cleaned).digest('hex').slice(0, 12)
  return { signature, preview: cleaned }
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
  return { toolName: c.name, filePath }
}

function isWriteTool(toolName?: string): boolean {
  return !!toolName && WRITE_TOOL_NAMES.has(toolName)
}

function isRecoveredReadBeforeWriteError(error: ErrorTurn, events: TranscriptEvent[]): boolean {
  if (!error.preview.includes(READ_BEFORE_WRITE_ERROR)) return false
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
      const looksLikeError =
        isError ||
        /\b(error|exception|traceback|failed|fatal|enoent|eacces|panic|killed)\b/i.test(text.slice(0, 400))
      if (!looksLikeError) continue
      const norm = normalizeErrorText(text)
      errs.push({
        ts: safeTs,
        signature: norm.signature,
        preview: norm.preview,
        eventIndex,
        toolUseId,
        toolName: info?.toolName,
        filePath: info?.filePath,
      })
    }
  }
  return errs.filter((e) => !isRecoveredReadBeforeWriteError(e, events))
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

export function detectWedgedSessions(): WedgedSession[] {
  const projectsDir = claudeProjectsDir()
  if (!existsSync(projectsDir)) return []
  const cutoff = Date.now() - FRESHNESS_MS
  const wedged: WedgedSession[] = []
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(projectsDir)
  } catch {
    return []
  }
  for (const dir of projectDirs) {
    const p = join(projectsDir, dir)
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
      const sessionId = f.replace(/\.jsonl$/, '')
      const errs = extractErrorTurns(file)
      if (errs.length < REPEAT_FLOOR) continue
      // Bucket by signature and find any bucket with >=REPEAT_FLOOR within WINDOW_MS
      const bySig = new Map<string, ErrorTurn[]>()
      for (const e of errs) {
        const arr = bySig.get(e.signature) || []
        arr.push(e)
        bySig.set(e.signature, arr)
      }
      for (const [sig, arr] of bySig) {
        if (arr.length < REPEAT_FLOOR) continue
        arr.sort((a, b) => a.ts - b.ts)
        // Find the first window that contains >=REPEAT_FLOOR
        for (let i = 0; i + REPEAT_FLOOR - 1 < arr.length; i++) {
          const span = arr[i + REPEAT_FLOOR - 1].ts - arr[i].ts
          if (span <= WINDOW_MS) {
            wedged.push({
              sessionId,
              cwd: sessionCwd(file),
              signature: sig,
              preview: arr[0].preview,
              repeats: arr.length,
              windowMs: arr[arr.length - 1].ts - arr[0].ts,
              lastSeenAt: arr[arr.length - 1].ts,
            })
            break
          }
        }
      }
    }
  }
  return wedged
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

// Collectors — observe every AI execution surface and feed the ai-runs/ ledger.
// Wraps the existing transcript parsers and the cron/agent runner output paths.
//
// Five sources:
//   claude-code   → reads ~/.claude/projects/<hash>/<sid>.jsonl
//   codex-cli     → reads ~/.codex/sessions/<sid>/messages.jsonl (best effort)
//   claude-p      → parses the usage summary line from `claude -p` stdout
//   codex-exec    → parses the usage summary line from `codex exec` stdout
//   cursor-agent  → parses the `result.usage` NDJSON event from cursor-agent's
//                   `--output-format stream-json` stdout (parseCursorUsageFromOutput)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { listAIRuns, writeAIRun, makeAIRun, type AIRunSource } from './ai-runs'
import { runWedgedSessionScan } from './wedged-session-detector'
import { parseCursorUsageFromOutput } from './cursor-stream'

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions')

// ---------------------------------------------------------------------------
// Claude transcripts → AIRuns
//
// Each ~/.claude/projects/<hash>/<sid>.jsonl gets summarized into ONE AIRun
// record per session id. We sum usage across turns to get totals, then
// stamp the cwd + model + duration. Idempotent: we use the sessionId as the
// AIRun id so re-running just overwrites with the latest totals.
// ---------------------------------------------------------------------------

type ClaudeUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type ClaudeSessionSummary = {
  sessionId: string
  cwd: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  startedAt: number
  endedAt: number
  turns: number
}

function parseClaudeSession(file: string, sessionId: string): ClaudeSessionSummary | null {
  let cwd = ''
  let model = ''
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let startedAt = 0
  let endedAt = 0
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
    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
    const ts = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp || '')
    if (!Number.isNaN(ts) && ts > 0) {
      if (!startedAt) startedAt = ts
      endedAt = ts
    }
    const msg = obj.message
    if (!msg || msg.role !== 'assistant') continue
    const u: ClaudeUsage | undefined = msg.usage
    if (!u) continue
    turns++
    if (typeof msg.model === 'string') model = msg.model
    input += u.input_tokens || 0
    output += u.output_tokens || 0
    cacheRead += u.cache_read_input_tokens || 0
    cacheWrite += u.cache_creation_input_tokens || 0
  }
  if (turns === 0) return null
  return {
    sessionId,
    cwd,
    model: model || 'unknown',
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    startedAt: startedAt || Date.now(),
    endedAt: endedAt || Date.now(),
    turns,
  }
}

/** Walk the Claude projects dir and persist an AIRun per session.
 *  Idempotent: AIRun.id = `claude-${sessionId}` so re-runs overwrite the
 *  same record with fresh totals as the transcript grows. */
export function collectClaudeSessions(maxAgeMs = 30 * 86_400_000): { written: number } {
  if (!existsSync(CLAUDE_PROJECTS)) return { written: 0 }
  let written = 0
  const cutoff = Date.now() - maxAgeMs
  let dirs: string[] = []
  try {
    dirs = readdirSync(CLAUDE_PROJECTS)
  } catch {
    return { written: 0 }
  }
  for (const dir of dirs) {
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
      if (mtime < cutoff) continue // ancient — don't bother
      const sessionId = f.replace(/\.jsonl$/, '')
      const summary = parseClaudeSession(file, sessionId)
      if (!summary) continue
      const run = makeAIRun({
        source: 'claude-code',
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        model: summary.model,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cacheReadTokens: summary.cacheReadTokens,
        cacheWriteTokens: summary.cacheWriteTokens,
        repoRoot: summary.cwd,
        sessionId,
        durationMs: summary.endedAt - summary.startedAt,
      })
      // Override id with deterministic key for idempotent overwrite
      run.id = `claude-${sessionId}`
      writeAIRun(run)
      written++
    }
  }
  return { written }
}

// ---------------------------------------------------------------------------
// Codex transcripts → AIRuns
// Best effort — codex's session format may vary by version. We look for
// per-message `usage` fields like Claude's; absent that, skip.
// ---------------------------------------------------------------------------

export function collectCodexSessions(maxAgeMs = 30 * 86_400_000): { written: number } {
  if (!existsSync(CODEX_SESSIONS)) return { written: 0 }
  let written = 0
  const cutoff = Date.now() - maxAgeMs
  let sessionDirs: string[] = []
  try {
    sessionDirs = readdirSync(CODEX_SESSIONS)
  } catch {
    return { written: 0 }
  }
  for (const sid of sessionDirs) {
    const sessionDir = join(CODEX_SESSIONS, sid)
    let files: string[] = []
    try {
      files = readdirSync(sessionDir)
    } catch {
      continue
    }
    // Common locations: messages.jsonl, transcript.jsonl
    const candidate =
      files.find((f) => f === 'messages.jsonl') ||
      files.find((f) => f === 'transcript.jsonl') ||
      files.find((f) => f.endsWith('.jsonl'))
    if (!candidate) continue
    const file = join(sessionDir, candidate)
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (mtime < cutoff) continue
    let input = 0
    let output = 0
    let model = ''
    let cwd = ''
    let startedAt = 0
    let endedAt = mtime
    let turns = 0
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let obj: any
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
      if (typeof obj.model === 'string') model = obj.model
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp || '')
      if (!Number.isNaN(ts) && ts > 0) {
        if (!startedAt) startedAt = ts
        endedAt = ts
      }
      const u = obj.usage || obj.message?.usage
      if (u) {
        turns++
        input += u.input_tokens || u.prompt_tokens || 0
        output += u.output_tokens || u.completion_tokens || 0
      }
    }
    if (turns === 0) continue
    const run = makeAIRun({
      source: 'codex-cli',
      startedAt: startedAt || endedAt,
      endedAt,
      model: model || 'gpt-5',
      inputTokens: input,
      outputTokens: output,
      repoRoot: cwd,
      sessionId: sid,
      durationMs: endedAt - (startedAt || endedAt),
    })
    run.id = `codex-${sid}`
    writeAIRun(run)
    written++
  }
  return { written }
}

// ---------------------------------------------------------------------------
// claude -p / codex exec stdout parsers — used by the in-process and cron
// runners when they capture child output.
// ---------------------------------------------------------------------------

type UsageHit = {
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Parse the usage summary line emitted by `claude -p` at exit. Format varies
 *  by claude CLI version; we look for "Total tokens: X input + Y output" and
 *  optional "(Z cached)" and "Model: claude-...". */
export function parseClaudeUsageFromOutput(out: string): UsageHit | null {
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let model: string | undefined
  // Walk lines from the end — usage summary lives near the tail
  const lines = out.split('\n').slice(-200)
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // strip ANSI
    let m: RegExpMatchArray | null
    if (
      (m = line.match(/(?:input|prompt)\s*tokens?[:\s]+(\d[\d,]*)/i)) &&
      inputTokens === 0
    ) {
      inputTokens = parseInt(m[1].replace(/,/g, ''), 10)
    }
    if (
      (m = line.match(/(?:output|completion)\s*tokens?[:\s]+(\d[\d,]*)/i)) &&
      outputTokens === 0
    ) {
      outputTokens = parseInt(m[1].replace(/,/g, ''), 10)
    }
    if (
      (m = line.match(/cache(?:d|\s*read)?[:\s]+(\d[\d,]*)/i)) &&
      cacheRead === 0
    ) {
      cacheRead = parseInt(m[1].replace(/,/g, ''), 10)
    }
    if (!model && (m = line.match(/model[:\s]+([\w\-\.]+)/i))) {
      model = m[1]
    }
  }
  if (inputTokens === 0 && outputTokens === 0) return null
  return { inputTokens, outputTokens, cacheReadTokens: cacheRead || undefined, model }
}

/** codex exec uses a similar tail summary; same parser works in most cases. */
export const parseCodexUsageFromOutput = parseClaudeUsageFromOutput

/** cursor-agent emits structured NDJSON, not a regex tail summary — its usage
 *  lives in the `result.usage` event. Re-exported from cursor-stream (the pure,
 *  dependency-free decoder module) so the parser stays unit-testable without the
 *  electron-coupled ai-collectors graph. */
export { parseCursorUsageFromOutput } from './cursor-stream'

// Default model per source when neither the parsed transcript nor the caller's
// modelHint names one. Subscription CLIs (cursor) price at $0 anyway.
const DEFAULT_MODEL: Record<RunnerSource, string> = {
  'claude-p': 'sonnet',
  'codex-exec': 'gpt-5',
  'cursor-agent': 'composer-2.5',
}

type RunnerSource = 'claude-p' | 'codex-exec' | 'cursor-agent'

/** Build + persist an AIRun for a wrapped `claude -p` / `codex exec` /
 *  `cursor-agent` run that captured its child output. Returns false (records
 *  nothing) when no usage could be parsed — the caller treats observability as
 *  best-effort. */
export function recordRunnerInvocation(opts: {
  source: RunnerSource
  output: string
  repoRoot: string
  runId: string
  agentId?: string
  startedAt: number
  endedAt: number
  exitCode: number
  modelHint?: string
}): boolean {
  const parsed =
    opts.source === 'claude-p'
      ? parseClaudeUsageFromOutput(opts.output)
      : opts.source === 'codex-exec'
        ? parseCodexUsageFromOutput(opts.output)
        : parseCursorUsageFromOutput(opts.output)
  if (!parsed) return false
  const run = makeAIRun({
    source: opts.source,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    model: parsed.model || opts.modelHint || DEFAULT_MODEL[opts.source],
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    // cursor's result.usage carries cacheWriteTokens; the claude/codex tail
    // parser does not (its UsageHit has no such field), so this is undefined there.
    cacheWriteTokens: 'cacheWriteTokens' in parsed ? parsed.cacheWriteTokens : undefined,
    repoRoot: opts.repoRoot,
    runId: opts.runId,
    agentId: opts.agentId,
    durationMs: opts.endedAt - opts.startedAt,
    exitCode: opts.exitCode,
  })
  writeAIRun(run)
  return true
}

/** App-boot scan: pull every Claude/Codex session into the ledger, then
 *  schedule periodic re-scans so growing transcripts update their totals.
 *  Also piggybacks the wedged-session detector on each tick — same cadence,
 *  same dataset (recent Claude transcripts), no extra polling. */
export function startAICollectionLoop(): void {
  // Initial scan immediately so the Observability tab shows real data at
  // app start. Then poll every 5 min — cheap (only reads transcripts
  // modified within the last 30 days).
  try {
    collectClaudeSessions()
    collectCodexSessions()
    runWedgedSessionScan()
  } catch {
    /* best effort */
  }
  setInterval(() => {
    try {
      collectClaudeSessions()
      collectCodexSessions()
      runWedgedSessionScan()
    } catch {
      /* best effort */
    }
  }, 5 * 60 * 1000)
}

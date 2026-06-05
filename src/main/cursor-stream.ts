// Decode cursor-agent's `--output-format stream-json --stream-partial-output`
// NDJSON back into the plain text a run log wants. Pure + dependency-free (like
// engine-cmd.ts / pipelines.ts) so it's unit-testable without the electron
// runtime; the impure caller (agents.ts) just pipes stdout chunks through it.
//
// Why this exists: cursor's default `--output-format text` buffers the entire
// turn and prints it only on completion, so a live run shows nothing for
// minutes and looks hung. stream-json emits incremental events; this turns them
// back into readable text + progress breadcrumbs as they arrive.
//
// Event schema (captured from a real run under script(1)'s pseudo-TTY):
//   {"type":"system","subtype":"init","model":"Composer 2.5 Fast",...}
//   {"type":"user","message":{"role":"user","content":[{"type":"text",...}]}}
//   {"type":"thinking","subtype":"delta","text":"…"}
//   {"type":"assistant","message":{role,content:[{type:"text",text:"The"}]},"timestamp_ms":…}  ← delta
//   {"type":"assistant","message":{…content:[{type:"text",text:"The quick …"}]}}               ← cumulative final (NO ts)
//   {"type":"tool_call","subtype":"started","tool_call":{"writeToolCall":{"args":{"path":"summary.txt",...}}}}
//   {"type":"tool_call","subtype":"completed","tool_call":{"writeToolCall":{"result":{"success":{"path":"summary.txt"}}}}}
//   {"type":"result","subtype":"success","result":"The quick …",...}
// The PTY also wraps the stream in chrome: a leading ^D^H^H, CR (\r) line
// endings, and a trailing ESC[?25h (show-cursor). All stripped before parsing.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g // CSI sequences (cursor moves, ?25h, colors)
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g // OSC sequences (title, etc.)
const CTRL = /[\x00-\x1f\x7f]/g // remaining control bytes: ^D ^H ^M …

function stripChrome(s: string): string {
  return s.replace(ANSI, '').replace(OSC, '').replace(CTRL, '')
}

function breadcrumb(type: string, subtype?: unknown, name?: unknown): string {
  const sub = typeof subtype === 'string' ? `:${subtype}` : ''
  const nm = typeof name === 'string' ? ` ${name}` : ''
  return `· ${type}${sub}${nm}\n`
}

type ToolContext = { name: string; detail: string }

const cleanText = (v: string): string => v.replace(/\s+/g, ' ').trim()

function truncate(v: string, max = 140): string {
  const s = cleanText(v)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function pickString(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return ''
  const rec = obj as Record<string, unknown>
  for (const key of keys) {
    const val = rec[key]
    if (typeof val === 'string' && val.trim()) return val
  }
  return ''
}

function formatBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

function formatToolName(raw: string): string {
  return (
    raw
      .replace(/ToolCall$/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .trim() || 'tool'
  )
}

function toolPayload(ev: any): { name: string; args?: unknown; result?: unknown } | null {
  const calls = ev?.tool_call
  if (!calls || typeof calls !== 'object') return null
  const entries = Object.entries(calls as Record<string, unknown>)
  const [rawName, payload] =
    entries.find(([key, val]) => key.endsWith('ToolCall') && val && typeof val === 'object') ?? entries[0] ?? []
  if (!rawName || !payload || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  return { name: formatToolName(rawName), args: rec.args, result: rec.result }
}

function argsDetail(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const rec = args as Record<string, unknown>
  const command = pickString(rec, ['command', 'cmd', 'script'])
  if (command) return truncate(command)
  const path = pickString(rec, ['path', 'filePath', 'filepath', 'relativePath', 'targetPath'])
  if (path) return truncate(path)
  const url = pickString(rec, ['url', 'uri'])
  if (url) return truncate(url)
  const query = pickString(rec, ['query', 'pattern', 'search', 'regex'])
  if (query) return `"${truncate(query, 100)}"`
  const paths = rec.paths
  if (Array.isArray(paths)) {
    const shown = paths.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, 2)
    if (shown.length) return truncate(shown.join(', '))
  }
  const fileText = rec.fileText
  if (typeof fileText === 'string') return `content (${fileText.length} chars)`
  return ''
}

function unwrapResult(result: unknown): { ok: boolean; value: unknown } {
  if (!result || typeof result !== 'object') return { ok: true, value: result }
  const rec = result as Record<string, unknown>
  if ('success' in rec) return { ok: true, value: rec.success }
  if ('error' in rec) return { ok: false, value: rec.error }
  if ('failure' in rec) return { ok: false, value: rec.failure }
  return { ok: true, value: result }
}

function resultDetail(result: unknown, fallback: ToolContext | null): string {
  const { ok, value } = unwrapResult(result)
  if (typeof value === 'string') return ok ? truncate(value) : `failed: ${truncate(value)}`
  if (!value || typeof value !== 'object') return fallback?.detail ?? ''
  const rec = value as Record<string, unknown>
  if (!ok) {
    const msg = pickString(rec, ['message', 'error', 'stderr', 'reason'])
    return msg ? `failed: ${truncate(msg)}` : 'failed'
  }
  const subject =
    pickString(rec, ['path', 'filePath', 'filepath', 'relativePath', 'targetPath']) || fallback?.detail || ''
  const extras = [
    typeof rec.linesCreated === 'number' ? `${rec.linesCreated} lines` : '',
    typeof rec.linesModified === 'number' ? `${rec.linesModified} lines modified` : '',
    typeof rec.linesDeleted === 'number' ? `${rec.linesDeleted} lines deleted` : '',
    typeof rec.exitCode === 'number' ? `exit ${rec.exitCode}` : '',
    formatBytes(rec.fileSize),
  ].filter(Boolean)
  const suffix = extras.length ? ` (${extras.join(', ')})` : ''
  return truncate(`${subject}${suffix}`)
}

function renderToolCall(ev: any, activeTools: Map<string, ToolContext>): string {
  const call = toolPayload(ev)
  const callId = typeof ev?.call_id === 'string' ? ev.call_id : ''
  const fallback = callId ? activeTools.get(callId) ?? null : null
  const name = call?.name || fallback?.name || 'tool'
  const detail = call ? argsDetail(call.args) : fallback?.detail || ''
  if (callId && ev?.subtype === 'started') activeTools.set(callId, { name, detail })
  if (ev?.subtype === 'completed') {
    if (callId) activeTools.delete(callId)
    const result = resultDetail(call?.result, fallback || (detail ? { name, detail } : null))
    return `· ${name} completed${result ? ` ${result}` : ''}\n`
  }
  if (typeof ev?.subtype === 'string' && ev.subtype !== 'started') {
    return `· ${name}:${ev.subtype}${detail ? ` ${detail}` : ''}\n`
  }
  return `· ${name}${detail ? ` ${detail}` : ''}\n`
}

function renderEvent(ev: any, activeTools: Map<string, ToolContext>): string {
  const type: unknown = ev?.type
  if (type === 'assistant') {
    // The trailing cumulative snapshot has no timestamp_ms — skip it or the full
    // message would be appended a second time after the deltas already streamed.
    if (typeof ev.timestamp_ms !== 'number') return ''
    const parts = ev?.message?.content
    if (!Array.isArray(parts)) return ''
    let out = ''
    for (const p of parts) {
      if (p?.type === 'text') out += typeof p.text === 'string' ? p.text : ''
      else if (typeof p?.type === 'string') out += breadcrumb(p.type, undefined, p.name) // tool_use etc.
    }
    return out
  }
  // Echo (user), boot (system), reasoning (thinking), and the final duplicate
  // (result) carry nothing the log needs beyond what the deltas already showed.
  if (type === 'thinking' || type === 'user' || type === 'system' || type === 'result') return ''
  if (type === 'tool_call') return renderToolCall(ev, activeTools)
  if (typeof type !== 'string') return ''
  // Anything else (tool calls, status events, future event types) → a one-line
  // breadcrumb so the silent middle of a long step shows live progress.
  return breadcrumb(type, ev.subtype, ev.name)
}

// ---------------------------------------------------------------------------
// Usage extraction for the ai-runs ledger.
//
// cursor-agent does NOT print a regex-scannable tail summary like `claude -p` /
// `codex exec`; it emits structured NDJSON. Token usage lives in the terminal
// `result/success` event under a camelCase `usage` object, and the model name
// lives in the leading `system/init` event:
//
//   {"type":"system","subtype":"init","model":"Composer 2.5",...}
//   {"type":"result","subtype":"success","result":"…","usage":{
//      "inputTokens":21236,"outputTokens":38,"cacheReadTokens":5390,"cacheWriteTokens":0}}
//
// Captured verbatim from a real probe (cursor-agent 2026.06.04). There is no
// cost/USD field — cursor is a subscription CLI, so the ledger prices Composer
// at $0 (its model isn't in ai-pricing's table → zero-cost row) while still
// tracking tokens. Pure + dependency-free so it's unit-testable like the
// decoder. Mirrors the UsageHit shape parseClaudeUsageFromOutput returns.
// ---------------------------------------------------------------------------

export type CursorUsageHit = {
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Parse token usage from a captured cursor-agent stream-json run. Scans the
 *  NDJSON for the `result` event's `usage` object (the source of truth) and the
 *  `system/init` event's model name. Returns null when no usage-bearing result
 *  event is present (e.g. the run was killed mid-turn) so the caller can fall
 *  back to its modelHint, matching parseClaudeUsageFromOutput's null contract. */
export function parseCursorUsageFromOutput(out: string): CursorUsageHit | null {
  let model: string | undefined
  let usage: CursorUsageHit | null = null
  for (const seg of out.split(/\r\n|\r|\n/)) {
    const clean = stripChrome(seg).trim()
    if (!clean) continue
    let ev: any
    try {
      ev = JSON.parse(clean)
    } catch {
      continue // chrome / non-JSON line — ignore
    }
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string' && !model) {
      model = ev.model
    }
    const u = ev.type === 'result' ? ev.usage : undefined
    if (u && typeof u === 'object') {
      usage = {
        inputTokens: num(u.inputTokens ?? u.input_tokens),
        outputTokens: num(u.outputTokens ?? u.output_tokens),
        cacheReadTokens: num(u.cacheReadTokens ?? u.cache_read_input_tokens) || undefined,
        cacheWriteTokens: num(u.cacheWriteTokens ?? u.cache_creation_input_tokens) || undefined,
      }
    }
  }
  if (!usage) return null
  return { ...usage, model }
}

export type CursorStreamDecoder = (chunk: string) => string

/**
 * Stateful decoder for one cursor-agent process's stdout. Call the returned
 * function with each raw chunk; it buffers partial lines across chunks and
 * returns the decoded human-readable text to append (may be '').
 */
export function createCursorStreamDecoder(): CursorStreamDecoder {
  let buf = ''
  const activeTools = new Map<string, ToolContext>()
  return (chunk: string): string => {
    buf += chunk
    const segs = buf.split(/\r\n|\r|\n/)
    buf = segs.pop() ?? '' // last segment is incomplete until its newline arrives
    let out = ''
    for (const seg of segs) {
      const clean = stripChrome(seg).trim()
      if (!clean) continue
      let ev: unknown
      try {
        ev = JSON.parse(clean)
      } catch {
        continue // chrome / non-JSON line — ignore
      }
      out += renderEvent(ev, activeTools)
    }
    return out
  }
}

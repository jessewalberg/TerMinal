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

function renderEvent(ev: any): string {
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
  if (typeof type !== 'string') return ''
  // Anything else (tool calls, status events, future event types) → a one-line
  // breadcrumb so the silent middle of a long step shows live progress.
  return breadcrumb(type, ev.subtype, ev.name)
}

export type CursorStreamDecoder = (chunk: string) => string

/**
 * Stateful decoder for one cursor-agent process's stdout. Call the returned
 * function with each raw chunk; it buffers partial lines across chunks and
 * returns the decoded human-readable text to append (may be '').
 */
export function createCursorStreamDecoder(): CursorStreamDecoder {
  let buf = ''
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
      out += renderEvent(ev)
    }
    return out
  }
}

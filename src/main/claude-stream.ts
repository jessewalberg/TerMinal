// Decode claude's `-p … --output-format stream-json --verbose
// --include-partial-messages` NDJSON back into the plain text a run log wants.
// Pure + dependency-free (like cursor-stream.ts / engine-cmd.ts) so it's
// unit-testable without the electron runtime; the impure caller (agents.ts)
// pipes stdout chunks through it.
//
// Why this exists: `claude -p` with the default `--output-format text` BUFFERS
// the entire turn and prints it only on completion, so a live run shows nothing
// but the header for minutes (looks hung / wedged) — exactly the problem cursor
// had. stream-json emits incremental events; this turns the text deltas back
// into readable text + tool breadcrumbs as they arrive, and folds the final
// usage into one summary line the AI ledger can parse for cost (ai-collectors).
//
// Event schema (captured from a real run under script(1)'s pseudo-TTY):
//   {"type":"system","subtype":"init","model":"claude-opus-4-8[1m]", …}          ← + hook_started/_response, status: noise
//   {"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-8", …}}}
//   {"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}
//   {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Seven"}}}  ← live text
//   {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta", …}}}          ← skipped
//   {"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Bash", …}}}
//   {"type":"assistant","message":{role,content:[{type:"text",text:"Seven …"}]}}  ← cumulative snapshot: SKIP (would double-print)
//   {"type":"result","subtype":"success","result":"Seven …","usage":{…},"total_cost_usd":0.257}
//   {"type":"rate_limit_event", …}                                                ← noise
// The PTY also wraps the stream in chrome: a leading ^D^H^H, CR (\r) line
// endings, and a trailing ESC[?25h (show-cursor). All stripped before parsing.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g // CSI sequences (cursor moves, ?25h, colors)
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g // OSC sequences (title, etc.)
const CTRL = /[\x00-\x1f\x7f]/g // remaining control bytes: ^D ^H ^M …

function stripChrome(s: string): string {
  return s.replace(ANSI, '').replace(OSC, '').replace(CTRL, '')
}

function pickModel(raw: unknown): string {
  // "claude-opus-4-8[1m]" → "claude-opus-4-8"; the cost parser's model regex
  // stops at the bracket anyway, but trimming keeps the ledger model clean.
  return typeof raw === 'string' ? raw.replace(/\[.*$/, '').trim() : ''
}

function usageLine(obj: any, model: string): string {
  const u = obj?.usage
  if (!u || typeof u !== 'object') return ''
  const input = Number(u.input_tokens) || 0
  const output = Number(u.output_tokens) || 0
  const cacheRead = Number(u.cache_read_input_tokens) || 0
  const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined
  // Shaped for parseClaudeUsageFromOutput (ai-collectors): "model:", "input
  // tokens:", "output tokens:", "cache read:". The "$cost" is for humans — the
  // ledger recomputes cost from tokens.
  const parts = [
    model ? `model: ${model}` : '',
    `input tokens: ${input}`,
    `output tokens: ${output}`,
    cacheRead ? `cache read: ${cacheRead}` : '',
    cost !== undefined ? `cost: $${cost.toFixed(2)}` : '',
  ].filter(Boolean)
  return `\n[usage] ${parts.join(' · ')}\n`
}

function renderStreamEvent(ev: any, state: { model: string }): string {
  const type: unknown = ev?.type
  if (type === 'message_start') {
    const m = pickModel(ev?.message?.model)
    if (m) state.model = m
    return ''
  }
  if (type === 'content_block_start') {
    const block = ev?.content_block
    if (block?.type === 'tool_use' && typeof block.name === 'string') return `· ${block.name}\n`
    return ''
  }
  if (type === 'content_block_delta') {
    const d = ev?.delta
    if (d?.type === 'text_delta' && typeof d.text === 'string') return d.text
    return '' // thinking_delta, signature_delta, input_json_delta carry nothing the log needs
  }
  return '' // content_block_stop, message_delta, message_stop
}

function renderObject(obj: any, state: { model: string }): string {
  const type: unknown = obj?.type
  if (type === 'stream_event') return renderStreamEvent(obj.event, state)
  // The cumulative assistant snapshot replays the whole block the deltas already
  // streamed; the result echoes the final text too. Skip both — but harvest the
  // model/usage so the ledger still gets cost.
  if (type === 'assistant') {
    const m = pickModel(obj?.message?.model)
    if (m) state.model = m
    return ''
  }
  if (type === 'result') return usageLine(obj, state.model)
  if (type === 'system') {
    if (obj.subtype === 'init') {
      const m = pickModel(obj.model)
      if (m) state.model = m
    }
    return '' // hook_started/_response, status, thinking_tokens — all noise
  }
  return '' // user (tool-result echo), rate_limit_event, future types
}

export type ClaudeStreamDecoder = (chunk: string) => string

/**
 * Stateful decoder for one `claude -p` process's stdout. Call the returned
 * function with each raw chunk; it buffers partial lines across chunks and
 * returns the decoded human-readable text to append (may be '').
 */
export function createClaudeStreamDecoder(): ClaudeStreamDecoder {
  let buf = ''
  const state = { model: '' }
  return (chunk: string): string => {
    buf += chunk
    const segs = buf.split(/\r\n|\r|\n/)
    buf = segs.pop() ?? '' // last segment is incomplete until its newline arrives
    let out = ''
    for (const seg of segs) {
      const clean = stripChrome(seg).trim()
      if (!clean) continue
      let obj: unknown
      try {
        obj = JSON.parse(clean)
      } catch {
        continue // chrome / non-JSON line — ignore
      }
      out += renderObject(obj, state)
    }
    return out
  }
}

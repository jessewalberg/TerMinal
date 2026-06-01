import { test, expect, describe } from 'bun:test'
import { createClaudeStreamDecoder } from './claude-stream'

// Mirror of the regexes parseClaudeUsageFromOutput (ai-collectors.ts) keys on.
// Inlined rather than imported because ai-collectors transitively pulls in
// electron, which can't load under bun test. The integration is locked by these
// asserting the exact labels the parser scans for.
const RE = {
  input: /(?:input|prompt)\s*tokens?[:\s]+(\d[\d,]*)/i,
  output: /(?:output|completion)\s*tokens?[:\s]+(\d[\d,]*)/i,
  cache: /cache(?:d|\s*read)?[:\s]+(\d[\d,]*)/i,
  model: /model[:\s]+([\w\-.]+)/i,
}

// Event shapes below are captured verbatim from a real
// `claude -p … --output-format stream-json --verbose --include-partial-messages`
// run under script(1) (see claude-stream.ts header).

const sysInit = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8[1m]' })
const hook = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' })
const status = JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' })
const rateLimit = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })

const messageStart = JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_start', message: { model: 'claude-opus-4-8', role: 'assistant', content: [] } },
})
const textBlockStart = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
})
const delta = (text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
  })
const thinkingDelta = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
})
// The cumulative assistant snapshot claude emits AFTER the deltas — replays the
// whole block. Must be skipped or the text appends twice.
const assistantSnapshot = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
const toolUseStart = (name: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} },
    },
  })
const result = (usage: Record<string, number>, cost: number) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'final text',
    total_cost_usd: cost,
    usage,
  })

const feed = (decode: (s: string) => string, lines: string[]): string =>
  lines.map((l) => decode(l + '\n')).join('')

describe('createClaudeStreamDecoder', () => {
  test('streams text_delta chunks as they arrive', () => {
    const decode = createClaudeStreamDecoder()
    const out = feed(decode, [messageStart, textBlockStart, delta('Seven is '), delta('prime.')])
    expect(out).toBe('Seven is prime.')
  })

  test('skips the cumulative assistant snapshot so text is not duplicated', () => {
    const decode = createClaudeStreamDecoder()
    const out = feed(decode, [
      textBlockStart,
      delta('Seven is '),
      delta('prime.'),
      assistantSnapshot('Seven is prime.'),
    ])
    expect(out).toBe('Seven is prime.')
  })

  test('ignores system boot noise, status, thinking deltas, and rate-limit events', () => {
    const decode = createClaudeStreamDecoder()
    const out = feed(decode, [hook, sysInit, status, thinkingDelta, delta('hi'), rateLimit])
    expect(out).toBe('hi')
  })

  test('emits a breadcrumb when the assistant starts a tool call', () => {
    const decode = createClaudeStreamDecoder()
    const out = feed(decode, [toolUseStart('Bash'), delta('done')])
    expect(out).toBe('· Bash\ndone')
  })

  test('buffers a JSON object split across chunk boundaries', () => {
    const decode = createClaudeStreamDecoder()
    const line = delta('hello world')
    const a = decode(line.slice(0, 20))
    const b = decode(line.slice(20) + '\n')
    expect(a).toBe('')
    expect(b).toBe('hello world')
  })

  test('strips PTY chrome (leading ^D/backspaces, CR line endings, trailing ANSI)', () => {
    const decode = createClaudeStreamDecoder()
    // script(1) prefixes the first line with ^D^H^H and uses \r\n endings.
    const out = decode('\x04\x08\x08' + delta('x') + '\r\n' + delta('y') + '\r\n\x1b[?25h')
    expect(out).toBe('xy')
  })

  test('emits a usage summary line the cost parser can read', () => {
    const decode = createClaudeStreamDecoder()
    feed(decode, [messageStart]) // captures the model
    const line = decode(
      result(
        { input_tokens: 10732, output_tokens: 182, cache_read_input_tokens: 31864 },
        0.25736,
      ) + '\n',
    )
    expect(line.match(RE.input)?.[1]).toBe('10732')
    expect(line.match(RE.output)?.[1]).toBe('182')
    expect(line.match(RE.cache)?.[1]).toBe('31864')
    expect(line.match(RE.model)?.[1]).toBe('claude-opus-4-8')
    expect(line).toContain('$0.26')
  })

  test('does not echo the cumulative result text (already streamed via deltas)', () => {
    const decode = createClaudeStreamDecoder()
    const out = feed(decode, [delta('final text'), result({ input_tokens: 1, output_tokens: 1 }, 0.01)])
    expect(out.match(/final text/g)).toHaveLength(1)
  })
})

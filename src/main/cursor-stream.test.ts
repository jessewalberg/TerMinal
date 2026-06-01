import { test, expect, describe } from 'bun:test'
import { createCursorStreamDecoder } from './cursor-stream'

// Event shapes captured from a real `cursor-agent -p … --output-format
// stream-json --stream-partial-output` run (see cursor-stream.ts header for the
// raw probe). The decoder turns that NDJSON back into the plain text a human
// (and the run log) wants, so cursor runs stream live like claude/codex.
const asst = (text: string, ts?: number) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...(ts ? { timestamp_ms: ts } : {}),
  })

describe('createCursorStreamDecoder', () => {
  test('renders incremental assistant deltas (events that carry timestamp_ms)', () => {
    const d = createCursorStreamDecoder()
    expect(d(asst('The', 1) + '\n')).toBe('The')
    expect(d(asst(' quick', 2) + '\n')).toBe(' quick')
  })

  test('skips the cumulative final assistant snapshot (no timestamp_ms)', () => {
    // cursor emits one trailing assistant event WITHOUT timestamp_ms that
    // repeats the whole message — rendering it would double the text.
    const d = createCursorStreamDecoder()
    expect(d(asst('The quick brown fox') + '\n')).toBe('')
  })

  test('skips result, user, and system events (duplicate/echo/noise)', () => {
    const d = createCursorStreamDecoder()
    expect(d(JSON.stringify({ type: 'result', subtype: 'success', result: 'hi' }) + '\n')).toBe('')
    expect(
      d(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }) + '\n'),
    ).toBe('')
    expect(d(JSON.stringify({ type: 'system', subtype: 'init', model: 'Composer 2.5' }) + '\n')).toBe('')
  })

  test('skips thinking deltas (kept out of the log to avoid reasoning spam)', () => {
    const d = createCursorStreamDecoder()
    expect(d(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'hmm' }) + '\n')).toBe('')
  })

  test('renders Cursor tool_call events with tool name and useful args/result details', () => {
    const d = createCursorStreamDecoder()
    expect(
      d(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'toolu_1',
          tool_call: {
            writeToolCall: {
              args: { path: 'summary.txt', fileText: '# README Summary\n\n...', toolCallId: 'toolu_1' },
            },
          },
        }) + '\n',
      ),
    ).toBe('· write summary.txt\n')
    expect(
      d(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'toolu_1',
          tool_call: {
            writeToolCall: {
              args: { path: 'summary.txt', toolCallId: 'toolu_1' },
              result: { success: { path: '/repo/summary.txt', linesCreated: 19, fileSize: 942 } },
            },
          },
        }) + '\n',
      ),
    ).toBe('· write completed /repo/summary.txt (19 lines, 942 B)\n')
  })

  test('uses the started tool call context when completed events omit args', () => {
    const d = createCursorStreamDecoder()
    expect(
      d(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'toolu_2',
          tool_call: { shellToolCall: { args: { command: 'bun test src/main/rerun.test.ts' } } },
        }) + '\n',
      ),
    ).toBe('· shell bun test src/main/rerun.test.ts\n')
    expect(
      d(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'toolu_2',
          tool_call: { shellToolCall: { result: { success: { exitCode: 0 } } } },
        }) + '\n',
      ),
    ).toBe('· shell completed bun test src/main/rerun.test.ts (exit 0)\n')
  })

  test('breadcrumbs unknown top-level event types so tool activity shows progress', () => {
    const d = createCursorStreamDecoder()
    expect(d(JSON.stringify({ type: 'connection', subtype: 'reconnecting' }) + '\n')).toBe(
      '· connection:reconnecting\n',
    )
  })

  test('breadcrumbs non-text assistant content parts (e.g. tool_use) but still emits text parts', () => {
    const d = createCursorStreamDecoder()
    const ev = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'run ' }, { type: 'tool_use', name: 'bash' }] },
      timestamp_ms: 5,
    })
    expect(d(ev + '\n')).toBe('run · tool_use bash\n')
  })

  test('concatenates multiple complete events in one chunk, in order', () => {
    const d = createCursorStreamDecoder()
    expect(d([asst('a', 1), asst('b', 2), asst('c', 3)].join('\n') + '\n')).toBe('abc')
  })

  test('reassembles a JSON event split across two pushes', () => {
    const d = createCursorStreamDecoder()
    const line = asst('fox', 9)
    const cut = line.length - 5
    expect(d(line.slice(0, cut))).toBe('') // incomplete: no newline yet
    expect(d(line.slice(cut) + '\n')).toBe('fox')
  })

  test('strips PTY chrome: leading ^D^H^H, CR line endings, trailing show-cursor ANSI', () => {
    const d = createCursorStreamDecoder()
    // mirrors what script(1) wraps around the NDJSON on a pseudo-TTY
    const chunk = '\x04\x08\x08' + asst('hi', 1) + '\r\n' + '\x1b[?25h\n'
    expect(d(chunk)).toBe('hi')
  })

  test('ignores pure-chrome / non-JSON / blank lines', () => {
    const d = createCursorStreamDecoder()
    expect(d('\x04\x08\x08\r\n')).toBe('')
    expect(d('not json at all\n')).toBe('')
    expect(d('\n\n')).toBe('')
  })
})

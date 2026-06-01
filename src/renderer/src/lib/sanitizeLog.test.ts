import { describe, it, expect } from 'bun:test'
import { sanitizeLog } from './sanitizeLog'

describe('sanitizeLog', () => {
  it('strips ANSI CSI color codes', () => {
    expect(sanitizeLog('\x1b[31mred\x1b[0m text')).toBe('red text')
  })

  it('strips ANSI OSC window-title sequences', () => {
    expect(sanitizeLog('\x1b]0;window\x07after')).toBe('after')
    expect(sanitizeLog('\x1b]2;title\x1b\\after')).toBe('after')
  })

  it('removes EOT (^D) and other lone C0 control chars but keeps tabs/newlines', () => {
    const input = '\x04**Tickets filed:** none\n\twith\ttabs'
    expect(sanitizeLog(input)).toBe('**Tickets filed:** none\n\twith\ttabs')
  })

  it('strips DEL, BEL, NUL', () => {
    expect(sanitizeLog('a\x00b\x07c\x7fd')).toBe('abcd')
  })

  it('collapses carriage-return progress overlays to the final state', () => {
    // simulates "10% ... 50% ... 100%" rendered as one line
    expect(sanitizeLog('10%\r50%\r100% done')).toBe('100% done')
  })

  it('keeps multi-line content intact across \\n while collapsing \\r within each line', () => {
    expect(sanitizeLog('line1 first\rline1 final\nline2 first\rline2 final')).toBe(
      'line1 final\nline2 final',
    )
  })

  it('preserves CRLF-terminated lines instead of collapsing them to blank', () => {
    // Real claude/codex PTY output ends lines with \r\n. The \r must NOT be
    // treated as an in-line overwrite that wipes the line to empty.
    expect(sanitizeLog('line one\r\nline two\r\nline three')).toBe('line one\nline two\nline three')
  })

  it('keeps a CRLF body intact (regression: Runs pane rendered blank)', () => {
    const body = '## Tickets filed (10)\r\n\r\n| 0001 | Brief dead-end |\r\nDecision impact:\r\n'
    expect(sanitizeLog(body)).toBe('## Tickets filed (10)\n\n| 0001 | Brief dead-end |\nDecision impact:\n')
  })

  it('still collapses a bare-\\r progress overlay even when CRLF lines surround it', () => {
    expect(sanitizeLog('start\r\n10%\r50%\r100% done\r\nend')).toBe('start\n100% done\nend')
  })

  it('strips private-marker / intermediate CSI sequences (ESC[>4m, ESC[<u, ESC[?25h)', () => {
    expect(sanitizeLog('\x1b[>4m\x1b[<u\x1b[?25hvisible')).toBe('visible')
  })

  it('passes plain text through untouched', () => {
    expect(sanitizeLog('hello world\nno escapes here')).toBe('hello world\nno escapes here')
  })

  it('handles empty / null-ish inputs', () => {
    expect(sanitizeLog('')).toBe('')
    expect(sanitizeLog(undefined as unknown as string)).toBe('')
  })

  it('strips misc single-char ANSI escapes (keypad, charset)', () => {
    expect(sanitizeLog('a\x1b=b\x1b>c\x1b(Bd')).toBe('abcd')
  })
})

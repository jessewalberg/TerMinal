import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const claudeProjects = join(homedir(), '.claude', 'projects')
const codexSessions = join(homedir(), '.codex', 'sessions')
const testDirs: string[] = []

mock.module('electron', () => ({
  Notification: class {
    static isSupported() {
      return false
    }
    show() {}
  },
}))

const { detectWedgedSessions } = await import('./wedged-session-detector')

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('detectWedgedSessions', () => {
  test('ignores repeated read-before-write edit errors when each one recovers', () => {
    const sessionId = `terminal-recovered-${Date.now()}`
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'fix the files'),
      ...recoveredReadBeforeWrite('2026-06-01T02:39:40.000Z', 'a', '/tmp/repo/tests/one.test.ts'),
      ...recoveredReadBeforeWrite('2026-06-01T02:41:50.000Z', 'b', '/tmp/repo/src/persona.ts'),
      ...recoveredReadBeforeWrite('2026-06-01T02:45:31.000Z', 'c', '/tmp/repo/docs/INDEX.md'),
      ...recoveredReadBeforeWrite('2026-06-01T02:45:58.000Z', 'd', '/tmp/repo/docs/BACKLOG.md'),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === sessionId)

    expect(wedged).toEqual([])
  })

  test('still reports repeated read-before-write edit errors when they do not recover', () => {
    const sessionId = `terminal-unrecovered-${Date.now()}`
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'fix the files'),
      ...unrecoveredReadBeforeWrite('2026-06-01T02:39:40.000Z', 'a', '/tmp/repo/tests/one.test.ts'),
      ...unrecoveredReadBeforeWrite('2026-06-01T02:41:50.000Z', 'b', '/tmp/repo/src/persona.ts'),
      ...unrecoveredReadBeforeWrite('2026-06-01T02:45:31.000Z', 'c', '/tmp/repo/docs/INDEX.md'),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === sessionId)

    expect(wedged).toHaveLength(1)
    expect(wedged[0].repeats).toBe(3)
    expect(wedged[0].preview).toBe('<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>')
  })
})

describe('detectWedgedSessions — codex sessions', () => {
  test('flags a codex session repeating the same function_call_output error', () => {
    const id = `codex-wedged-${Date.now()}`
    writeCodexSession([
      codexMeta('2026-06-01T02:39:00.000Z', id, '/tmp/codexrepo'),
      codexFnOutput('2026-06-01T02:39:30.000Z', 'a', codexErrOutput()),
      codexFnOutput('2026-06-01T02:41:00.000Z', 'b', codexErrOutput()),
      codexFnOutput('2026-06-01T02:43:00.000Z', 'c', codexErrOutput()),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === id)

    expect(wedged).toHaveLength(1)
    expect(wedged[0].repeats).toBe(3)
    expect(wedged[0].engine).toBe('codex')
    expect(wedged[0].cwd).toBe('/tmp/codexrepo')
  })

  test('ignores a codex session whose outputs are clean', () => {
    const id = `codex-clean-${Date.now()}`
    const ok = 'Wall time: 0.10 seconds\nOutput:\nok'
    writeCodexSession([
      codexMeta('2026-06-01T02:39:00.000Z', id, '/tmp/codexrepo'),
      codexFnOutput('2026-06-01T02:39:30.000Z', 'a', ok),
      codexFnOutput('2026-06-01T02:41:00.000Z', 'b', ok),
      codexFnOutput('2026-06-01T02:43:00.000Z', 'c', ok),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === id)).toEqual([])
  })

  test('ignores repeated code-0 outputs even when the body looks error-shaped', () => {
    const id = `codex-code0-${Date.now()}`
    // Real codex envelope: "Process exited with code 0" = success, even if the
    // output body starts with "error" / contains failure words (#7 follow-up).
    const ok =
      'Chunk ID: abc\nWall time: 0.10 seconds\nProcess exited with code 0\nOutput:\nerror handlers registered successfully'
    writeCodexSession([
      codexMeta('2026-06-01T02:39:00.000Z', id, '/tmp/codexrepo'),
      codexFnOutput('2026-06-01T02:39:30.000Z', 'a', ok),
      codexFnOutput('2026-06-01T02:41:00.000Z', 'b', ok),
      codexFnOutput('2026-06-01T02:43:00.000Z', 'c', ok),
    ])
    expect(detectWedgedSessions().filter((w) => w.sessionId === id)).toEqual([])
  })

  test('flags repeated NON-zero exit outputs (envelope says failure)', () => {
    const id = `codex-nonzero-${Date.now()}`
    const bad = 'Wall time: 0.10 seconds\nProcess exited with code 1\nOutput:\nboom'
    writeCodexSession([
      codexMeta('2026-06-01T02:39:00.000Z', id, '/tmp/codexrepo'),
      codexFnOutput('2026-06-01T02:39:30.000Z', 'a', bad),
      codexFnOutput('2026-06-01T02:41:00.000Z', 'b', bad),
      codexFnOutput('2026-06-01T02:43:00.000Z', 'c', bad),
    ])
    expect(detectWedgedSessions().filter((w) => w.sessionId === id)).toHaveLength(1)
  })

  test('ignores repeated SUCCESS outputs that merely mention the word error', () => {
    const id = `codex-success-error-word-${Date.now()}`
    // A successful tool result that happens to contain "error" in prose — must
    // NOT be mistaken for a repeated failure (#7 review finding).
    const ok = 'Wall time: 0.10 seconds\nOutput:\nAll 5 error handlers registered successfully'
    writeCodexSession([
      codexMeta('2026-06-01T02:39:00.000Z', id, '/tmp/codexrepo'),
      codexFnOutput('2026-06-01T02:39:30.000Z', 'a', ok),
      codexFnOutput('2026-06-01T02:41:00.000Z', 'b', ok),
      codexFnOutput('2026-06-01T02:43:00.000Z', 'c', ok),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === id)).toEqual([])
  })
})

function writeCodexSession(rows: unknown[]) {
  if (!existsSync(codexSessions)) mkdirSync(codexSessions, { recursive: true })
  const dir = mkdtempSync(join(codexSessions, '-terminal-wedged-codex-test-'))
  testDirs.push(dir)
  writeFileSync(join(dir, `rollout-test-${Date.now()}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'))
}

function codexMeta(timestamp: string, id: string, cwd: string) {
  return { type: 'session_meta', timestamp, payload: { id, cwd } }
}

function codexFnOutput(timestamp: string, callId: string, output: string) {
  return { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: callId, output } }
}

// Mirrors a real codex tool error: a "Wall time / Output:" preamble wrapping an
// embedded JSON error payload.
function codexErrOutput() {
  return 'Wall time: 0.33 seconds\nOutput:\n[{"type":"text","text":"{\"error\":\"invalid_request\",\"message\":\"Invalid request.\",\"status\":400}"}]'
}

function writeClaudeSession(sessionId: string, rows: unknown[]) {
  if (!existsSync(claudeProjects)) mkdirSync(claudeProjects, { recursive: true })
  const projectDir = mkdtempSync(join(claudeProjects, '-terminal-wedged-detector-test-'))
  testDirs.push(projectDir)
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'))
}

function recoveredReadBeforeWrite(start: string, suffix: string, filePath: string) {
  return [
    toolUse(start, `edit-${suffix}`, 'Edit', filePath),
    toolResult(offset(start, 1), `edit-${suffix}`, readBeforeWriteError(), true),
    toolUse(offset(start, 2), `read-${suffix}`, 'Read', filePath),
    toolResult(offset(start, 3), `read-${suffix}`, '1\tcontents', false),
    toolUse(offset(start, 4), `retry-${suffix}`, 'Edit', filePath),
    toolResult(offset(start, 5), `retry-${suffix}`, 'The file has been updated successfully.', false),
  ]
}

function unrecoveredReadBeforeWrite(start: string, suffix: string, filePath: string) {
  return [toolUse(start, `edit-${suffix}`, 'Edit', filePath), toolResult(offset(start, 1), `edit-${suffix}`, readBeforeWriteError(), true)]
}

function userMessage(timestamp: string, content: string) {
  return base(timestamp, {
    type: 'user',
    message: { role: 'user', content },
  })
}

function toolUse(timestamp: string, id: string, name: string, filePath: string) {
  return base(timestamp, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: { file_path: filePath } }],
    },
  })
}

function toolResult(timestamp: string, toolUseId: string, content: string, isError: boolean) {
  return base(timestamp, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content, is_error: isError, tool_use_id: toolUseId }],
    },
  })
}

function base(timestamp: string, row: Record<string, unknown>) {
  return {
    ...row,
    timestamp,
    cwd: '/tmp/repo',
  }
}

function readBeforeWriteError() {
  return '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>'
}

function offset(timestamp: string, seconds: number) {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString()
}

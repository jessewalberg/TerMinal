import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const claudeProjects = join(homedir(), '.claude', 'projects')
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

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

  test('still reports unrecovered read-before-write errors once the recovery window has elapsed', () => {
    const sessionId = `terminal-unrecovered-${Date.now()}`
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'fix the files'),
      ...unrecoveredReadBeforeWrite('2026-06-01T02:39:40.000Z', 'a', '/tmp/repo/tests/one.test.ts'),
      ...unrecoveredReadBeforeWrite('2026-06-01T02:41:50.000Z', 'b', '/tmp/repo/src/persona.ts'),
      ...unrecoveredReadBeforeWrite('2026-06-01T02:45:31.000Z', 'c', '/tmp/repo/docs/INDEX.md'),
      // a later, unrelated failure proves the burst never recovered (its 2-min
      // recovery window has elapsed in the captured data, so it is no longer deferred).
      bashUse('2026-06-01T02:48:00.000Z', 'tail', 'bun run typecheck'),
      toolResult('2026-06-01T02:48:01.000Z', 'tail', 'Exit code 2\nsome unrelated type error', true),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === sessionId)

    expect(wedged).toHaveLength(1)
    expect(wedged[0].repeats).toBe(3)
    expect(wedged[0].preview).toBe('<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>')
  })

  test('ignores repeated modified-since-read edit errors when each one recovers', () => {
    const sessionId = `terminal-modified-recovered-${Date.now()}`
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'fix the files'),
      ...recoveredModifiedSinceRead('2026-06-01T02:39:40.000Z', 'a', '/tmp/repo/src/settings.ts'),
      ...recoveredModifiedSinceRead('2026-06-01T02:40:10.000Z', 'b', '/tmp/repo/src/settings.ts'),
      ...recoveredModifiedSinceRead('2026-06-01T02:40:40.000Z', 'c', '/tmp/repo/src/preload.ts'),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === sessionId)

    expect(wedged).toEqual([])
  })

  test('ignores repeated parallel-tool cancellation envelopes', () => {
    const sessionId = `terminal-parallel-cancel-${Date.now()}`
    const cancelled =
      '<tool_use_error>Cancelled: parallel tool call Bash(cd "$HOME/.worktrees/repo" && bun test) errored</tool_use_error>'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'run parallel checks'),
      toolUse('2026-06-01T02:39:40.000Z', 'a', 'Bash', '/tmp/repo'),
      toolResult('2026-06-01T02:39:41.000Z', 'a', cancelled, true),
      toolUse('2026-06-01T02:39:42.000Z', 'b', 'Bash', '/tmp/repo'),
      toolResult('2026-06-01T02:39:43.000Z', 'b', cancelled, true),
      toolUse('2026-06-01T02:39:44.000Z', 'c', 'Bash', '/tmp/repo'),
      toolResult('2026-06-01T02:39:45.000Z', 'c', cancelled, true),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === sessionId)

    expect(wedged).toEqual([])
  })
})

describe('detectWedgedSessions — false-positive hardening', () => {
  const T = '2026-06-01T02:39:40.000Z'

  // F-1: Claude's Bash tool always leads a non-zero exit with the literal line
  // "Exit code N". Three UNRELATED commands that each exit non-zero must not
  // collapse into one "wedge" — the signature must key on the real error + command.
  test('does not wedge on unrelated Bash failures that share the "Exit code 1" banner', () => {
    const sessionId = `exit-code-collision-${Date.now()}`
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'do repo housekeeping'),
      bashUse(T, 'a', 'git merge-base main feat/x'),
      toolResult(offset(T, 1), 'a', 'Exit code 1\n=== mine/main log ===\n1663cf2 stuff', true),
      bashUse(offset(T, 2), 'b', 'gh pr create --head feat/planning'),
      toolResult(offset(T, 3), 'b', 'Exit code 1\npull request create failed: GraphQL: No commits between main and feat/planning', true),
      bashUse(offset(T, 4), 'c', 'gh pr create --head feat/demo'),
      toolResult(offset(T, 5), 'c', 'Exit code 1\na pull request for branch "feat/demo" already exists', true),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toEqual([])
  })

  // F-1 positive control: the SAME command failing the SAME way is a real wedge.
  test('wedges when the same command fails the same way repeatedly', () => {
    const sessionId = `same-command-${Date.now()}`
    const cmd = 'bun test src/foo.test.ts'
    const res = 'Exit code 1\nTypeError: cannot read properties of undefined (reading x)'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'fix the test'),
      bashUse(T, 'a', cmd),
      toolResult(offset(T, 1), 'a', res, true),
      bashUse(offset(T, 2), 'b', cmd),
      toolResult(offset(T, 3), 'b', res, true),
      bashUse(offset(T, 4), 'c', cmd),
      toolResult(offset(T, 5), 'c', res, true),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === sessionId)
    expect(wedged).toHaveLength(1)
    expect(wedged[0].repeats).toBe(3)
    expect(wedged[0].preview).toContain('TypeError: cannot read properties of undefined')
  })

  // F-2: a SUCCESSFUL tool result (is_error=false) whose body merely contains
  // "error"/"failed" must not be counted as a failure.
  test('does not count successful tool results that merely mention error words', () => {
    const sessionId = `success-error-word-${Date.now()}`
    const body = 'All 5 error handlers registered; 0 failed'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'check'),
      bashUse(T, 'a', 'npm run check'),
      toolResult(offset(T, 1), 'a', body, false),
      bashUse(offset(T, 2), 'b', 'npm run check'),
      toolResult(offset(T, 3), 'b', body, false),
      bashUse(offset(T, 4), 'c', 'npm run check'),
      toolResult(offset(T, 5), 'c', body, false),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toEqual([])
  })

  // F-3: transient infra failures (HTTP 429 / rate limits) are not wedges — the
  // agent backs off and pivots. Retrying cannot un-stick them.
  test('does not wedge on repeated transient rate-limit failures', () => {
    const sessionId = `rate-limit-${Date.now()}`
    const body = 'Exit code 22\n{"error":{"code":429,"message":"Too many requests from your IP"}}'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'fetch on-chain data'),
      bashUse(T, 'a', 'curl --fail https://api.example.com/x'),
      toolResult(offset(T, 1), 'a', body, true),
      bashUse(offset(T, 2), 'b', 'curl --fail https://api.example.com/x'),
      toolResult(offset(T, 3), 'b', body, true),
      bashUse(offset(T, 4), 'c', 'curl --fail https://api.example.com/x'),
      toolResult(offset(T, 5), 'c', body, true),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toEqual([])
  })

  // F-3: deterministic config/transport failures (MCP "no repo matching") are not
  // wedges either — the agent self-diagnoses and routes around them.
  test('does not wedge on repeated deterministic config errors', () => {
    const sessionId = `mcp-config-${Date.now()}`
    const body = 'MCP error -32603: no repo matching "nerdletters"'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'file tickets'),
      toolUse(T, 'a', 'mcp__terminal-harness__file_ticket', '/tmp/repo'),
      toolResult(offset(T, 1), 'a', body, true),
      toolUse(offset(T, 2), 'b', 'mcp__terminal-harness__file_ticket', '/tmp/repo'),
      toolResult(offset(T, 3), 'b', body, true),
      toolUse(offset(T, 4), 'c', 'mcp__terminal-harness__file_ticket', '/tmp/repo'),
      toolResult(offset(T, 5), 'c', body, true),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toEqual([])
  })

  // F-4: report the qualifying sub-window, not the whole bucket span.
  test('reports the qualifying sub-window rather than the whole bucket', () => {
    const sessionId = `subwindow-${Date.now()}`
    const cmd = 'bun test'
    const res = 'Exit code 1\nassertion failed: expected 2 to equal 3'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'tdd'),
      bashUse(T, 'a', cmd),
      toolResult(offset(T, 1), 'a', res, true),
      bashUse(offset(T, 10), 'b', cmd),
      toolResult(offset(T, 11), 'b', res, true),
      bashUse(offset(T, 20), 'c', cmd),
      toolResult(offset(T, 21), 'c', res, true),
      // a 4th occurrence far outside the 10-min window — must NOT inflate the report
      bashUse(offset(T, 800), 'd', cmd),
      toolResult(offset(T, 801), 'd', res, true),
    ])

    const wedged = detectWedgedSessions().filter((w) => w.sessionId === sessionId)
    expect(wedged).toHaveLength(1)
    expect(wedged[0].repeats).toBe(3)
    expect(wedged[0].windowMs).toBeLessThan(60_000)
  })

  // F-5: an edit-conflict burst whose recovery has not yet been written to the
  // transcript (scan lands in the gap, < RECOVERY_WINDOW_MS after the errors)
  // must be DEFERRED, not flagged. Inject a scan time just after the burst.
  test('defers an edit-conflict burst whose recovery window has not elapsed', () => {
    const sessionId = `defer-fresh-${Date.now()}`
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'edit'),
      ...unrecoveredReadBeforeWrite(T, 'a', '/tmp/repo/a.ts'),
      ...unrecoveredReadBeforeWrite(offset(T, 30), 'b', '/tmp/repo/b.ts'),
      ...unrecoveredReadBeforeWrite(offset(T, 60), 'c', '/tmp/repo/c.ts'),
    ])

    const now = Date.parse('2026-06-01T02:40:50.000Z') // < 120s after each error
    expect(detectWedgedSessions(now).filter((w) => w.sessionId === sessionId)).toEqual([])
  })

  // F-5 / review finding #3: a transcript that ENDS on the edit-conflict burst
  // (no later tool event ever arrives) must still be detected once real time
  // passes the recovery window — not deferred forever against a frozen tail.
  test('detects an unrecovered edit-conflict tail after the window with no later tool event', () => {
    const sessionId = `unrecovered-frozen-${Date.now()}`
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'edit'),
      ...unrecoveredReadBeforeWrite(T, 'a', '/tmp/repo/a.ts'),
      ...unrecoveredReadBeforeWrite(offset(T, 10), 'b', '/tmp/repo/b.ts'),
      ...unrecoveredReadBeforeWrite(offset(T, 20), 'c', '/tmp/repo/c.ts'),
    ])

    const now = Date.parse('2026-06-01T02:45:00.000Z') // > 120s after the last error
    const wedged = detectWedgedSessions(now).filter((w) => w.sessionId === sessionId)
    expect(wedged).toHaveLength(1)
    expect(wedged[0].repeats).toBe(3)
  })

  // Review finding #1: ALL HTTP 5xx (not just 502-504) are transient, not wedges.
  test('does not wedge on repeated HTTP 5xx failures (500/501)', () => {
    for (const code of [500, 501]) {
      const sessionId = `http-${code}-${Date.now()}`
      const body = `Exit code 22\n{"error":{"code":${code},"message":"server error"}}`
      writeClaudeSession(sessionId, [
        userMessage('2026-06-01T02:39:00.000Z', 'deploy'),
        bashUse(T, 'a', 'curl --fail https://api.example.com/deploy'),
        toolResult(offset(T, 1), 'a', body, true),
        bashUse(offset(T, 2), 'b', 'curl --fail https://api.example.com/deploy'),
        toolResult(offset(T, 3), 'b', body, true),
        bashUse(offset(T, 4), 'c', 'curl --fail https://api.example.com/deploy'),
        toolResult(offset(T, 5), 'c', body, true),
      ])
      expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toEqual([])
    }
  })

  // F-6: a session that made successful progress after the repeated error is not
  // wedged — the failure is no longer the latest activity.
  test('does not wedge when the session made successful progress after the errors', () => {
    const sessionId = `progressed-${Date.now()}`
    const cmd = 'bun test'
    const res = 'Exit code 1\nassertion failed'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'tdd'),
      bashUse(T, 'a', cmd),
      toolResult(offset(T, 1), 'a', res, true),
      bashUse(offset(T, 2), 'b', cmd),
      toolResult(offset(T, 3), 'b', res, true),
      bashUse(offset(T, 4), 'c', cmd),
      toolResult(offset(T, 5), 'c', res, true),
      bashUse(offset(T, 6), 'd', cmd),
      toolResult(offset(T, 7), 'd', 'All tests passed', false),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toEqual([])
  })

  // F-7: an attended session (human typed after the errors) is not flagged — a
  // human is already on it. The same burst with no human follow-up still fires.
  test('does not wedge an attended session where the human responded after the errors', () => {
    const sessionId = `attended-${Date.now()}`
    const cmd = 'bun test'
    const res = 'Exit code 1\nassertion failed'
    writeClaudeSession(sessionId, [
      bashUse(T, 'a', cmd),
      toolResult(offset(T, 1), 'a', res, true),
      bashUse(offset(T, 2), 'b', cmd),
      toolResult(offset(T, 3), 'b', res, true),
      bashUse(offset(T, 4), 'c', cmd),
      toolResult(offset(T, 5), 'c', res, true),
      userMessage(offset(T, 30), 'hold on, let me look at this'),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toEqual([])
  })

  test('still wedges an unattended burst where human input only precedes the errors', () => {
    const sessionId = `unattended-${Date.now()}`
    const cmd = 'bun test'
    const res = 'Exit code 1\nassertion failed'
    writeClaudeSession(sessionId, [
      userMessage('2026-06-01T02:39:00.000Z', 'go fix it and let me know'),
      bashUse(T, 'a', cmd),
      toolResult(offset(T, 1), 'a', res, true),
      bashUse(offset(T, 2), 'b', cmd),
      toolResult(offset(T, 3), 'b', res, true),
      bashUse(offset(T, 4), 'c', cmd),
      toolResult(offset(T, 5), 'c', res, true),
      // a later unrelated failure so the cluster is confirmed (not deferred) and
      // there is no successful progress after it
      bashUse(offset(T, 200), 'd', 'bun run lint'),
      toolResult(offset(T, 201), 'd', 'Exit code 1\nlint failed somewhere else', true),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === sessionId)).toHaveLength(1)
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

  // Review finding #2: attended-session suppression must apply to Codex too. A
  // human user_message after the repeated errors means someone is on it.
  test('does not wedge an attended codex session (user message after errors)', () => {
    const id = `codex-attended-${Date.now()}`
    writeCodexSession([
      codexMeta('2026-06-01T02:39:00.000Z', id, '/tmp/codexrepo'),
      codexFnOutput('2026-06-01T02:39:30.000Z', 'a', codexErrOutput()),
      codexFnOutput('2026-06-01T02:41:00.000Z', 'b', codexErrOutput()),
      codexFnOutput('2026-06-01T02:43:00.000Z', 'c', codexErrOutput()),
      codexUserMessage('2026-06-01T02:43:30.000Z', 'wait, let me check that'),
    ])

    expect(detectWedgedSessions().filter((w) => w.sessionId === id)).toEqual([])
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

function codexUserMessage(timestamp: string, message: string) {
  return { type: 'event_msg', timestamp, payload: { type: 'user_message', message } }
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

function recoveredModifiedSinceRead(start: string, suffix: string, filePath: string) {
  return [
    toolUse(start, `edit-${suffix}`, 'Edit', filePath),
    toolResult(offset(start, 1), `edit-${suffix}`, modifiedSinceReadError(), true),
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

function bashUse(timestamp: string, id: string, command: string) {
  return base(timestamp, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
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

function modifiedSinceReadError() {
  return '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>'
}

function offset(timestamp: string, seconds: number) {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString()
}

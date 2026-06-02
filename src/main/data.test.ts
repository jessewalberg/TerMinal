import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextLimitFor, parseCodexSessionFile, parseCursorMeta, turnStateFromLines } from './data'

describe('turnStateFromLines (fleet "needs-me" detection)', () => {
  const asst = (stop: string, content: unknown) =>
    JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: stop, content } })
  const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })

  test('end_turn with plain text → idle (done, not awaiting)', () => {
    expect(turnStateFromLines([asst('end_turn', [{ type: 'text', text: 'Done.' }])])).toEqual({
      id: 'm1',
      endTurn: true,
      awaiting: false,
    })
  })

  test('end_turn ending in a question → awaiting (clarifying)', () => {
    const r = turnStateFromLines([asst('end_turn', [{ type: 'text', text: 'Which file should I edit?' }])])
    expect(r?.endTurn).toBe(true)
    expect(r?.awaiting).toBe(true)
  })

  test('trailing tool_use with no tool_result → awaiting (permission gate)', () => {
    expect(turnStateFromLines([asst('tool_use', [{ type: 'tool_use', name: 'Bash' }])])).toEqual({
      id: 'm1',
      endTurn: false,
      awaiting: true,
    })
  })

  test('tool_use followed by a tool_result → working (not awaiting)', () => {
    const r = turnStateFromLines([asst('tool_use', [{ type: 'tool_use' }]), toolResult])
    expect(r?.awaiting).toBe(false)
    expect(r?.endTurn).toBe(false)
  })

  test('no assistant line → null', () => {
    expect(turnStateFromLines([toolResult])).toBeNull()
  })
})

describe('parseCursorMeta', () => {
  test('extracts title/model/mode from a cursor chat meta row', () => {
    const row = JSON.stringify({
      agentId: 'e7b3c16e',
      latestRootBlobId: '3f61',
      name: 'Ghosty Terminal Naming',
      mode: 'default',
      isRunEverything: true,
      createdAt: 1780152395269,
      lastUsedModel: 'composer-2.5',
    })
    expect(parseCursorMeta(row)).toEqual({
      agentId: 'e7b3c16e',
      name: 'Ghosty Terminal Naming',
      model: 'composer-2.5',
      mode: 'default',
      isRunEverything: true,
      createdAt: 1780152395269,
    })
  })

  test('tolerates missing fields without throwing', () => {
    const m = parseCursorMeta('{}')
    expect(m).toEqual({ agentId: '', name: '', model: '', mode: '', isRunEverything: false, createdAt: 0 })
  })

  test('returns null on non-JSON / garbage', () => {
    expect(parseCursorMeta('not json')).toBeNull()
    expect(parseCursorMeta('')).toBeNull()
  })
})

describe('contextLimitFor (context-window cap)', () => {
  test('opus 4.8 (a 1M model) maps to the 1M window, not the 200k default', () => {
    expect(contextLimitFor('claude-opus-4-8', 0)).toBe(1_000_000)
  })
  test('dated model ids resolve via prefix match', () => {
    expect(contextLimitFor('claude-opus-4-8-20260115', 0)).toBe(1_000_000)
  })
  test('sonnet 4.6 is 1M', () => {
    expect(contextLimitFor('claude-sonnet-4-6', 0)).toBe(1_000_000)
  })
  test('haiku stays at 200k', () => {
    expect(contextLimitFor('claude-haiku-4-5', 0)).toBe(200_000)
  })
  test('codex gpt-5 family is 400k', () => {
    expect(contextLimitFor('gpt-5-codex', 0)).toBe(400_000)
  })
  test('unknown model falls back to 200k', () => {
    expect(contextLimitFor('some-future-model', 0)).toBe(200_000)
  })
  test('self-corrects upward when usage exceeds the mapped window (never >100%)', () => {
    expect(contextLimitFor('claude-haiku-4-5', 250_000)).toBe(1_000_000)
  })
})

describe('parseCodexSessionFile', () => {
  test('extracts picker metadata from Codex JSONL sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'terminal-codex-session-'))
    const file = join(dir, 'rollout-2026-05-30T10-00-00-019e-test.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: '019e-test', cwd: '/tmp/repo' },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.5', cwd: '/tmp/repo' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'ship the feature' },
        }),
      ].join('\n'),
    )

    expect(parseCodexSessionFile(file)).toMatchObject({
      id: '019e-test',
      engine: 'codex',
      cwd: '/tmp/repo',
      model: 'gpt-5.5',
      turns: 1,
      firstUserText: 'ship the feature',
    })
  })
})

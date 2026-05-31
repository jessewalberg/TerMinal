import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodexSessionFile, parseCursorMeta, turnStateFromLines } from './data'

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

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodexSessionFile, parseCursorMeta } from './data'

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

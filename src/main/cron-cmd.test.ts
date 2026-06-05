import { test, expect, describe } from 'bun:test'
// Import the pure command-assembler from the self-contained cron runner. The
// script guards its entrypoint behind `import.meta.main`, so importing it here
// pulls in the helper without firing the launchd dispatch.
// @ts-expect-error — bin/terminal-cron is an untyped standalone Bun script
import { buildHeadlessCmd } from '../../bin/terminal-cron'

const WT = '/tmp/wt'
const PROMPT = 'do the thing'

describe('buildHeadlessCmd', () => {
  test('claude relies on spawn cwd (no -C / --workspace)', () => {
    const cmd = buildHeadlessCmd('claude', PROMPT, WT, '')
    expect(cmd).toBe(`claude -p 'do the thing' --dangerously-skip-permissions`)
  })

  test('codex passes -C <worktree> and the prompt last', () => {
    const cmd = buildHeadlessCmd('codex', PROMPT, WT, '')
    expect(cmd).toBe(`codex exec -s danger-full-access -C '/tmp/wt' 'do the thing'`)
  })

  test('cursor uses cursor-agent --force --workspace (NOT codex)', () => {
    const cmd = buildHeadlessCmd('cursor', PROMPT, WT, '')
    // Regression: previously fell through to the codex branch.
    expect(cmd).not.toContain('codex')
    expect(cmd).toBe(`cursor-agent -p 'do the thing' --force --workspace '/tmp/wt'`)
  })

  test('cursor does NOT add live-stream flags (cron logs to a file)', () => {
    const cmd = buildHeadlessCmd('cursor', PROMPT, WT, '')
    expect(cmd).not.toContain('--output-format')
    expect(cmd).not.toContain('--stream-partial-output')
  })

  test('model flag threads through every engine branch', () => {
    const mf = ` --model sonnet`
    expect(buildHeadlessCmd('claude', PROMPT, WT, mf)).toContain('--model sonnet')
    expect(buildHeadlessCmd('codex', PROMPT, WT, mf)).toContain('--model sonnet')
    expect(buildHeadlessCmd('cursor', PROMPT, WT, mf)).toContain('--model sonnet')
    // cursor: model flag lands before nothing trailing — appended after --workspace
    expect(buildHeadlessCmd('cursor', PROMPT, WT, mf)).toBe(
      `cursor-agent -p 'do the thing' --force --workspace '/tmp/wt' --model sonnet`,
    )
  })
})

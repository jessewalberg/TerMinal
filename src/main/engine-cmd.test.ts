import { test, expect, describe } from 'bun:test'
import { buildEngineCmd } from './engine-cmd'

// The resolved binary is injected so these assertions don't depend on the
// machine's settings.json (enginePath is the impure caller's concern).
describe('buildEngineCmd', () => {
  test('claude → headless -p with skip-permissions', () => {
    expect(buildEngineCmd('claude', 'claude', '/wt', 'do thing')).toBe(
      `claude -p 'do thing' --dangerously-skip-permissions`,
    )
  })

  test('codex → exec scoped to the worktree via -C', () => {
    expect(buildEngineCmd('codex', 'codex', '/wt', 'do thing')).toBe(
      `codex exec -s danger-full-access -C /wt 'do thing'`,
    )
  })

  test('cursor → headless print, run-everything, workspace = worktree, NDJSON stream', () => {
    // cursor's default --output-format text BUFFERS the whole turn and emits it
    // only on completion, so a live run shows nothing until the step ends (looks
    // hung). stream-json + --stream-partial-output makes it emit incremental
    // deltas the runtime decodes for live logs. See cursor-stream.ts.
    expect(buildEngineCmd('cursor-agent', 'cursor', '/wt', 'do thing')).toBe(
      `cursor-agent -p 'do thing' --force --workspace /wt --output-format stream-json --stream-partial-output`,
    )
  })

  test('a configured model is appended as --model for every engine', () => {
    expect(buildEngineCmd('cursor-agent', 'cursor', '/wt', 'x', 'composer-2.5')).toBe(
      `cursor-agent -p x --force --workspace /wt --model composer-2.5 --output-format stream-json --stream-partial-output`,
    )
    expect(buildEngineCmd('claude', 'claude', '/wt', 'x', 'opus')).toBe(
      `claude -p x --dangerously-skip-permissions --model opus`,
    )
    expect(buildEngineCmd('codex', 'codex', '/wt', 'x', 'gpt-5')).toBe(
      `codex exec -s danger-full-access -C /wt --model gpt-5 x`,
    )
  })

  test('prompts with quotes/spaces are shell-escaped', () => {
    expect(buildEngineCmd('cursor-agent', 'cursor', '/my work', "it's done")).toBe(
      `cursor-agent -p 'it'\\''s done' --force --workspace '/my work' --output-format stream-json --stream-partial-output`,
    )
  })
})

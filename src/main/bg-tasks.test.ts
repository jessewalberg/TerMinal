import { describe, expect, mock, test } from 'bun:test'

// bg-tasks.ts transitively imports electron (via ./hitl → ./events). Mock it so
// the pure argv builder is importable in a unit test — same convention as
// wedged-session-detector.test.ts.
mock.module('electron', () => ({
  Notification: class {
    static isSupported() {
      return false
    }
    show() {}
  },
}))

const { buildBgArgv } = await import('./bg-tasks')

// The resolved binary is injected so these assertions don't depend on the
// machine's settings.json (enginePath is the impure caller's concern). The
// model fallback (input.model || engineDefaultModel(engine)) is likewise
// resolved by the impure spawnBgTask caller and passed in here.
describe('buildBgArgv', () => {
  test('claude → headless -p with skip-permissions', () => {
    expect(buildBgArgv('claude', 'claude', 'do thing', '/wt')).toEqual([
      'claude',
      '-p',
      'do thing',
      '--dangerously-skip-permissions',
    ])
  })

  test('codex → exec scoped to the worktree via -C', () => {
    expect(buildBgArgv('codex', 'codex', 'do thing', '/wt')).toEqual([
      'codex',
      'exec',
      '-s',
      'danger-full-access',
      '-C',
      '/wt',
      'do thing',
    ])
  })

  test('cursor → headless print, run-everything, workspace = worktree', () => {
    expect(buildBgArgv('cursor-agent', 'cursor', 'do thing', '/wt')).toEqual([
      'cursor-agent',
      '-p',
      'do thing',
      '--force',
      '--workspace',
      '/wt',
    ])
  })

  test('an explicit model is appended as --model for every engine', () => {
    expect(buildBgArgv('claude', 'claude', 'x', '/wt', 'opus')).toEqual([
      'claude',
      '-p',
      'x',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
    ])
    expect(buildBgArgv('codex', 'codex', 'x', '/wt', 'gpt-5')).toEqual([
      'codex',
      'exec',
      '-s',
      'danger-full-access',
      '-C',
      '/wt',
      'x',
      '--model',
      'gpt-5',
    ])
    expect(buildBgArgv('cursor-agent', 'cursor', 'x', '/wt', 'composer-2.5')).toEqual([
      'cursor-agent',
      '-p',
      'x',
      '--force',
      '--workspace',
      '/wt',
      '--model',
      'composer-2.5',
    ])
  })

  test('the resolved settings default fills --model when caller passes it (unset input.model case)', () => {
    // spawnBgTask resolves `input.model || engineDefaultModel(engine)` and hands
    // the winner to buildBgArgv — so when the explicit model is unset but a
    // per-engine Settings default exists, that default reaches the argv here.
    expect(buildBgArgv('claude', 'claude', 'x', '/wt', 'sonnet')).toEqual([
      'claude',
      '-p',
      'x',
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
    ])
  })

  test('no --model when both explicit and resolved model are empty', () => {
    expect(buildBgArgv('claude', 'claude', 'x', '/wt')).toEqual([
      'claude',
      '-p',
      'x',
      '--dangerously-skip-permissions',
    ])
    expect(buildBgArgv('claude', 'claude', 'x', '/wt', undefined)).toEqual([
      'claude',
      '-p',
      'x',
      '--dangerously-skip-permissions',
    ])
    expect(buildBgArgv('claude', 'claude', 'x', '/wt', '')).toEqual([
      'claude',
      '-p',
      'x',
      '--dangerously-skip-permissions',
    ])
  })
})

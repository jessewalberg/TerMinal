import { describe, expect, test } from 'bun:test'
import { seedRunOutput, seedRunOutputs } from './agentRunOutputState'
import type { AgentRun } from '../../lib/types'

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentId: 'product-audit',
    agentTitle: 'Product audit',
    engine: 'claude',
    status: 'running',
    startedAt: 1_000,
    repoRoot: '/repo',
    worktree: '/repo/.worktrees/product-audit',
    branch: 'agent/product-audit',
    output: 'header\n',
    ...overrides,
  }
}

describe('agent run output state', () => {
  test('seeds a just-started run with the returned header output', () => {
    expect(seedRunOutput({}, run())).toEqual({ 'run-1': 'header\n' })
  })

  test('does not overwrite already streamed output', () => {
    expect(seedRunOutput({ 'run-1': 'header\npartial' }, run({ output: 'full log' }))).toEqual({
      'run-1': 'header\npartial',
    })
  })

  test('seeds missing outputs when restoring persisted runs', () => {
    expect(
      seedRunOutputs(
        { 'run-1': 'kept' },
        [run(), run({ id: 'run-2', output: 'second header\n' })],
      ),
    ).toEqual({
      'run-1': 'kept',
      'run-2': 'second header\n',
    })
  })
})

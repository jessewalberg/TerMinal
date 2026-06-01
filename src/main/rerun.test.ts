import { describe, it, expect } from 'bun:test'
import { rerunRun, type RerunDeps } from './rerun'
import type { UnifiedRun } from './cron-runs'
import type { AgentRun, Engine } from './agents'

function makeRun(over: Partial<UnifiedRun> = {}): UnifiedRun {
  return {
    id: 'run-1',
    source: 'agent',
    agentId: 'health',
    agentTitle: 'Health',
    engine: 'codex',
    status: 'done',
    startedAt: 1,
    repoRoot: '/repos/alpha',
    repoLabel: 'alpha',
    branch: 'main',
    worktree: '/repos/alpha',
    ...over,
  }
}

function fakeAgentRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'new-run',
    agentId: 'health',
    agentTitle: 'Health',
    engine: 'codex',
    status: 'running',
    startedAt: 2,
    repoRoot: '/repos/alpha',
    worktree: '/repos/alpha',
    branch: 'main',
    output: '',
    ...over,
  }
}

/** Spy deps; records calls so tests can assert what was dispatched. */
function spyDeps(
  opts: {
    scheduleExists?: boolean
    agentResult?: AgentRun | { error: string }
  } = {},
): RerunDeps & {
  scheduleCalls: string[]
  agentCalls: Array<{ repoRoot: string; agentId: string; engine?: Engine }>
} {
  const scheduleCalls: string[] = []
  const agentCalls: Array<{ repoRoot: string; agentId: string; engine?: Engine }> = []
  return {
    scheduleCalls,
    agentCalls,
    scheduleExists: () => opts.scheduleExists ?? true,
    runSchedule: (id) => {
      scheduleCalls.push(id)
    },
    runAgent: (repoRoot, agentId, engine) => {
      agentCalls.push({ repoRoot, agentId, engine })
      return opts.agentResult ?? fakeAgentRun()
    },
  }
}

describe('rerunRun', () => {
  it('re-fires the schedule for a cron run whose schedule still exists', () => {
    const deps = spyDeps({ scheduleExists: true })
    const res = rerunRun(makeRun({ source: 'cron', scheduleId: 'sch-9' }), deps)
    expect(res).toEqual({ ok: true })
    expect(deps.scheduleCalls).toEqual(['sch-9'])
    expect(deps.agentCalls).toEqual([]) // did NOT fall back to in-process
  })

  it('falls back to an in-process run when the cron schedule was deleted', () => {
    const deps = spyDeps({ scheduleExists: false })
    const res = rerunRun(
      makeRun({ source: 'cron', scheduleId: 'gone', repoRoot: '/repos/beta', agentId: 'audit' }),
      deps,
    )
    expect(res).toEqual({ ok: true, runId: 'new-run' })
    expect(deps.scheduleCalls).toEqual([])
    expect(deps.agentCalls).toEqual([{ repoRoot: '/repos/beta', agentId: 'audit', engine: 'codex' }])
  })

  it('re-dispatches an agent run against the run OWN repoRoot, not the active session', () => {
    const deps = spyDeps()
    const res = rerunRun(makeRun({ source: 'agent', repoRoot: '/repos/gamma', agentId: 'lint' }), deps)
    expect(res).toEqual({ ok: true, runId: 'new-run' })
    expect(deps.agentCalls).toEqual([{ repoRoot: '/repos/gamma', agentId: 'lint', engine: 'codex' }])
  })

  it('propagates an error from runAgent (e.g. unknown agent)', () => {
    const deps = spyDeps({ agentResult: { error: 'unknown agent' } })
    const res = rerunRun(makeRun(), deps)
    expect(res).toEqual({ error: 'unknown agent' })
  })

  it('errors without dispatching when the run has no repoRoot', () => {
    const deps = spyDeps()
    const res = rerunRun(makeRun({ repoRoot: '' }), deps)
    expect('error' in res).toBe(true)
    expect(deps.agentCalls).toEqual([])
  })

  it('errors without dispatching when the run has no agentId', () => {
    const deps = spyDeps()
    const res = rerunRun(makeRun({ agentId: '' }), deps)
    expect('error' in res).toBe(true)
    expect(deps.agentCalls).toEqual([])
  })

  it('passes valid engines through and coerces unknown engines to undefined', () => {
    const cursor = spyDeps()
    rerunRun(makeRun({ engine: 'cursor' }), cursor)
    expect(cursor.agentCalls[0].engine).toBe('cursor')

    const bogus = spyDeps()
    rerunRun(makeRun({ engine: 'local' }), bogus)
    expect(bogus.agentCalls[0].engine).toBeUndefined()
  })
})

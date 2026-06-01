import { describe, expect, test } from 'bun:test'
import { formatAgentRunCompletion, readRunLogFile } from './agent-run-log'

describe('formatAgentRunCompletion', () => {
  test('adds a clear done marker with exit code and duration', () => {
    expect(
      formatAgentRunCompletion({
        status: 'done',
        exitCode: 0,
        startedAt: 1_000,
        endedAt: 62_500,
      }),
    ).toBe('\n[agent] finished: done (exit 0, 1m 1s)\n')
  })

  test('handles missing exit codes without hiding completion state', () => {
    expect(
      formatAgentRunCompletion({
        status: 'interrupted',
        startedAt: 1_000,
        endedAt: 1_400,
      }),
    ).toBe('\n[agent] finished: interrupted (exit unknown, 400ms)\n')
  })
})

describe('readRunLogFile', () => {
  test('reads the durable log file with a sanitized run id', () => {
    const reads: string[] = []
    const exists = (path: string) => path.endsWith('/run-1not-allowed.log')
    const read = (path: string) => {
      reads.push(path)
      return 'full durable output'
    }

    expect(
      readRunLogFile('run-1../not-allowed', {
        runsDir: '/tmp/agent-runs',
        existsSync: exists,
        readFileSync: read,
      }),
    ).toBe('full durable output')
    expect(reads).toEqual(['/tmp/agent-runs/run-1not-allowed.log'])
  })

  test('falls back when the durable log is missing', () => {
    expect(
      readRunLogFile('missing', {
        runsDir: '/tmp/agent-runs',
        fallback: 'header only',
        existsSync: () => false,
        readFileSync: () => {
          throw new Error('should not read')
        },
      }),
    ).toBe('header only')
  })
})

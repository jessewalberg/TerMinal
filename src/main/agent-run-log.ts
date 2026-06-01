import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'

type CompletionStatus = 'done' | 'failed' | 'canceled' | 'interrupted'

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown duration'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

export function formatAgentRunCompletion(input: {
  status: CompletionStatus
  exitCode?: number
  startedAt: number
  endedAt: number
}): string {
  const exit = input.exitCode === undefined ? 'exit unknown' : `exit ${input.exitCode}`
  return `\n[agent] finished: ${input.status} (${exit}, ${formatDuration(input.endedAt - input.startedAt)})\n`
}

export function readRunLogFile(
  runId: string,
  opts: {
    runsDir: string
    fallback?: string
    existsSync?: (path: string) => boolean
    readFileSync?: (path: string) => string
  },
): string {
  const safe = runId.replace(/[^\w-]/g, '')
  const file = join(opts.runsDir, `${safe}.log`)
  const exists = opts.existsSync ?? fsExistsSync
  const read = opts.readFileSync ?? ((path: string) => fsReadFileSync(path, 'utf8'))
  try {
    return exists(file) ? read(file) : (opts.fallback ?? '')
  } catch {
    return opts.fallback ?? ''
  }
}

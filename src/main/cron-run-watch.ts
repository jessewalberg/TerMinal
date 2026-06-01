import { mkdirSync, watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CRON_RUNS_DIR = join(homedir(), '.config', 'TerMinal', 'cron-runs')

export type CronRunsWatcher = { close: () => void }

type WatchListener = (eventType: string, filename: string | Buffer | null) => void
type WatchFn = (filename: string, listener: WatchListener) => CronRunsWatcher

export type WatchCronRunsOpts = {
  runsDir?: string
  debounceMs?: number
  mkdirSync?: typeof mkdirSync
  watch?: WatchFn
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export function isCronRunRecordFile(filename: string | Buffer | null | undefined): boolean {
  const name = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString() : ''
  return !!name && name.endsWith('.json')
}

export function shouldRefreshCronRunsForFile(filename: string | Buffer | null | undefined): boolean {
  return filename == null || isCronRunRecordFile(filename)
}

export function watchCronRuns(onChange: () => void, opts: WatchCronRunsOpts = {}): CronRunsWatcher {
  const runsDir = opts.runsDir ?? CRON_RUNS_DIR
  const debounceMs = opts.debounceMs ?? 200
  const mkdir = opts.mkdirSync ?? mkdirSync
  const watch = opts.watch ?? ((dir, listener) => fsWatch(dir, listener))
  const setTimer = opts.setTimeout ?? setTimeout
  const clearTimer = opts.clearTimeout ?? clearTimeout
  let timer: ReturnType<typeof setTimeout> | null = null

  const closeTimer = () => {
    if (!timer) return
    clearTimer(timer)
    timer = null
  }

  try {
    mkdir(runsDir, { recursive: true })
    const watcher = watch(runsDir, (_eventType, filename) => {
      if (!shouldRefreshCronRunsForFile(filename)) return
      closeTimer()
      timer = setTimer(() => {
        timer = null
        onChange()
      }, debounceMs)
    })
    return {
      close: () => {
        closeTimer()
        watcher.close()
      },
    }
  } catch {
    return { close: closeTimer }
  }
}

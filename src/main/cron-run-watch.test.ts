import { describe, expect, test } from 'bun:test'
import { isCronRunRecordFile, shouldRefreshCronRunsForFile, watchCronRuns } from './cron-run-watch'

describe('cron-runs change detection', () => {
  test('only treats JSON run records as run-change files', () => {
    expect(isCronRunRecordFile('abc.json')).toBe(true)
    expect(isCronRunRecordFile(Buffer.from('abc.json'))).toBe(true)
      expect(isCronRunRecordFile('abc.log')).toBe(false)
      expect(isCronRunRecordFile('.DS_Store')).toBe(false)
      expect(isCronRunRecordFile(null)).toBe(false)
    })

    test('refreshes on JSON run records and unknown fs.watch filenames', () => {
      expect(shouldRefreshCronRunsForFile('abc.json')).toBe(true)
      expect(shouldRefreshCronRunsForFile(Buffer.from('abc.json'))).toBe(true)
      expect(shouldRefreshCronRunsForFile('abc.log')).toBe(false)
      expect(shouldRefreshCronRunsForFile('.DS_Store')).toBe(false)
      expect(shouldRefreshCronRunsForFile(null)).toBe(true)
    })

  test('debounces cron JSON file changes and ignores log writes', () => {
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | null = null
    let closed = false
    const timers = new Map<number, () => void>()
    const cleared = new Set<number>()
    let nextTimer = 1
    const calls: string[] = []
    const emit = (eventType: string, filename: string | Buffer | null) => {
      if (!listener) throw new Error('watch listener was not registered')
      listener(eventType, filename)
    }

    const watcher = watchCronRuns(() => calls.push('changed'), {
      runsDir: '/tmp/terminal-cron-runs-test',
      debounceMs: 25,
      mkdirSync: () => undefined,
      watch: (_dir, cb) => {
        listener = cb
        return { close: () => { closed = true } }
      },
      setTimeout: ((cb: () => void) => {
        const id = nextTimer++
        timers.set(id, cb)
        return id
      }) as typeof setTimeout,
      clearTimeout: ((id: number) => {
        cleared.add(id)
      }) as typeof clearTimeout,
    })

    emit('change', 'run-1.log')
    emit('rename', 'run-1.json')
    emit('change', 'run-1.json')
    emit('change', null)

      expect(calls).toEqual([])
      expect(cleared.has(1)).toBe(true)
      expect(cleared.has(2)).toBe(true)

    for (const [id, cb] of timers) {
      if (!cleared.has(id)) cb()
    }
    expect(calls).toEqual(['changed'])

    watcher.close()
    expect(closed).toBe(true)
  })
})

import { test, expect, describe } from 'bun:test'
import { shouldSpawnWatchdog, extractCiEnv } from './ci-pipeline'

describe('shouldSpawnWatchdog', () => {
  test('failed pipeline triggers', () => {
    expect(
      shouldSpawnWatchdog({
        object_kind: 'pipeline',
        object_attributes: { id: 1, status: 'failed' },
      }),
    ).toBe(true)
  })

  test('reads status from object_attributes when top-level status absent', () => {
    expect(
      shouldSpawnWatchdog({
        object_kind: 'pipeline',
        object_attributes: { id: 1, ref: 'main', status: 'failed' },
      }),
    ).toBe(true)
    expect(
      shouldSpawnWatchdog({
        object_kind: 'pipeline',
        object_attributes: { id: 1, status: 'success' },
      }),
    ).toBe(false)
  })

  test('ignores success and non-pipeline events', () => {
    expect(shouldSpawnWatchdog({ object_kind: 'pipeline', status: 'success' })).toBe(false)
    expect(shouldSpawnWatchdog({ object_kind: 'push', status: 'failed' })).toBe(false)
  })
})

describe('extractCiEnv', () => {
  test('maps GitLab pipeline fields', () => {
    expect(
      extractCiEnv({
        object_attributes: { id: 42, ref: 'fix/ci' },
        merge_request: { iid: 7 },
      }),
    ).toEqual({ pipelineId: '42', mrIid: '7', branch: 'fix/ci' })
  })
})

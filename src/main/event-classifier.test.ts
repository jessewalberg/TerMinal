import { test, expect, describe } from 'bun:test'
import { inferActivityKind, resolveActivityKind } from './event-classifier'

describe('deploy classification', () => {
  test('explicit deploy kind passes through', () => {
    expect(resolveActivityKind('deploy', 'anything')).toBe('deploy')
  })

  test('infers deploy from common ship titles', () => {
    expect(inferActivityKind('Deployed · prod')).toBe('deploy')
    expect(inferActivityKind('Deploy succeeded for pingmentions')).toBe('deploy')
    expect(inferActivityKind('Published newsletter')).toBe('deploy')
  })

  test('non-deploy titles are unaffected', () => {
    expect(inferActivityKind('PR #12 merged')).toBe('pr-merged')
    expect(inferActivityKind('tests failed')).toBe('tests-fail')
  })
})

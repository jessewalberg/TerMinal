import { describe, expect, test } from 'bun:test'
import { categorize } from './docs'

describe('categorize', () => {
  test('docs/decisions/ ADRs get their own first-class category', () => {
    expect(categorize('docs/decisions/ADR-0004-template.md')).toBe('decisions')
    expect(categorize('docs/decisions/INDEX.md')).toBe('decisions')
  })

  test('existing categories still resolve', () => {
    expect(categorize('CHANGELOG.md')).toBe('changelog')
    expect(categorize('docs/maintainer/runbook.md')).toBe('maintainer')
    expect(categorize('docs/developer/setup.md')).toBe('developer')
    expect(categorize('reports/coverage/abc.md')).toBe('reports')
    expect(categorize('checks/dead-code/abc.md')).toBe('reports')
    expect(categorize('README.md')).toBe('other')
  })
})

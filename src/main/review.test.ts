import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fmField, reviewForPrDir } from './review'

describe('fmField risk_tier', () => {
  test('reads risk_tier from artifact frontmatter', () => {
    const md = `---
verdict: approve
risk_tier: high
---
body`
    expect(fmField(md, 'risk_tier')).toBe('high')
  })
})

describe('reviewForPrDir', () => {
  test('defaults riskTier to unscored when frontmatter omits risk_tier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-review-'))
    writeFileSync(
      join(dir, 'abc1234.md'),
      `---
verdict: approve
test_status: pass
overall: 90
---
`,
    )
    const r = reviewForPrDir(dir)
    expect(r?.riskTier).toBe('unscored')
  })

  test('parses low/medium/high risk_tier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-review-'))
    writeFileSync(join(dir, 'def5678.md'), `---\nverdict: blocked\nrisk_tier: medium\n---\n`)
    expect(reviewForPrDir(dir)?.riskTier).toBe('medium')
  })
})

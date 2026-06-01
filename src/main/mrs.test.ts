import { describe, expect, test } from 'bun:test'
import { openMrRiskCounts } from './mrs'
import type { Review } from './review'

const review = (riskTier: Review['riskTier']): Review => ({
  number: 1,
  overall: 90,
  verdict: 'approve',
  testStatus: 'pass',
  stale: false,
  commitsBehind: 0,
  riskTier,
})

describe('openMrRiskCounts', () => {
  test('counts high, medium, and unscored open MRs; low is excluded from unscored', () => {
    const opened = [
      { review: review('high') },
      { review: review('high') },
      { review: review('medium') },
      { review: review('low') },
      { review: review('unscored') },
      { review: null },
    ]
    expect(openMrRiskCounts(opened)).toEqual({
      riskHigh: 2,
      riskMedium: 1,
      riskUnscored: 2,
    })
  })
})

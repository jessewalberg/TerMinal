import { test, expect, describe } from 'bun:test'
import { riskWeight, matchesRiskFilter } from './risk-tier'

describe('riskWeight', () => {
  test('orders high before medium before low before unscored', () => {
    expect(riskWeight('high')).toBeLessThan(riskWeight('medium'))
    expect(riskWeight('medium')).toBeLessThan(riskWeight('low'))
    expect(riskWeight('low')).toBeLessThan(riskWeight('unscored'))
    expect(riskWeight(undefined)).toBe(riskWeight('unscored'))
  })
})

describe('matchesRiskFilter', () => {
  test('all passes every tier', () => {
    expect(matchesRiskFilter('high', 'all')).toBe(true)
    expect(matchesRiskFilter('unscored', 'all')).toBe(true)
  })
  test('risk filters match only that tier', () => {
    expect(matchesRiskFilter('high', 'high')).toBe(true)
    expect(matchesRiskFilter('medium', 'high')).toBe(false)
    expect(matchesRiskFilter(undefined, 'unscored')).toBe(true)
    expect(matchesRiskFilter('low', 'unscored')).toBe(false)
  })
})

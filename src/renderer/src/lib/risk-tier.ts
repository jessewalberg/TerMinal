import type { Review } from './types'

export type RiskTier = Review['riskTier']
export type RiskFilter = 'all' | 'high' | 'medium' | 'unscored'

/** Sort weight: high first, then medium, low, unscored last. */
export function riskWeight(tier?: string): number {
  if (tier === 'high') return 0
  if (tier === 'medium') return 1
  if (tier === 'low') return 2
  return 3
}

export function matchesRiskFilter(tier: RiskTier | undefined, filter: RiskFilter): boolean {
  if (filter === 'all') return true
  const t = tier || 'unscored'
  if (filter === 'unscored') return t === 'unscored'
  return t === filter
}

export const RISK_PILL: Record<RiskTier, { emoji: string; label: string; tone: 'red' | 'yellow' | 'green' | 'mute' }> = {
  high: { emoji: '🔴', label: 'high', tone: 'red' },
  medium: { emoji: '🟡', label: 'medium', tone: 'yellow' },
  low: { emoji: '🟢', label: 'low', tone: 'green' },
  unscored: { emoji: '—', label: 'unscored', tone: 'mute' },
}

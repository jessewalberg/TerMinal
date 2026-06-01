import type { Review } from './review'

export type RiskFilter = 'all' | 'high' | 'medium' | 'unscored'

export function riskWeight(tier?: Review['riskTier']): number {
  if (tier === 'high') return 0
  if (tier === 'medium') return 1
  if (tier === 'low') return 2
  return 3
}

export function matchesRiskFilter(tier: Review['riskTier'] | undefined, filter: RiskFilter): boolean {
  if (filter === 'all') return true
  const t = tier || 'unscored'
  if (filter === 'unscored') return t === 'unscored'
  return t === filter
}

export const RISK_EMOJI: Record<Review['riskTier'], string> = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
  unscored: '—',
}

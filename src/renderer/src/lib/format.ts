export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

/** Compact relative time: "just now" / "30s ago" / "5m ago" / "3h ago" /
 *  "2d ago". A 0/missing timestamp reads "never"; future timestamps clamp to
 *  "just now". `now` is injectable for testing. */
export function fmtAgo(ms: number, now: number = Date.now()): string {
  if (!ms) return 'never'
  const s = Math.floor((now - ms) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

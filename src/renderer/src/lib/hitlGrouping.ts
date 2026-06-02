import type { HitlItem } from './types'

export type HitlGroup = {
  repo: string // display label
  repoRoot: string
  items: HitlItem[] // newest first
  /** Normalized titles that recur within this repo (count >= 2), busiest first. */
  recurring: { title: string; count: number }[]
}

/** Group HITL items by repo (newest-first within each), surfacing recurrence —
 *  a normalized title appearing >=2x in a repo, i.e. "repo X keeps wedging".
 *  `fileHitl` already computes dup-collapse and discards it; this recovers the
 *  signal client-side. Busiest repo first. Ticket #21. */
export function groupHitlByRepo(items: HitlItem[]): HitlGroup[] {
  const map = new Map<string, HitlItem[]>()
  for (const h of items) {
    const key = h.repoRoot || h.repo || ''
    const arr = map.get(key) || []
    arr.push(h)
    map.set(key, arr)
  }
  const groups: HitlGroup[] = []
  for (const [key, arr] of map) {
    arr.sort((a, b) => b.createdAt - a.createdAt)
    // Key recurrence on a normalized title so entries that differ only by a
    // transient id/hash/number (e.g. "Wedged · run a1b2c3d4") still collapse
    // together (#14 review finding); show the first real title as the sample.
    const counts = new Map<string, { count: number; sample: string }>()
    for (const h of arr) {
      const k = normalizeTitle(h.title)
      const prev = counts.get(k)
      if (prev) prev.count++
      else counts.set(k, { count: 1, sample: h.title })
    }
    const recurring = [...counts.values()]
      .filter((c) => c.count >= 2)
      .map((c) => ({ title: c.sample, count: c.count }))
      .sort((a, b) => b.count - a.count)
    groups.push({
      repo: arr[0].repo || (key ? key.split('/').pop() || key : '(no repo)'),
      repoRoot: arr[0].repoRoot || '',
      items: arr,
      recurring,
    })
  }
  return groups.sort((a, b) => b.items.length - a.items.length)
}

/** Normalize a HITL title for recurrence matching. Mirrors the title portion of
 *  hitl.ts's `hitlFingerprint` (the main-side dedup) so the renderer's "N×
 *  recurring" badge agrees with what `fileHitl` already collapses: lowercase,
 *  drop sha-ish hex blobs (6+) and long numbers (4+), squeeze whitespace, trim.
 *  Kept in sync intentionally — diverging thresholds undercount recurrence (#21). */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b[0-9a-f]{6,}\b/g, '') // sha-ish blobs (matches hitlFingerprint)
    .replace(/\b\d{4,}\b/g, '') // long numbers (PRs, runs)
    .replace(/\s+/g, ' ')
    .trim()
}

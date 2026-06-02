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
    const counts = new Map<string, number>()
    for (const h of arr) {
      const t = h.title.trim().toLowerCase()
      counts.set(t, (counts.get(t) || 0) + 1)
    }
    const recurring = [...counts.entries()]
      .filter(([, c]) => c >= 2)
      .map(([title, count]) => ({ title, count }))
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

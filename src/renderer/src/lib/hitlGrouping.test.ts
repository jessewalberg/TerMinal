import { describe, expect, test } from 'bun:test'
import { groupHitlByRepo } from './hitlGrouping'
import type { HitlItem } from './types'

const h = (over: Partial<HitlItem>): HitlItem => ({
  id: Math.random().toString(36).slice(2),
  title: 'something',
  source: 'manual',
  status: 'open',
  createdAt: 0,
  ...over,
})

describe('groupHitlByRepo', () => {
  test('groups by repoRoot, newest first within a group', () => {
    const groups = groupHitlByRepo([
      h({ repoRoot: '/p/web', repo: 'web', title: 'a', createdAt: 1 }),
      h({ repoRoot: '/p/web', repo: 'web', title: 'b', createdAt: 3 }),
      h({ repoRoot: '/p/api', repo: 'api', title: 'c', createdAt: 2 }),
    ])
    expect(groups.map((g) => g.repo)).toEqual(['web', 'api']) // busiest first
    expect(groups[0].items.map((i) => i.title)).toEqual(['b', 'a']) // newest first
  })

  test('surfaces recurrence (same normalized title >=2x), busiest first', () => {
    const groups = groupHitlByRepo([
      h({ repoRoot: '/p/web', repo: 'web', title: 'Crash-loop · sync' }),
      h({ repoRoot: '/p/web', repo: 'web', title: 'crash-loop · sync ' }), // case/space dup
      h({ repoRoot: '/p/web', repo: 'web', title: 'Crash-loop · sync' }),
      h({ repoRoot: '/p/web', repo: 'web', title: 'one-off' }),
    ])
    // display title is the first real occurrence (original casing), not the key
    expect(groups[0].recurring).toEqual([{ title: 'Crash-loop · sync', count: 3 }])
  })

  test('recurrence collapses titles that differ only by a transient id/hash', () => {
    const groups = groupHitlByRepo([
      h({ repoRoot: '/p/w', repo: 'w', title: 'Wedged · run a1b2c3d4' }),
      h({ repoRoot: '/p/w', repo: 'w', title: 'Wedged · run e5f6a7b8' }),
      h({ repoRoot: '/p/w', repo: 'w', title: 'Wedged · run 99887766' }),
    ])
    expect(groups[0].recurring).toHaveLength(1)
    expect(groups[0].recurring[0].count).toBe(3)
    expect(groups[0].recurring[0].title).toBe('Wedged · run a1b2c3d4')
  })

  test('no recurrence when all titles unique', () => {
    const groups = groupHitlByRepo([
      h({ repoRoot: '/p/x', repo: 'x', title: 'a' }),
      h({ repoRoot: '/p/x', repo: 'x', title: 'b' }),
    ])
    expect(groups[0].recurring).toEqual([])
  })

  test('items with no repo fall into a single (no repo) group', () => {
    const groups = groupHitlByRepo([h({ title: 'a' }), h({ title: 'b' })])
    expect(groups).toHaveLength(1)
    expect(groups[0].repo).toBe('(no repo)')
  })
})

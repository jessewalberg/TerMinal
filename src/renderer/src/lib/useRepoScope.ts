import { useState } from 'react'

/** Last path segment of a repo root, e.g. "/a/b/TerMinal" → "TerMinal". */
export function repoBasename(repoRoot: string): string {
  return repoRoot.split('/').filter(Boolean).pop() || ''
}

/**
 * Resolve the initial repo-label filter for a list tab.
 *
 * House rule: a window attached to one repo defaults to showing THAT repo's
 * data, with an explicit "all repos" ('') opt-out. A user's persisted pick
 * (read from localStorage as `stored`) always wins — including a deliberate
 * '' (all repos), which is why we test `!== null` rather than truthiness.
 */
export function initialRepoScope({
  stored,
  currentRepo,
}: {
  stored: string | null
  currentRepo: string
}): string {
  return stored !== null ? stored : currentRepo
}

/**
 * Shared repo-label filter for list tabs (Runs, Schedules, Agents-runs). Defaults
 * to the window's current repo and persists the user's choice under `storageKey`
 * so the toggle sticks across refreshes and reopens. Returns the current filter,
 * a setter that persists, and the current repo's label so callers can guarantee
 * it stays a selectable option even before any of its rows have loaded.
 */
export function useRepoScope(
  repoRoot: string,
  storageKey: string,
): { repo: string; setRepo: (v: string) => void; currentRepo: string } {
  const currentRepo = repoBasename(repoRoot)
  const [repo, setRepoState] = useState<string>(() => {
    let stored: string | null = null
    try {
      stored = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null
    } catch {
      /* localStorage unavailable */
    }
    return initialRepoScope({ stored, currentRepo })
  })
  const setRepo = (v: string) => {
    setRepoState(v)
    try {
      localStorage.setItem(storageKey, v)
    } catch {
      /* ignore persistence failures */
    }
  }
  return { repo, setRepo, currentRepo }
}

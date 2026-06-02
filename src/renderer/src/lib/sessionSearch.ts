import type { SessionMeta } from './types'

/** Case-insensitive free-text filter over a session's prompt + cwd + branch.
 *  An empty/whitespace query returns the list unchanged (same reference), so
 *  callers can cheaply detect "not searching". Ticket #20. */
export function filterSessions(sessions: SessionMeta[], query: string): SessionMeta[] {
  const q = query.trim().toLowerCase()
  if (!q) return sessions
  return sessions.filter((s) =>
    `${s.firstUserText} ${s.cwd} ${s.gitBranch}`.toLowerCase().includes(q),
  )
}

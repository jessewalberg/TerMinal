import type { SessionEngine, SessionMeta } from './types'

/** True when a session's cwd is `dir` itself or nested under it. */
export function underDir(sessionCwd: string, dir: string): boolean {
  return sessionCwd === dir || sessionCwd.startsWith(dir.replace(/\/$/, '') + '/')
}

/**
 * Default engine for the session picker.
 *
 * `listSessions()` only ever returns claude/codex sessions — a `local` shell
 * has no resumable transcript — so hardcoding the picker's engine selector to
 * `local` made the Resume list render empty on every open even when hundreds of
 * sessions exist. Pick a data-driven default instead: the newest in-scope
 * session's engine, else the newest overall, else `claude`.
 *
 * `sessions` must be sorted newest-first (the order `listSessions()` returns).
 */
export function pickDefaultEngine(sessions: SessionMeta[], cwd?: string): SessionEngine {
  const scoped = cwd ? sessions.filter((s) => underDir(s.cwd, cwd)) : sessions
  return scoped[0]?.engine ?? sessions[0]?.engine ?? 'claude'
}

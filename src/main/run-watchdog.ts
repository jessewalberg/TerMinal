// Per-run wall-clock watchdog policy (ticket #15). Pure + dependency-free so
// it's unit-testable; the setTimeout/kill wiring lives in runSpec (in-process
// runs) and bin/terminal-cron (scheduled runs).
//
// Two caps, both in milliseconds, both opt-outable with 0:
//   soft → log a "[runtime cap]" warning + emitActivity + file HITL (non-fatal)
//   hard → SIGTERM the run (worktree/commits survive)
// Default is WARN-ONLY (hard = 0): a long-but-progressing run is flagged, not
// killed — respecting the SIGKILL/token-cap rejections recorded in #0002/#0009.

/** Default soft cap: 3h. Long enough that a healthy run never trips it. */
export const DEFAULT_SOFT_RUN_MS = 3 * 60 * 60 * 1000

export type WatchdogAction = 'warn' | 'kill'
export type WatchdogTimer = { atMs: number; action: WatchdogAction }

const enabled = (ms: number) => Number.isFinite(ms) && ms > 0

/**
 * Resolve the configured soft/hard caps into the concrete timers to arm.
 * Returns at most one 'warn' and one 'kill', sorted by time. A hard cap earlier
 * than the soft cap is clamped up so a reap never precedes its warning.
 */
export function planWatchdogTimers(softMs: number, hardMs: number): WatchdogTimer[] {
  const timers: WatchdogTimer[] = []
  const soft = enabled(softMs) ? softMs : 0
  let hard = enabled(hardMs) ? hardMs : 0
  if (soft && hard && hard < soft) hard = soft // warn-then-reap, never reap-first
  if (soft) timers.push({ atMs: soft, action: 'warn' })
  if (hard) timers.push({ atMs: hard, action: 'kill' })
  // stable sort keeps warn before kill when they coincide
  return timers.sort((a, b) => a.atMs - b.atMs)
}

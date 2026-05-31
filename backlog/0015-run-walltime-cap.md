---
id: 15
title: "Per-run wall-clock soft cap (warn-then-reap)"
status: closed
priority: low
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-05-31
prs: []
refs: []
---

## Why
No maxRuntime/token cap on any spawn; the 2h sweep only reaps dead PIDs. A single internally-looping run runs unbounded until self-exit or manual cancel. Fleet-level runaway IS gated (spawn-gate + circuit-breaker after 3); the single-run case isn't.

## Recommendation
Add a per-run wall-clock *soft* warn-then-reap in `bin/terminal-cron` (and `runSpec` for bg/scheduled only, never interactive): one `setTimeout` at a configurable `maxRunMs` (default ~3h, off=0) that logs a "[runtime cap]" line, pings Telegram + files HITL, and SIGTERMs only if a hard cap is also set (worktree survives). Warn-only default — respects the token-cap/SIGKILL rejections in #0002/#0009.

_Severity low · effort small · from the 2026-05-31 fit/gaps analysis._

## Resolution (2026-05-31)

Implemented per the recommendation. Warn-only by default; hard SIGTERM opt-in.

- `src/main/run-watchdog.ts` — pure `planWatchdogTimers(softMs, hardMs)` policy
  (unit-tested): at most one `warn` + one `kill` timer, hard clamped ≥ soft so a
  reap never precedes its warning, 0 = off for either cap.
- Settings: `maxRunMs` (soft, default 3h) + `maxRunHardMs` (hard, default 0/off).
- `runSpec` (in-process): arms the timers for non-`inPlace` runs; soft → a
  `[runtime cap]` log line + error activity + HITL (keeps running); hard →
  SIGTERM + finalize as `interrupted`. Cleared on normal finalize.
- `bin/terminal-cron`: same soft/hard cap inlined (self-contained runner).

See ADR-0003. Surfaced by the wedged-looking cursor run on 2026-05-31 (which was
actually a streaming bug, not a hang — but proved the cap was missing).

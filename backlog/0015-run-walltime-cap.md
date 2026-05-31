---
id: 15
title: "Per-run wall-clock soft cap (warn-then-reap)"
status: open
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

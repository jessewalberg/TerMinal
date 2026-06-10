---
id: 27
title: "Auto-wrap spawned/cron agents in doppler run for Doppler repos"
status: closed
closed_reason: "re-homed to agent-config factory backlog (2026-06-10 consolidation) — see backlog/factory-rebuild-plan.md"
priority: low
horizon: future
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-06-10
prs: []
refs: []
---

## Why
TerMinal has zero Doppler awareness; the 5 active Doppler repos standardized on `doppler run -- …`, and `runSpec`/`terminal-cron` spawn under plain inherited env, so non-interactive agents touching Convex/DB/Clerk hit missing env.

## Recommendation
Detect a committed `doppler.yaml` at the worktree root and auto-prefix script-first agent commands with `doppler run -- ` (or set `TERMINAL_DOPPLER=1`). Document the convention in `.agents/scripts.md`. ~30-60 LOC. Don't build a full Doppler integration.

_Severity low · effort small · from the 2026-05-31 fit/gaps analysis._

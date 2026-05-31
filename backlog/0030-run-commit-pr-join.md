---
id: 30
title: "Structured run↔commit↔PR join on AgentRun records"
status: open
priority: low
horizon: future
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-05-31
prs: []
refs: []
---

## Why
`finalize()` stores tokens/cost/exit but no SHA/PR linkage; once a worktree is reaped, the only structured trace of a confidently-wrong-but-successful run is whatever it pushed (meta .json + .log persist, but unstructured).

## Recommendation
In `finalize()` (agents.ts), for non-inPlace runs capture `git -C worktree rev-parse HEAD` + base merge-base diffstat before reaping; store `headSha`/`baseSha` on the AgentRun record; show a copyable SHA chip on the Runs row. Have the agent's `emitActivity` attach `ref:{pr}` when output contains a PR URL. Skip a SQLite audit store.

_Severity low · effort small · from the 2026-05-31 fit/gaps analysis._

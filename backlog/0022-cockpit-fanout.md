---
id: 22
title: "Cross-repo fan-out for agent/schedule/bg actions"
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
Agent/schedule/bg actions all key off the active session's single repo; fleet-wide chores are script-shaped by design, not UI-shaped. (Counterpart to the new Triage tab, which made the *read* side cross-repo.)

## Recommendation
Add an optional multi-repo target to the agent/schedule launch path (run the same agent across a selected set of known repos, each in its own worktree). Lower priority — validate the need against real usage first.

_Severity low · effort medium · from the 2026-05-31 fit/gaps analysis._

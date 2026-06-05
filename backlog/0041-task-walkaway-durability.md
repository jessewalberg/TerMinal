---
id: 41
title: "Walk-away durability for task runs (survive app quit mid-stage)"
status: open
priority: medium
horizon: future
hitl: false
type: feature
source: adr-0011-task-first-routing
created: 2026-06-05
updated: 2026-06-05
prs: []
refs: [docs/decisions/0011-task-first-role-routing.md]
---

## Description
In-process task runs die with the app (boot marks them interrupted). bg-tasks
(detached, unref'd) survives quit but is single-engine and single-step. To make
tasks survive: either teach the bg runner to execute a role-routed step chain
(snapshot the resolved roleSteps into the task record, mirroring the ADR-0011
snapshot rule), or resume interrupted task runs from the last completed stage
boundary on boot (the plan/commits live in the worktree; stage boundaries are
clean restart points). Decide deliberately — design 2's reconciler notes in the
ADR are the starting point.

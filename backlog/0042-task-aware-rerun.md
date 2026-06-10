---
id: 42
title: "Task-aware rerun — replay the ORIGINAL per-stage engines/models"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: low
horizon: next
hitl: false
type: bug
source: adr-0011-task-first-routing
created: 2026-06-05
updated: 2026-06-10
prs: []
refs: [docs/decisions/0011-task-first-role-routing.md]
---

## Description
runs:rerun recovers run.engine (one value) and drops per-stage routing — a
rerun task run degrades to single-engine. Per ADR-0011 snapshot semantics,
rerun should replay the engines captured at first run: persist the resolved
routing (role+engine+model per step) on the AgentRun meta and teach rerun.ts to
rebuild the step chain from it instead of composing fresh from current policy.

---
id: 25
title: "Emit activity events from sibling repos so cross-repo rollups aren't input-starved"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: medium
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-06-10
prs: []
refs: []
---

## Why
Cross-repo factory rollups are input-starved because no sibling emits activity events. The lever is event emission at scaffold, not the backlog/.reviews dir layout.

## Recommendation
Wire the project-template scaffold (and the bootstrap/retrofit path) to install the `.claude/bin/activity` hook + emit baseline lifecycle events, so newly-scaffolded and retrofitted repos feed `factory-health`/`cycle` automatically.

_Severity medium · effort medium · from the 2026-05-31 fit/gaps analysis._

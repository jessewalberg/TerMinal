---
id: 23
title: "Pre-repo idea capture + promote-to-scaffold"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: low
horizon: future
hitl: false
type: ux
source: analysis
created: 2026-05-31
updated: 2026-06-10
prs: []
refs: []
---

## Why
The leftmost in-app surface is "ticket"; the arc starts at an already-initialized repo. Notes/docs/project-registry already absorb free-text ideas, so this is a smoothness gap, not a void.

## Recommendation
Validate desire first. If wanted, extend notes.ts with a structured global `ideas.json`, surface on EntryScreen, give each a "Scaffold this" button that prefills `project:scaffold` and drops the idea into `backlog/0001-*.md` via `createTicket`.

_Severity low · effort small · from the 2026-05-31 fit/gaps analysis._

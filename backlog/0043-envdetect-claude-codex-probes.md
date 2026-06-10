---
id: 43
title: "EnvDetect claude/codex readiness probes + task queueing follow-up"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: low
horizon: future
hitl: false
type: dx
source: adr-0011-task-first-routing
created: 2026-06-05
updated: 2026-06-10
prs: []
refs: [docs/decisions/0011-task-first-role-routing.md]
---

## Description
env:detect reports found/authed for cursor/gh/glab but has no claude or codex
auth probes; runTask preflights binary existence through the login shell but
cannot see auth state, so an unauthed engine still fails three stages in. Add
cheap claude/codex readiness probes to EnvDetect and surface them in the
composer. Separately: a second task in the same repo is currently REFUSED
(duplicate-run guard, owner choice); if that chafes, queue it instead —
auto-start when the first finishes.

---
id: 40
title: "Telegram /task <prompt> — fire a role-routed task from the phone"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: medium
horizon: next
hitl: false
type: feature
source: adr-0011-task-first-routing
created: 2026-06-05
updated: 2026-06-10
prs: []
refs: [docs/decisions/0011-task-first-role-routing.md]
---

## Description
The ⌘K composer covers the desktop; the AFK surface is Telegram. Add a /task
command to src/main/telegram.ts that calls the same runTask() path. Open
question the desktop dodges: repo selection with no active workspace — support
an explicit repo token (`/task <repo> — <prompt>`) and default to the
last-used task repo otherwise. Reuse tasks:start semantics (preflight, budget
gate, duplicate-run refusal) and reply with the run id + failures.

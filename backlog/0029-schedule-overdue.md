---
id: 29
title: "Overdue detection for calendar/cron schedules + flake-vs-fault"
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
The watchdog cadence check skips calendar/cron specs (only interval), so a dead 3am LaunchAgent produces no overdue HITL; and `runSchedule` files HITL+ticket on every non-zero exit with no flake-vs-fault classification. Latent today (zero schedules installed).

## Recommendation
Extend `watchdogCadenceCheck()` to cover calendar/cron by reusing `cron.ts`'s next-fire math to derive an expected-last-fire window — closes the silent-dead-nightly hole. Add a `cron.test.ts` case. Secondary: tail the run log through the existing last-error-cluster fallback before filing, to tag transient blips. Skip retry/backoff.

_Severity medium · effort small · from the 2026-05-31 fit/gaps analysis._

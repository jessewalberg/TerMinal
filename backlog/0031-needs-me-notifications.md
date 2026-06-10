---
id: 31
title: "Flip the needs-me/awaiting fleet state to a distinct notification after a dry-run"
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
Follow-up to the shipped visual-only "awaiting" fleet state (PR: feat(fleet) needs-me). Today a permission-paused/clarifying session shows an amber "needs you" dot but still fires the same "· ready" ping (or none). The report recommended a dry-run before changing notification behavior.

## Recommendation
Log the `awaiting` classification to Activity for ~a week, validate the heuristic's false-positive rate, then emit a distinct `needs-input` notification (macOS + Telegram) instead of "· ready" when a session enters `awaiting`. Reuses the existing fleet poll + notification plumbing.

_Severity medium · effort small · from the 2026-05-31 fit/gaps analysis._

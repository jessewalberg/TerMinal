---
id: 38
title: "Wedged detector: reclassify endless transient loops + explicit headless/interactive signal"
status: open
priority: low
horizon: later
hitl: false
type: dx
source: ADR-0010 (wedged-detector redefinition, 2026-06-03)
created: 2026-06-03
updated: 2026-06-03
prs: []
refs: ["docs/decisions/0010-wedged-detector-definition.md"]
depends_on: []
---

## Problem
The wedged-detector rebuild (ADR-0010) eliminated the false positives by
redefining "wedged" (signature on real error + command, liveness gate,
transient/config carve-out, attended-session scope). Two deliberate
false-negatives remain, accepted for now but worth revisiting if they bite:

1. **Endless transient loops are silent.** An agent that hammers a rate-limited
   endpoint (HTTP 429/5xx) *forever* without pivoting is excluded from wedge
   detection by F-3 (`isTransientOrConfigFailure`). That's correct for "unstick
   the agent loop" framing, but a perpetually-throttled overnight agent burning
   budget is still worth surfacing — as its own actionable class, not as "wedged".

2. **Attended detection is heuristic.** F-7 (`lastHumanInputAt`) infers "a human
   is here" from string-content user messages dated after the last error. If a
   future harness injects string-content user turns into headless runs, those
   headless agents would look attended and be skipped. There is no explicit
   headless-vs-interactive marker in the transcript today.

## Proposed approach
- **Transient reclassification:** instead of dropping transient/config failures,
  count them on a separate track with a higher bar (much larger repeat count
  AND a near-full-window span, since real FP bursts were 24–38s) and file a
  distinct, accurately-worded HITL ("rate-limited endpoint, N retries over Ms"
  / "tool X unreachable") rather than "likely wedged".
- **Explicit attended signal:** find a reliable headless-vs-interactive marker
  (entrypoint / promptSource / a TerMinal-set field on spawned agents) and use
  it instead of, or in addition to, the string-message heuristic. Only then is it
  safe to *also* detect wedges in attended sessions that the human abandoned.

## Acceptance criteria
- A synthetic endless-429 transcript produces a transient-class alert (not
  "wedged", not silence) once it crosses the higher bar; a short 429 backoff that
  pivots still produces nothing.
- Headless agents are never treated as attended regardless of injected user
  turns; interactive sessions with a human responding after errors are still
  skipped.
- TDD: tests added under `wedged-session-detector.test.ts` for both.

## Notes
Low priority — the ADR-0010 changes already removed every observed false
positive. This is hardening for edge cases, not a live bug.

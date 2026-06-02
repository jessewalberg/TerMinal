---
id: 21
title: "Repo-picker per-repo badges + HITL group-by-repo + recurrence"
status: closed
priority: medium
horizon: next
hitl: false
type: ux
source: analysis
created: 2026-05-31
updated: 2026-06-02
prs: []
refs: []
---

## Why
Recents show basenames with zero state (open PRs, dirty tree, ticket count, last activity); HITL is reverse-chron with no group-by-repo or recurrence heat (despite `fileHitl` already computing dup-collapse and discarding it).

## Recommendation
(1) HITL group-by-repo + "N× recurring" badge — ~30 lines, pure client-side, surfaces "repo X keeps wedging". (2) A `repo:badges(roots[])` IPC for the ≤6 recents only, returning cheap local reads keyed by repoRoot (ticket count, git-dirty, cached `mrSummary`, last activity). Skip CI (network). Don't lean on `factory-health.byRepo` — wrong signal.

_Severity medium · effort medium · from the 2026-05-31 fit/gaps analysis._

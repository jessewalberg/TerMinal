---
id: 24
title: "Inject docs/learnings at agent spawn (compounding loop)"
status: in-progress
priority: medium
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-06-02
prs: ["https://github.com/jessewalberg/TerMinal/pull/15"]
refs: []
---

## Why
Learning loops are pull-only: nothing injects learnings/ADRs at spawn; the full spawn chain composes only base prompt + static persona + preamble. Same gotchas recur across ~22 near-clone repos.

## Recommendation
At spawn in agents.ts (and terminal-cron), prepend a short "prior gotchas" block from the repo's `docs/learnings/*.md` titles+one-liners (cap ~1-2KB, skip if empty) — turning the existing `search_decisions` pull into a cheap push. ~30-40 lines, reuses docs.ts enumeration, no new store. Payoff gated on actually capturing learnings.

_Severity medium · effort medium · from the 2026-05-31 fit/gaps analysis._

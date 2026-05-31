---
id: 17
title: "First-class ADR category in the Docs tab"
status: open
priority: medium
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-05-31
prs: []
refs: []
---

## Why
docs/decisions ADRs (the active cohort's core artifact) bucket into Docs "Other" with no first-class surface.

## Recommendation
Add a `decisions` `DocCategory` in docs.ts (`if (norm.startsWith('docs/decisions/')) return 'decisions'`) + a label/order entry + one `categorize()` test. ~15 lines for the high-value half.

_Severity medium · effort small (high-value half ~15 lines) · from the 2026-05-31 fit/gaps analysis._

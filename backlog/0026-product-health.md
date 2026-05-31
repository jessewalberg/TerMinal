---
id: 26
title: "Product-health check kind for content/data/outreach repos"
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
Ticket TYPES + classifier carry only engineering categories; the review gate IS "run the test suite" (test-less content repos fall through); observability tracks only AI-run cost. For newsletters and civic-data sites, a dead data source or unsent digest is worse than a red test and produces zero TerMinal signal.

## Recommendation
Add a `product-health` check kind running a repo-defined `.agents/product-health.sh` (source-liveness `curl -sf`, freshness, "last digest sent within N days") that files HITL + emits a `product-health`/`error` activity event on failure — reuses scheduler + HITL + activity plumbing. Tiny first slice: add `content`/`data` to ticket TYPES + a matching activity kind; instrument one civic-data repo (uslandfills has DATA_SOURCES).

_Severity medium · effort medium · from the 2026-05-31 fit/gaps analysis._

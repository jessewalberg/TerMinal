---
id: 20
title: "Resume picker free-text search + drop the 300 truncation"
status: closed
priority: medium
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-06-02
prs: []
refs: []
---

## Why
The resume picker filters only by engine + directory then slices to 300, with no search over `firstUserText`/`cwd`/`branch` — "reattach to that session where I was debugging X" is unserved and history past the 300th is silently unreachable.

## Recommendation
Add a controlled text input to EntryScreen that case-insensitively filters the in-memory `shown` list on `firstUserText`+`cwd`+`gitBranch` (~10 lines, pure client-side — `listSessions()` already returns every field). Change the header to "showing N of M" and only slice when unsearched.

_Severity medium · effort small · from the 2026-05-31 fit/gaps analysis._

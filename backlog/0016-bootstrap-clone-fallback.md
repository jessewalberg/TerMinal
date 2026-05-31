---
id: 16
title: "workspace:bootstrap clone fallback + partial-adoption detection"
status: open
priority: medium
horizon: next
hitl: false
type: bug
source: analysis
created: 2026-05-31
updated: 2026-05-31
prs: []
refs: []
---

## Why
`workspace:bootstrap` needs project-template, which is an empty submodule here, so the only in-app retrofit silently fails. `isBootstrapped` only checks `.agents/`, so the ~21 partially-wired siblings (have `.agents/` but no `backlog/`/`sessions/`) never get the banner yet render permanent empty Tickets/Sessions/Reports tabs.

## Recommendation
Give `workspace:bootstrap` the clone fallback `scaffold.ts` already has (shallow-clone `resolvedTemplateRepo()` to a tmpdir when `localProjectTemplateRoot()` is empty, mirror scaffold.ts:27-32). Optionally broaden `isBootstrapped` to report missing factory dirs so the banner can say "partially wired."

_Severity medium · effort small · from the 2026-05-31 fit/gaps analysis._

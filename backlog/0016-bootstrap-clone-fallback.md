---
id: 16
title: "workspace:bootstrap clone fallback + partial-adoption detection"
status: closed
priority: medium
horizon: next
hitl: false
type: bug
source: analysis
created: 2026-05-31
updated: 2026-06-02
prs: []
refs: [ADR-0004]
---

## Why
`workspace:bootstrap` needs project-template, which is an empty submodule here, so the only in-app retrofit silently fails. `isBootstrapped` only checks `.agents/`, so the ~21 partially-wired siblings (have `.agents/` but no `backlog/`/`sessions/`) never get the banner yet render permanent empty Tickets/Sessions/Reports tabs.

## Recommendation
Give `workspace:bootstrap` the clone fallback `scaffold.ts` already has (shallow-clone `resolvedTemplateRepo()` to a tmpdir when `localProjectTemplateRoot()` is empty, mirror scaffold.ts:27-32). Optionally broaden `isBootstrapped` to report missing factory dirs so the banner can say "partially wired."

_Severity medium · effort small · from the 2026-05-31 fit/gaps analysis._

## Progress (2026-05-31)
**Clone fallback — done** (ADR-0004). `src/main/template.ts` (`pickTemplateSource`,
unit-tested) + `workspace:bootstrap` now shallow-clone `resolvedTemplateRepo()`
to a tmpdir when no local checkout has `bootstrap.sh`, so the in-app retrofit
works in the packaged app. Dedupe of the remaining duplicate resolvers
(`scaffold.ts`, telegram `/install`) split to #0033.

**Still open — partial-adoption detection.** `isBootstrapped` still checks only
`.agents/`; partially-wired repos (have `.agents/` but no `backlog/`/`sessions/`)
don't get the banner and render empty Tickets/Sessions/Reports tabs. Keeping this
ticket open for that piece.

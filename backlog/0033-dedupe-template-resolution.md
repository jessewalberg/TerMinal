---
id: 33
title: "Dedupe template resolution: unify scaffold / bootstrap / telegram onto template.ts"
status: closed
priority: low
horizon: next
hitl: false
type: refactor
source: analysis
created: 2026-05-31
updated: 2026-06-01
prs: [https://github.com/jessewalberg/TerMinal/pull/4]
refs: [ADR-0004]
depends_on: []
---

## Why
ADR-0004 added `src/main/template.ts` (`pickTemplateSource`) and wired
`workspace:bootstrap` to it, but two near-duplicate "find-or-fetch the
project-template" resolvers remain and drift independently:

- `scaffold.ts` `templateSource()` — local (`app.getAppPath()` only) + a
  `git pull --ff-only` refresh, else shallow clone.
- `telegram.ts` `sourceCheckoutRoot` / `localProjectTemplateRoot` — used by
  `/install <agent>`; probes the template's `.agents/`, has **no clone
  fallback**, so `/install` silently fails in the packaged app (the same class
  of bug ADR-0004 fixed for bootstrap).

## Recommendation
Fold all three onto `template.ts`:

- Generalize `pickTemplateSource` to accept the probe marker (`bootstrap.sh` vs
  `.agents/`) and an optional local-refresh hook (scaffold's
  `git pull --ff-only`).
- Have `scaffoldProject` and telegram `/install` call it; delete the duplicated
  `sourceCheckoutRoot` / `localProjectTemplateRoot` copies (keep the single
  `sourceCheckoutRoot` the in-app rebuild path needs).
- Adding the clone fallback to telegram `/install` falls out for free.

_Severity low · effort small–medium · follow-up from ADR-0004._

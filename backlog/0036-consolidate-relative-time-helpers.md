---
id: 36
title: "Consolidate the divergent relative-time helpers onto lib/format.ts fmtAgo"
status: open
priority: low
horizon: next
hitl: false
type: refactor
source: analysis
created: 2026-06-01
updated: 2026-06-01
prs: []
refs: []
depends_on: []
---

## Why
`src/renderer/src/lib/format.ts` exports `fmtAgo` — the tested, canonical
relative-time formatter ("never"/"just now"/"Ns ago"/"Nm ago"/…) — but most of
the app reimplements it. After the 2026-06-01 audit, Sessions was routed onto
`fmtAgo` (fixing its "0m ago" bug), but several near-duplicate `reltime` /
`reldate` / `rel` / `fmtRelative` copies remain and drift in output:

- `tabs/activity/index.tsx`, `tabs/hitl/index.tsx`, `tabs/schedules/index.tsx`,
  `tabs/agents/index.tsx` (`fmtRelative` + `reltime`), `tabs/reports/index.tsx`,
  `components/EntryScreen.tsx`.
- `tabs/ci/index.tsx` `fmtRelative` returns `"5m"` with **no** "ago" suffix, so
  its call site appends a literal `" ago"` (`ci/index.tsx:257`) — a different
  contract from every other copy.

Some include "just now", some don't; this is why timestamps read slightly
differently tab-to-tab.

## Recommendation
Make `fmtAgo` the single source of truth and delete the per-tab copies. If the
CI call site genuinely needs a suffix-less form, add a small `fmtAgoShort`
(or a `{ suffix?: boolean }` option) to `format.ts` rather than a bespoke copy,
and drop the literal `" ago"` at `ci/index.tsx:257`.

### Watch-outs
- This touches many visible labels — verify each call site renders the expected
  string (extend `format.test.ts` with the CI/no-suffix case).
- Keep the `iso`-string vs `ms` distinction: Sessions/Tickets pass date strings
  (`Date.parse` first); the widgets pass epoch ms.

_Severity low · effort small (broad blast radius) · follow-up from the 2026-06-01 audit._

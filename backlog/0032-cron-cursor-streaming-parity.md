---
id: 32
title: "terminal-cron: support cursor engine + stream-json decoding parity"
status: open
priority: low
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-05-31
prs: []
refs: []
depends_on: []
---

## Why

`bin/terminal-cron` is self-contained (no app-bundle imports) and only branches
`claude` vs `codex` when building the spawn command — a scheduled `engine:
cursor` falls through to the **codex** builder, so it never actually runs cursor.
Separately, even if it did, it would inherit the old buffered-`text` problem
fixed for in-process runs in ADR-0003: cursor needs `--output-format stream-json
--stream-partial-output` plus a decoder to produce readable live logs.

The in-process path (`src/main/agents.ts` + `engine-cmd.ts` + `cursor-stream.ts`)
already handles this; cron does not, because it can't import the shared decoder.

## What

- Add a `cursor` command branch to cron's builder mirroring `engine-cmd.ts`
  (incl. the stream-json flags).
- Inline a minimal port of `createCursorStreamDecoder()` (cron is intentionally
  import-free) so scheduled cursor logs stream like the in-process ones, and feed
  decoded text to `logFile` instead of raw NDJSON.
- Add a cursor-stream decode test mirroring `cursor-stream.test.ts`, or extract a
  shared fixture both can assert against to prevent drift.

## Notes

The wall-clock watchdog (ticket #15 / ADR-0003) is already inlined in cron and
applies to claude/codex scheduled runs today — this ticket is only the cursor
engine + streaming gap.

_Severity low · effort small · spun off from the ADR-0003 work (2026-05-31)._

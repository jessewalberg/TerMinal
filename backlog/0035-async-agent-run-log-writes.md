---
id: 35
title: "Agent run streaming: replace per-chunk appendFileSync with a buffered write stream"
status: open
priority: low
horizon: next
hitl: false
type: perf
source: analysis
created: 2026-06-01
updated: 2026-06-01
prs: []
refs: []
depends_on: []
---

## Why
`append()` in `src/main/agents.ts` runs on every stdout/stderr `data` event of a
spawned claude/codex run and calls `appendLog()` → `appendFileSync(logPath(id),
chunk)` — a blocking, synchronous disk write on the Electron main thread for
every chunk (claude stream-json emits many small chunks per second per run).
With several concurrent runs this multiplies synchronous fs writes on the UI
thread. The in-memory `run.output` already serves the live render via IPC, so
the on-disk log does not need to be flushed synchronously.

Deferred from the 2026-06-01 UI/perf audit (rated low severity; the change has
real stream-lifecycle risk on the daily-driver binary, so it was split out
rather than done blind alongside the behavior-preserving caches).

## Recommendation
Use a per-run `fs.createWriteStream(logPath(id), { flags: 'a' })` (buffered +
async `write()`) instead of `appendFileSync` per chunk, or batch chunks behind a
short flush timer. Open the stream in `runSpec` when the run starts, write
chunks to it from `append()`, and end/close it in `finalize()` (and on the
watchdog/abort paths). Keep `run.output` as the live-render source unchanged.

### Watch-outs
- Close the stream on every terminal path (`finalize`, watchdog SIGTERM, crash)
  so descriptors don't leak across many runs.
- Preserve the existing `OUTPUT_CAP` slicing for the in-memory buffer; the disk
  log can keep the full tail or adopt the same cap — pick one and document it.
- `loadPersistedRuns` reads `logPath(id)` on startup; ensure a half-written log
  still parses (it already tolerates a missing file).

_Severity low · effort small · follow-up from the 2026-06-01 audit._

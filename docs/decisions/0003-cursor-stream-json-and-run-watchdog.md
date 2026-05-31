---
id: 0003
title: Cursor headless runs stream NDJSON (decoded) + per-run wall-clock watchdog
anchor: ADR-0003
status: accepted
date: 2026-05-31
supersedes:
superseded-by:
---

## [1] Context

A `cursor` Agents-tab run (implement ticket #5, "Review + Iterate", 2026-05-31)
*looked* hung: for minutes the run pane showed only the `━━ step 1/3 ━━` header
and a stray `^D`, and the live log appeared empty. The persisted run record
proved otherwise — `status: done`, `exitCode: 0`, all 3 steps, ~6 min, PR opened
and self-reviewed. Nothing was stuck.

Root cause: TerMinal launched cursor as `cursor-agent -p …` with the **default
`--output-format text`** (per ADR-0002 §2.2). `text` mode **buffers the entire
turn and emits it only on completion**, so each multi-minute step streamed
nothing until it ended, then dumped the whole summary at once. `claude -p` and
`codex exec` stream incrementally through the `script(1)` pseudo-TTY; cursor's
`text` mode does not. The `^D` / `^H` / `ESC[?25h` bytes were cursor's TUI
teardown chrome bleeding into the raw PTY capture.

A second, latent gap surfaced while investigating: there was **no per-run
wall-clock cap** anywhere (ticket #15). A run that *genuinely* hung would sit at
`running` forever — only the fleet-level circuit-breaker and a 2h dead-PID sweep
existed; the single, internally-looping run was unbounded.

## [2] Decision

**[2.1] Cursor headless runs use `stream-json`.** `engine-cmd.ts` now appends
`--output-format stream-json --stream-partial-output` to the cursor command
(refines ADR-0002 §2.2). Cursor then emits NDJSON deltas as they happen.

**[2.2] A pure decoder turns NDJSON back into human text.** New, dependency-free
`src/main/cursor-stream.ts` (`createCursorStreamDecoder()`, unit-tested like
`engine-cmd.ts` / `pipelines.ts`): buffers partial lines across chunks, strips
ANSI/control chrome, and renders only the incremental `assistant` text deltas
(events carrying `timestamp_ms`). It **skips** the cumulative-final `assistant`
snapshot and the `result` echo (both repeat the full text), skips `thinking` /
`user` / `system` noise, and emits a compact `· <type>:<subtype>` breadcrumb for
any other event (tool calls, future types) so the silent middle of a step shows
live progress. `agents.ts` pipes cursor stdout through one decoder per spawned
process; claude/codex/scripts pass through unchanged.

**[2.3] Per-run wall-clock watchdog (implements ticket #15).** Pure policy in
`src/main/run-watchdog.ts` (`planWatchdogTimers(softMs, hardMs)`), wired into
`runSpec` (in-process runs, skipping `inPlace` quick ops) and inlined into the
self-contained `bin/terminal-cron`. **Warn-only by default**: a soft cap
(`maxRunMs`, default 3h) logs a `[runtime cap]` line + error activity + HITL but
keeps the run alive; a hard SIGTERM fires **only** if the operator sets
`maxRunHardMs > 0` (worktree + commits always survive). This honors the
SIGKILL/token-cap rejections recorded for #0002/#0009 — flag, don't kill.

## [3] Tradeoffs & known limitations

- **`bin/terminal-cron` is not yet wired for cursor.** It is self-contained (no
  app-bundle imports) and currently has no `cursor` command branch at all
  (scheduled `engine: cursor` falls through to the `codex` builder), so neither
  the stream-json flags nor the decoder apply there. Tracked as ticket #0032.
  The watchdog *was* inlined into cron (claude/codex scheduled runs benefit).
- The decoder **drops `thinking` deltas** by design (reasoning spam) and
  attributes tool activity only as one-line breadcrumbs — it does not reconstruct
  cursor's rich TUI. Acceptable for a log.
- Non-text `assistant` content parts (e.g. `tool_use`) are breadcrumbed from
  whatever optional `type`/`name` fields exist; the exact part schema is inferred
  (not observed in a tool-running probe) and degrades gracefully.

## [4] What would change our mind

- If cursor's `text` mode gains incremental streaming on a TTY, the flags +
  decoder become unnecessary (revert to ADR-0002 §2.2's plain shape).
- This also lights up part of ADR-0002 §4: the `stream-json` `result` event
  carries a `usage` block (`inputTokens`/`outputTokens`/cache) — a future change
  could feed the cockpit's numeric gauges from it instead of leaving them empty.
- If warn-only proves too passive (real hangs pile up), promote a sensible
  default `maxRunHardMs` — but only with operator opt-in per #0002/#0009.

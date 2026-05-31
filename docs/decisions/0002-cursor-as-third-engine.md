---
id: 0002
title: Support Cursor (cursor-agent) as a third session engine
anchor: ADR-0002
status: accepted
date: 2026-05-31
supersedes:
superseded-by:
---

## [1] Context

TerMinal hosted two coding engines — Claude Code (`claude`) and Codex (`codex`)
— as a closed `Engine = 'codex' | 'claude'` union threaded through ~45 files.
Cursor ships a headless CLI agent, `cursor-agent`, that runs an interactive TUI
*and* a non-interactive `-p/--print` mode, supports `--model`, `--force`
(run-everything), `--workspace`, and `--resume/--continue`. Adding it as a
first-class engine lets the same factory loop (sessions, headless Agents,
Schedules, Factory) drive Cursor.

Two facts shaped the design:

- **The engine id is not the binary name.** `claude`/`codex` ids equal their
  executables; Cursor's id is `cursor` but the binary is `cursor-agent`.
- **Cursor's session store is opaque.** It mints its *own* chat id (we never get
  it back at launch) and stores each chat as **SQLite** at
  `~/.cursor/chats/<chatId>/<group>/store.db`. Only the `meta` row is reliably
  plaintext JSON (`name`, `lastUsedModel`, `mode`, `isRunEverything`,
  `createdAt`); the message tree is partially-binary blobs.

## [2] Decision

Add `'cursor'` to the engine union (`settings.EngineId`, `types.Engine`,
`agents.Engine`) and wire it everywhere Codex is wired: detection, interactive
launch, headless runs (Agents/Schedules/Factory/bg-tasks), the launch + model +
settings pickers, the session-engine logo, and onboarding.

Specifics worth the *why*:

- **[2.1] id→binary indirection.** `engineBinaryName()` (settings.ts) maps
  `cursor → cursor-agent`; everything else returns the id. `enginePath()`
  resolves through it, so callers stay engine-agnostic.
- **[2.2] Command shapes** live in a pure, injected-binary `engine-cmd.ts`
  (unit-tested, no electron deps): headless Cursor =
  `cursor-agent -p <prompt> --force --workspace <worktree> [--model]`. Interactive
  Cursor = `cursor-agent --force` (the run-everything equivalent of Codex's
  `danger-full-access`).
  - _Update 2026-05-31 (see ADR-0003):_ the **headless** shape now also appends
    `--output-format stream-json --stream-partial-output`. The default `text`
    format buffers the whole turn until completion, so live runs looked hung with
    empty logs; NDJSON deltas (decoded by `cursor-stream.ts`) now stream like
    claude/codex. Interactive shape unchanged.
- **[2.3] New-sessions-only in the picker.** We do **not** enumerate
  `~/.cursor/chats` for the resume list (Cursor mints its own id; the store is
  SQLite). Resume is handled by `cursor-agent`'s own `--resume/--continue` TUI
  inside the session. `listSessions()` stays Claude + Codex.
- **[2.4] Telemetry is meta-row-only, never fabricated.** The cockpit reads a
  Cursor session's **title + model + mode** from the chat's `meta` row via the
  `sqlite3` CLI (no native dep — same shell-out pattern as git/gh). The numeric
  gauges (context %, tokens, todos) stay **empty** rather than guessed, because
  that data is in partially-binary blobs we deliberately don't parse — honoring
  the repo's no-overclaimed-narration rule. The live chat is attributed by
  "newest `store.db` written at/after this session's launch" (cursor mints the
  id and the Cursor IDE may have other chats open).

## [3] Tradeoffs & known limitations

- Three `Engine` unions still exist (`settings`/`types`/`agents`); kept in sync
  rather than unified (out of scope for this change).
- Cursor **widens two existing gaps**: the wedged-session detector and the fleet
  "needs-me"/working-idle status are Claude-transcript-shaped, so Cursor
  sessions (like Codex) don't feed them yet.
- The telemetry attribution is a documented heuristic, and the `meta` schema is
  undocumented — both fail gracefully to empty stats on drift / `sqlite3`
  absence.

## [4] What would change our mind

If Cursor publishes a stable headless session-metadata path (or `--output-format
json` for live sessions exposes context/usage), replace the SQLite `meta`
heuristic with the official source and light up the numeric gauges.

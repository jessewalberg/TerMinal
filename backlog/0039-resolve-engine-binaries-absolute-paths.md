---
id: 39
title: "Resolve engine binaries to absolute paths at spawn time"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: low
horizon: next
hitl: false
type: bug
source: terminal-immediate-exit-investigation
created: 2026-06-04
updated: 2026-06-10
prs: []
refs: []
---

## Description
Engine sessions spawn via `zsh -l -c '<bare-name> …'` (src/main/index.ts:274) —
a NON-interactive login shell, which sources `~/.zprofile` but not `~/.zshrc`.
`~/.zshrc` is the only dotfile adding `~/.local/bin` to PATH, where `claude` and
`cursor-agent` live (`codex` survives via `/opt/homebrew/bin` from `~/.zprofile`).
Today the only thing keeping claude/cursor sessions alive is `fixPath()`'s
unconditional `~/.local/bin` fallback (src/main/env.ts:26) merged into
`process.env.PATH` at startup. If dotfiles, install locations, or the fallback
list drift, every claude/cursor session exits 127 instantly with only
"command not found" in the pane. Confirmed by direct repro under a GUI-bare PATH
during the 2026-06-04 immediate-exit investigation (root cause of that bug was
a stale cwd, fixed separately — this is the latent second failure mode).

## Acceptance criteria
- `startSession` resolves `enginePath(engine)` to an absolute path (reusing the
  existing `which`/`resolveBin` helpers in src/main/env.ts) before building the
  `zsh -l -c` command; bare names are no longer passed to the spawned shell.
- A unit test (injected lookup, no real fs) asserts claude/cursor-agent resolve
  to absolute paths even when the ambient PATH lacks `~/.local/bin`.
- When resolution fails entirely, the pane shows a clear "engine binary not
  found" message instead of the shell's bare exit-127.

## Design notes
`enginePath()` (src/main/settings.ts:329) returns the configured path or the
bare binary name. Resolution should happen at spawn (binary may be (re)installed
while the app runs), not cached at startup. An explicitly configured
`engines.*.path` should be used as-is.

# CLAUDE.md — TerMinal

<!-- Loaded on top of global ~/.claude/CLAUDE.md (§1–11). Don't restate global
     rules here — reference them as "global §N". Keep this lean. -->

TerMinal is a standalone macOS Electron app that hosts Claude Code / Codex CLI
sessions with a software-factory layer on top: tabs for tickets, MRs, scheduled
agents, runs, HITL, docs, and per-session plugin widgets. See
[`README.md`](./README.md) and [`docs/architecture.md`](./docs/architecture.md).

**Status:** Shipped, actively iterating. Daily-driver tool — Trevor uses it as
the primary terminal across every other project in `~/CompSci/gauntlet/`.

## TerMinal is direct-to-main (override of global §8)

Global §8 forbids agent merges to main. **TerMinal is a vibe-coded personal
project listed in the `feedback_gauntlet_repos_direct_main` exception** — agents
may commit and push directly to `main` here. The `block-main-merge.sh` hook is
intentionally NOT wired in `.claude/settings.json` (the hook file is kept under
`.claude/hooks/` in case the policy ever flips).

This applies ONLY to TerMinal (and `project-template`). Work that targets sibling
managed repos from inside a TerMinal session still follows the full PR + human-
merge flow per global §8.

## Commands

```bash
bun install               # at repo root
bun run dev               # dev server with HMR
bun run release           # FULL rebuild → sign → reinstall /Applications/TerMinal.app
bun test                  # 97 tests, ~30ms
bunx tsc --noEmit         # typecheck
```

**Rule: after any substantive change, run `bun run release`.** Dev HMR is
secondary — the installed `/Applications/TerMinal.app` is what the user
actually uses; an out-of-date binary silently produces stale behavior. (See
`feedback_gauntlet_terminal_restart_dev`.)

## Architecture pointers

- `src/main/` — Electron main: IPC handlers, agents runtime, schedules, settings.
- `src/renderer/src/tabs/` — one folder per tab. Each tab exports a `Tab` spec
  with `appliesTo` + `Component` + optional `badge`.
- `src/renderer/src/lib/nav.ts` — cross-tab navigation bus
  (`navigateTo(tabId, payload?)`). Used for HITL → Runs, Activity → Tickets, etc.
- `bin/terminal-cron` — the headless runner launchd fires. Self-contained Bun
  script; reads `~/.config/TerMinal/schedules.json`.
- `bin/terminal-cli` — helper script exposed inside agent `.sh` bodies for
  ticket/hitl/activity/notify/state subcommands.
- `~/.config/TerMinal/` — runtime state (schedules, cron-runs, agent-state,
  hitl, settings). Use Settings → Open TerMinal config dir to inspect.

## Conventions specific to this repo

- **ESM main.** `src/main/index.ts` bundles to ESM at build time. `__dirname`
  and `require` throw at runtime. Use `fileURLToPath(import.meta.url)`. After
  release, verify the packaged binary actually opens a window (stderr free of
  `ReferenceError`). See `learnings_gauntlet_terminal_esm_main_dirname`.
- **No silent narration.** This is a UI app; user-visible messages come from
  the tabs themselves. Don't add `console.log` for "feedback" — wire to the
  Activity feed via `emitActivity` if it's worth surfacing.
- **Tab order matters.** Lower `order:` numbers come first. The current
  ordering is Terminal (0) → Tickets (1) → MRs (2) → Agents (3) → Runs (3.45)
  → Schedules (3.5) → CI (3.55) → Factory (3.6) → Reports (3.62) →
  Triage (3.65) → Browser (3.7) → HITL (4) → Activity (5) → Docs (5.5) →
  Sessions (6) → Notes (7) → Files (8) → Help (9). Keep `order:` values
  distinct — equal values fall back to an alphabetical tie-break.

## Where to read before touching X

| You're touching | Read |
|---|---|
| A new IPC | `src/main/index.ts` (handler) + `src/preload/index.ts` + `src/renderer/src/lib/types.ts` (Gt API surface) — all three must agree |
| Agent runtime | `src/main/agents.ts` is the heart; `runSpec` is the spawn entry |
| Schedules | `src/main/schedules.ts` + `bin/terminal-cron` — keep state shapes in sync |
| Per-(repo, agent) state | `.agents/scripts.md` in `project-template` — the canonical convention doc |
| Run records | `src/main/cron-runs.ts` (cron) + `agents.ts` (in-process) — `UnifiedRun` type bridges both for the Runs tab |

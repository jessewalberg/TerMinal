# AGENTS.md — TerMinal

Instructions for AI coding agents working in this repo (Claude Code loads
this via CLAUDE.md's `@AGENTS.md`; Cursor and Codex read it natively).

## Operating model

This repo is canonical for its own **decisions** (`docs/decisions/`), **work
queue** (`backlog/*.md`), and **learnings** (`docs/learnings/`) — committed with
the code so agents read them in-context.

- This repo is **public**: never commit secret values *or* secret key names.
  Secrets are 1Password-only; key-name references live in a private store, not
  in this repo.
- Durable conclusions from a work item graduate to `docs/decisions/` on close.

## Project

TerMinal is a standalone macOS Electron app: a software factory that hosts the
real Claude Code and Codex CLIs (many sessions as top tabs, each in its own
PTY) and wraps them in an observable build loop (backlog → branch → PR →
review → human merge). Repo-aware tabs (tickets, MRs, Factory orchestrator,
Schedules via launchd cron, HITL inbox, cycle-time, notes, files) sit around a
persistent terminal. Local-first: state lives in `~/.config/TerMinal` +
in-repo `.reviews/`. Shipped and actively iterating; used as the daily-driver
terminal across the portfolio. Stack: Bun, Electron, React/TS. Deep knowledge
lives in the vault wiki and `docs/architecture.md`.

```bash
bun install            # at repo root
bun run dev            # dev server with HMR (secondary surface)
bun run release        # full rebuild → sign → reinstall /Applications/TerMinal.app
bun test               # full suite (~30ms)
bunx tsc --noEmit      # typecheck
```

**After any substantive change, run `bun run release`.** The installed
`/Applications/TerMinal.app` is what the user actually runs; dev HMR is
secondary, and a stale binary silently produces stale behavior.

## Branching: direct-to-main (override of global policy)

TerMinal is a vibe-coded personal project in the direct-to-main exception
list — agents may commit and push directly to `main` here. This applies ONLY
to TerMinal (and `project-template`). Work that targets sibling managed repos
from inside a TerMinal session still follows the full PR + human-merge flow.

## Architecture pointers

- `src/main/` — Electron main: IPC handlers, agents runtime, schedules,
  settings. Bundles to **ESM**: `__dirname`/`require` throw at runtime — use
  `fileURLToPath(import.meta.url)`. After release, verify the packaged binary
  opens a window (stderr free of `ReferenceError`).
- `src/renderer/src/tabs/` — one folder per tab; each exports a `Tab` spec
  (`appliesTo` + `Component` + optional `badge`). **Tab order matters:** lower
  `order:` comes first and values must stay distinct (equal values tie-break
  alphabetically). Current order: Terminal 0 → Tickets 1 → MRs 2 → Agents 3 →
  Runs 3.45 → Schedules 3.5 → CI 3.55 → Factory 3.6 → Reports 3.62 →
  Triage 3.65 → Browser 3.7 → HITL 4 → Activity 5 → Docs 5.5 → Sessions 6 →
  Notes 7 → Files 8 → Help 9.
- `src/renderer/src/lib/nav.ts` — cross-tab navigation bus
  (`navigateTo(tabId, payload?)`), used for HITL → Runs, Activity → Tickets, etc.
- `bin/terminal-cron` — headless runner launchd fires; self-contained Bun
  script reading `~/.config/TerMinal/schedules.json`.
- `bin/terminal-cli` — helper exposed in agent `.sh` bodies for
  ticket/hitl/activity/notify/state subcommands.
- `~/.config/TerMinal/` — runtime state (schedules, cron-runs, agent-state,
  hitl, settings); inspect via Settings → Open TerMinal config dir.

## Conventions specific to this repo

- **No silent narration.** This is a UI app; user-visible messages come from
  the tabs. Don't add `console.log` for "feedback" — wire it to the Activity
  feed via `emitActivity` if it's worth surfacing.

## Where to read before touching X

| You're touching | Read |
|---|---|
| A new IPC | `src/main/index.ts` (handler) + `src/preload/index.ts` + `src/renderer/src/lib/types.ts` (Gt API surface) — all three must agree |
| Agent runtime | `src/main/agents.ts` is the heart; `runSpec` is the spawn entry |
| Schedules | `src/main/schedules.ts` + `bin/terminal-cron` — keep state shapes in sync |
| Per-(repo, agent) state | `.agents/scripts.md` in `project-template` — the canonical convention doc |
| Run records | `src/main/cron-runs.ts` (cron) + `agents.ts` (in-process) — `UnifiedRun` type bridges both for the Runs tab |

---
id: 0005
title: CI webhook shim lives in dashboard/, intelligence in ci-watchdog.sh
anchor: ADR-0005
status: accepted
date: 2026-05-31
supersedes:
superseded-by:
---

## [1] Context

Ticket #0005 needs a GitLab/GitHub pipeline webhook receiver that spawns a
self-healing CI agent. TerMinal is an Electron app with no built-in HTTP server;
the harness already conceptually runs a small dashboard on `:4848` for cross-repo
state.

## [2] Decision

- **App surface (~40 lines):** `dashboard/src/server.ts` — one Hono route
  `POST /api/ci-webhook/:repo`, signature verify, detached spawn of
  `.agents/ci-watchdog.sh`. No classification or autofix logic in app code.
- **Config:** per-repo `ci_webhook_secret` + `root` in `<harnessDir>/prs/config.yml`.
- **Intelligence:** `.agents/ci-watchdog.sh` — log fetch, classify (heuristics +
  optional haiku), dry-run mode via `~/.config/TerMinal/ci-watchdog.json`,
  allowlist (`prettier-formatting` only at v0), per-MR fix cap via
  `terminal-cli state`.
- **Process model:** standalone Bun server; TerMinal main spawns it on launch
  when config exists (`ci-webhook-launcher.ts`). Curl-testable without Electron.
- **Packaging:** `dashboard/src/` ships via `electron-builder` `extraResources`;
  Bun resolves `hono` from the app bundle root (`app.getAppPath()` as cwd).

## [3] Consequences

- Webhooks only arrive while TerMinal (or a manually started dashboard) is
  listening — acceptable for v0 personal harness; launchd-backed always-on
  dashboard is a follow-up if needed.
- Request bodies are capped at **256 KiB** — pipeline webhook JSON is tiny;
  the limit prevents accidental memory exhaustion from malformed clients.
- The server binds **127.0.0.1** only — webhooks are harness-local, not
  exposed to the LAN.
- Allowlist tuning is script-only; no app redeploy to broaden auto-fix classes.
- Telegram `/ci` and HITL buttons come free from existing activity/HITL plumbing.

## [4] Conflicts resolved

- **C1 — dashboard vs Electron IPC:** chose minimal HTTP shim in `dashboard/`
  rather than adding webhook IPC to main, so GitLab can POST from the network
  without Electron-specific wiring.

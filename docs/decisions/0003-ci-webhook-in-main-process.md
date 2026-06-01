---
id: 0003
title: CI webhook receiver lives in Electron main, not a separate dashboard
anchor: ADR-0003
status: accepted
date: 2026-05-31
supersedes:
superseded-by:
---

## [1] Context

Ticket #0005 originally scoped a GitLab pipeline webhook on a standalone
`dashboard` Hono server (`:4848`). TerMinal has no separate dashboard package —
the Electron app **is** the harness UI and already runs while the operator works.
A second HTTP server would duplicate process lifecycle, config, and spawn wiring.

## [2] Decision

Implement `POST /api/ci-webhook/:repo` as a **127.0.0.1-only** Node
`http.createServer` in `src/main/ci-webhook.ts`, started from `app.whenReady()`.
Default port **4848** (unchanged from the ticket — GitLab webhooks tunnel or
reach localhost via the operator's existing setup).

Per-repo secrets and roots load from `<harnessDir>/prs/config.yml` (`repos.<slug>.
ci_webhook_secret` + `root`), with fallback
`~/.config/TerMinal/ci-webhook-repos.json` when `harnessDir` is unset.

Auth accepts GitLab's `X-Gitlab-Token` (plain secret) or `X-Hub-Signature-256`
(HMAC-SHA256 body) for compatibility.

All intelligence stays in `.agents/ci-watchdog.sh` (classify, dry-run, autofix,
HITL, fix cap). The app surface only verifies, filters `pipeline`+`failed`, and
spawns the script detached with `CI_*` env vars.

## [3] Consequences

- GitLab must target `http://127.0.0.1:4848/api/ci-webhook/<repoSlug>` while
  TerMinal is open (or via a tunnel the operator controls). No cloud receiver.
- Dry-run defaults **on** until `~/.config/TerMinal/ci-watchdog.json` sets
  `"dryRun": false` — stage 2/3 of the ticket rollout.
- Request bodies are capped at **256 KiB** — pipeline webhook JSON is tiny;
  the limit prevents accidental memory exhaustion from malformed clients.
- If a future fleet dashboard ships, it should **delegate** to this module or
  share `ci-webhook-config.ts`, not fork the spawn logic.

## [4] Conflicts resolved

- **C1 — Hono vs Node http:** chose Node built-in (~40 lines, no new dep).
- **C2 — claude vs terminal-cli classify:** script uses free heuristics first,
  `claude -p haiku` only when heuristic returns `ambiguous`.

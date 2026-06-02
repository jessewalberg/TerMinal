---
id: 0008
title: Where to store the Google Search Console service-account key for the seo-content-decay agent
anchor: ADR-0008
status: needs-resolution
date: 2026-06-02
owner: Jesse
area: security / credentials / growth agents
confidence: low
supersedes:
superseded-by:
---

## [1] Context

The `seo-content-decay` agent queries the Google Search Console (GSC)
API to detect pages whose click/impression trends are decaying. GSC
requires OAuth 2.0 service-account credentials: a long-lived JSON key
file (or equivalent) issued by Google Cloud IAM.

This is a **new credential trust boundary** for the TerMinal portfolio.
Unlike short-lived tokens refreshed per-session or secrets injected at
CI time, a GSC service-account key:

- Is long-lived (does not expire unless rotated or revoked).
- Grants read access to potentially sensitive analytics data for every
  property delegated to it.
- Must be available to a headless cron agent (`bin/terminal-cron`) that
  runs on the user's machine without an interactive UI prompt.
- Should not be committed to any repository.

No decision has been made yet. Owner input is required before the agent
can be wired up.

## [2] Options considered

### Option A — 1Password secret reference + runtime fetch

Store the key JSON in a 1Password vault item. The agent shell body
calls `op read "op://vault/item/field"` at runtime to retrieve the
credential, caching it in memory for the process lifetime.

Pros: single authoritative store; 1Password audit log; easy rotation;
no plaintext at rest on disk; works well with the existing
`terminal-cli` / `bin/terminal-cron` pattern.

Cons: requires 1Password CLI (`op`) to be installed and signed in on
the machine running the agent; adds a runtime dependency; cron runs
may fail silently if the 1P session has expired.

### Option B — macOS Keychain

Store the key JSON as a Keychain item (`security add-generic-password`).
The agent retrieves it via `security find-generic-password -w`.

Pros: native to macOS; no third-party dependency; access requires the
user's login session; integrates with macOS permission prompts.

Cons: not portable across machines or to CI; Keychain access from a
non-GUI process (launchd cron) may require additional entitlements;
JSON blobs in Keychain are less ergonomic than 1Password vault items.

### Option C — Environment variable only

Inject `GSC_SERVICE_ACCOUNT_JSON` (the full key JSON, base64-encoded
or raw) as an environment variable in `~/.config/TerMinal/settings.json`
or a sourced `.env` file.

Pros: simplest implementation; no external dependency; trivially
consumed by the agent.

Cons: plaintext credential at rest on disk in a config file; risk of
accidental inclusion in backups, sync, or shell history; no audit
trail; rotation requires manual file edit.

### Option D — Encrypted state file

Store the key JSON encrypted at rest in
`~/.config/TerMinal/agent-state/` using a machine-local key
(e.g., derived from macOS Secure Enclave or a Keychain-stored AES key).
TerMinal would provide a `terminal-cli credentials set/get` subcommand
to manage it.

Pros: co-located with other agent state; portable within the TerMinal
toolchain; encryption at rest without external dependency.

Cons: requires building a new credentials subsystem in TerMinal; most
complex option; the encryption key must itself be stored somewhere
(likely Keychain — making this a superset of Option B).

## [3] What is needed to resolve this

- Owner decision on acceptable risk posture for a long-lived GSC key
  on a developer workstation.
- Confirmation of whether 1Password CLI is available and signed in
  during headless launchd cron runs (determines Option A viability).
- Decision on whether TerMinal should grow a generic credentials
  management layer (Option D) or delegate entirely to an external
  store.

## [4] What would change our mind

- If cron agents run in a CI environment (not just local macOS), the
  macOS-specific options (B, D-via-Keychain) become non-viable and the
  decision narrows to A or C.
- If TerMinal adds a secrets/credentials subsystem for other agents
  (e.g., Slack tokens, GitHub PATs), Option D becomes the clear
  winner by consolidation — rebuild once, reuse everywhere.
- If the GSC property is low-sensitivity (public traffic data only),
  the risk of Option C may be acceptable as a temporary measure
  pending a proper credentials store.

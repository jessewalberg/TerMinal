---
id: 28
title: "Encrypt Telegram/OpenRouter/Cloudflare secrets at rest via safeStorage"
status: closed
priority: medium
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-05-31
prs: []
refs: []
---

## Why
`patchSettings` writes the Telegram token, chatId, OpenRouter key (and now the Cloudflare token) to settings.json in plaintext via `writeFileSync`. The Telegram chatId+token pair authorizes remote agent spawn/cancel — a real auth-boundary exposure (tempered: single-user local macOS; secrets revocable).

## Recommendation
Wrap the secret fields in Electron `safeStorage` in settings.ts only: on write, if `isEncryptionAvailable()` encrypt to base64 with an `"enc:"` prefix; on read, decrypt `"enc:"`-prefixed values, pass plaintext through unchanged (existing files keep working, upgrade on next write). Inject a fake safeStorage so settings.test.ts covers round-trip + passthrough.

_Severity medium · effort small · from the 2026-05-31 fit/gaps analysis._

---

### Done — 2026-05-31

Implemented in settings.ts: `sealSecrets`/`openSecrets` (pure, injected crypto,
unit-tested for round-trip + legacy-plaintext passthrough + empty-skip), an
`initSecretSealer(safeStorage)` wired at app-ready in index.ts (kept electron
out of settings.ts imports so it stays test-safe + ESM-safe). Secret paths
sealed: `telegram.botToken`, `telegram.chatId`, `openrouter.apiKey`,
`cloudflare.apiToken` (identifiers like `accountId` stay plaintext). In-memory
Settings remain plaintext; only the on-disk file is `enc:`-prefixed base64.
Existing plaintext files keep working and upgrade on the next write. Falls back
to plaintext if `isEncryptionAvailable()` is false. 147 pass, released.


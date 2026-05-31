---
id: 28
title: "Encrypt Telegram/OpenRouter/Cloudflare secrets at rest via safeStorage"
status: open
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

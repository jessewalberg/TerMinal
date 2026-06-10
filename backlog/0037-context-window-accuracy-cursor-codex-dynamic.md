---
id: 37
title: "Context-window accuracy: cover cursor + codex models, optional dynamic harness sourcing"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: medium
horizon: next
hitl: false
type: dx
source: session-2026-06-02 (opus-4-8 showed 200k cap in Context Window plugin)
created: 2026-06-02
updated: 2026-06-10
prs: []
refs: []
depends_on: []
---

## Problem
Follow-up to the quick-fix in `43562d4`, which unified `data.ts`'s context-window
sizing onto `ai-pricing.ts`'s `lookupPrice().contextWindow` (fixing Opus 4.8
showing a 200k cap instead of 1M). That fix addressed Claude models, but two
gaps remain:

- **Cursor is unrepresented.** `ai-pricing.ts` has no `'cursor'` family and no
  composer rows, so every cursor model falls to the `ZERO` row → silent 200k cap
  + $0 cost. cursor-agent only reports a friendly name ("Composer 2.5 Fast") and
  often *proxies* an underlying model, so a table needs name normalization and
  ideally underlying-model resolution. (`data.ts:527` notes cursor "numeric
  widgets stay empty".)
- **Codex rows may be stale/incomplete.** Table has gpt-5 / gpt-5-codex /
  gpt-5-mini (400k) + o4-mini; audit against models actually run (gpt-5.1, o3, …).

## Why static, not provider-API dynamic
Neither Anthropic's nor OpenAI's `/v1/models` endpoint returns context length, so
context windows cannot be *fetched* from the providers — a maintained table is
required regardless.

## The one genuinely-dynamic source (Claude only)
Claude Code's statusline hook stdin carries `.context_window.context_window_size`
and `.context_window.used_percentage` (v2.1.x+) — the authoritative live window.
`~/.claude/statusline-command.sh` already uses it. The TerMinal plugin can't:
it parses the transcript `.jsonl`, which does **not** carry `context_window`
(confirmed — only `message.model` + `usage`). To make the plugin truly dynamic
+ future-proof against new model ids, wire a tiny statusline hook that writes
`context_window_size` to a per-session sidecar the plugin reads, falling back to
the table. (Optional / nice-to-have.)

## Acceptance
- Cursor sessions show a correct context cap + cost (composer rows + a `'cursor'`
  family; friendly-name normalization; underlying-model resolution if feasible).
- Codex model rows audited against models in actual use.
- (Optional) Plugin prefers the harness's real `context_window_size` for Claude
  sessions via a statusline-hook sidecar, table as fallback.
- Tests cover cursor + codex + the sidecar precedence.

## Notes
- Single source of truth is now `ai-pricing.ts`; extend the table there, not in
  `data.ts`.
- Keep the upward self-correct in `contextLimitFor` as the unknown-model net.

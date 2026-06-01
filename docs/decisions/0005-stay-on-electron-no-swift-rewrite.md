---
id: 0005
title: Stay on Electron — do not rewrite TerMinal in native Swift (optimize Electron instead)
anchor: ADR-0005
status: proposed
date: 2026-06-01
owner: Trevor
supersedes:
superseded-by:
---

## [1] Context

The maintainer asked whether porting TerMinal (a ~28.5K-LOC Electron + React 19 +
TypeScript macOS app) to native Swift (AppKit/SwiftUI) would improve
maintainability and resource usage enough to be worth it. A multi-agent audit
(see `docs/AUDIT-2026-06-01.md`) evaluated the question across four facets:
stack mapping, resource delta, port effort, and an adversarial risk check.

Key facts established:

- **Resource delta is real but modest for this user.** The installed app idles
  at ~246 MB RSS / 4 processes / 281 MB bundle (232 MB Chromium + 47 MB asar). A
  native cockpit would idle ~60-130 MB, ship ~15-40 MB, and cold-start in
  ~80-300ms vs ~1-4s. Net ≈ 120-180 MB RAM (2-4x) and ~7-15x disk saved, plus a
  qualitative input-latency/throughput win. On a 16 GB+ Mac these sit in the
  noise; idle CPU is ~0% either way. *(One-shot local measurement — indicative.)*
- **Effort ≈ 22-34 person-weeks (≈5.5-8.5 months solo).** The 18 React tabs →
  SwiftUI (8-12pw, zero reuse) and the agent runtime + run logging/streaming
  (4-6pw, highest drift risk) dominate.
- **Most pillars map cleanly to mature Swift libraries** — terminal+PTY →
  SwiftTerm, syntax highlighting → Highlightr, MCP → official swift-sdk, launchd
  → native, git/gh/Telegram → `Process`/`URLSession`, file-state → `Codable`.
  Only two have no clean equivalent: the **full 18-tab UI rewrite** (highest
  risk, no shortcut, no Tailwind analog) and a **CodeMirror-grade diff/merge
  editor** (must be hand-built).
- **The decisive factor is iteration velocity, not effort.** TerMinal is
  explicitly an AI-/vibe-coded, direct-to-main, actively-iterating solo
  daily-driver; its fuel is high-velocity AI codegen. LLM one-shot success for
  SwiftUI is materially lower than for TS/React, so a port imposes a *permanent
  ~1.5-2x tax on every future change*. The benefits a rewrite "buys" (type
  safety, build stability) this codebase already has — `tsc` clean, 193 tests in
  ~220ms, stable `bun`+`electron-vite`, no SSR/CSS-in-JS hairball.

## [2] Decision

**[2.1] Do not undertake a full native-Swift rewrite.** The resource savings do
not justify ~6+ months of zero-feature work plus a permanent velocity tax on a
solo, AI-iterated tool that is already healthy and shipped.

**[2.2] Optimize the Electron app instead** — pursue the audit's verified
high-severity items, which remove the actual maintenance drag at S/M effort:
- Close the 3-layer IPC seam (compile-time `Gt`↔`GtApi` guard + shared
  `channels.ts`).
- De-duplicate `bin/terminal-cron`'s forked pricing/ledger/HITL/sweep into a
  dependency-free shared module (it has already drifted).
- Fix the fleet transcript-reparse thrash (per-session `tCache` Map; tail-derive
  fleet status).
- Add a test seam to `runSpec`.

**[2.3] If native craft is ever wanted, go incremental behind the existing IPC**
(e.g. a SwiftTerm-backed terminal pane), not a big-bang rewrite. The file-based
state model under `~/.config/TerMinal` is portable and could be shared.

## [3] Tradeoffs & known limitations

- We forgo the native resource/latency wins (lower RAM, instant launch, Metal
  terminal rendering). Accepted: they don't move the needle for a single-user
  modern Mac, and the audit found the worst *app-introduced* costs
  (transcript-reparse, per-chunk re-render) are fixable in Electron anyway.
- The maintainability claim (§1, the load-bearing one) rests on published
  SwiftUI-vs-TS codegen benchmarks plus the project's stated iteration model;
  confidence is medium (~0.78), not high.
- Electron keeps its inherent footprint (one renderer + node-pty per session)
  and the web-build surface (CodeMirror dedupe quirk, native-module rebuilds).

## [4] What would change our mind

- **Felt performance becomes a primary goal.** If input latency / throughput
  under fast agent output becomes something the maintainer will trade months
  for, a SwiftTerm-based native terminal (incremental, §2.3) becomes attractive.
- **AI codegen for SwiftUI reaches TS/React parity.** This would erase the
  velocity tax that is the main argument against porting — re-evaluate then.
- **The app stops actively iterating** (feature-complete, maintenance mode). A
  rewrite's velocity cost mostly disappears once you're no longer shipping
  features weekly, shifting the calculus toward native polish.
- **A second platform is wanted.** macOS-only is the current reality; if Linux
  support were ever desired, neither Swift nor a from-scratch rewrite is the
  path — that argues to *stay* on Electron, not port.

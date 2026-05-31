---
id: 18
title: "Keyboard navigation: Cmd+number quick-switch (+ later Cmd+K palette)"
status: open
priority: medium
horizon: next
hitl: false
type: ux
source: analysis
created: 2026-05-31
updated: 2026-05-31
prs: []
refs: []
---

## Why
No Cmd+K palette, no `globalShortcut`, no number-key switching — workspace/session/tab switching is entirely onClick in a horizontally-scrolling bar that grows with every workspace.

## Recommendation
Ship the cheap slice first: one document-level keydown in App.tsx — Cmd+1..9 → activate that workspace's first session, Cmd+Shift+[ / ] to cycle workspaces, and in SessionView Cmd+1..9 → setActiveTab. Extract `resolveWorkspaceHotkey`/`resolveTabHotkey` as pure helpers for a unit test. Defer the full fuzzy Cmd+K palette.

_Severity medium · effort medium · from the 2026-05-31 fit/gaps analysis._

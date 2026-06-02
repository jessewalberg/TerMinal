---
id: 19
title: "In-terminal scrollback find (Cmd+F) + larger scrollback"
status: closed
priority: medium
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-06-02
prs: []
refs: []
---

## Why
`@xterm/addon-search` is absent and Cmd+F is never intercepted; sessions stay mounted for long stretches by design, so buffers grow long and you can't find an error/diff/command in your own output.

## Recommendation
Add `@xterm/addon-search`, load it in TerminalPane next to FitAddon, add a small Cmd+F overlay calling `findNext/findPrevious` on the active pane (guard so it doesn't steal Cmd+F from the Files tab), and bump scrollback from the 1000-line default to ~10000. Defer cross-session transcript search.

_Severity medium · effort small · from the 2026-05-31 fit/gaps analysis._

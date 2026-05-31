---
id: 9
title: "Stuck-session detection: crash-loop watcher (agent) + wedged-session detector (app)"
status: open
priority: medium
horizon: next
hitl: false
type: feature
source: research
created: 2026-05-30
updated: 2026-05-30
prs: []
refs: []
depends_on: [0001]
---

Refactored into two clearly separated parts. The crash-loop half is
a pure agent script (reads the run ledger from #0001). The
wedged-session half is genuinely app-shaped because it needs PTY
buffer + fs-write tracking that lives in main.

## Part A — Crash-loop watcher (PURE AGENT)

`.agents/crash-loop-watcher.sh` — runs hourly via cron:

```bash
#!/usr/bin/env bash
set -uo pipefail

# Reads the ai-runs/ ledger from #0001 (or cron-runs/ for now)
# Computes failures per schedule in the last 10 minutes
# If > 3 failures AND > 50% fail rate: file HITL + optionally auto-pause

runs=$(find ~/.config/TerMinal/cron-runs -name "*.json" -mmin -20 -print0 | \
  xargs -0 -I{} jq -c '{scheduleId, agentTitle, status, startedAt}' {} 2>/dev/null)

echo "$runs" | jq -s 'group_by(.scheduleId) | map({
  scheduleId: .[0].scheduleId,
  agentTitle: .[0].agentTitle,
  total: length,
  failed: (map(select(.status == "failed")) | length)
}) | map(select(.total > 3 and (.failed / .total) > 0.5))' | \
jq -c '.[]' | while read row; do
  agent=$(echo "$row" | jq -r '.agentTitle')
  sched=$(echo "$row" | jq -r '.scheduleId')
  count=$(echo "$row" | jq -r '.failed')
  terminal-cli hitl "Crash-loop · $agent" \
    "$count failures in 20m. Auto-paused. Re-enable in Schedules tab."
  # Pause via the disabled.json file (existing mechanism)
  ...
done
```

No app code at all. Reads existing on-disk state, files HITL via the
existing helper.

## Part B — Wedged-session detector (APP — small)

This one genuinely needs to live in `src/main/` because it requires:
- PTY output buffer tail per session (already exists in
  `src/main/`'s session map)
- PID-scoped file-write detection (poll `lsof -p <pid>` every 30s)
- User-input timestamp tracking (already tracked for snippets)

### Detection rule

A session is **stuck** when ALL THREE are true:
1. No novel PTY output in > N minutes (heartbeat patterns excluded —
   Claude's `✻/✼/✽/✾/✿` glyph, Codex's spinner frames)
2. No fs writes from this PID in > N minutes
3. Last user input > N minutes ago

Defaults: `N = 5 min`. Configurable in Settings.

The conjunction matters: output but no writes = streaming answer
(alive); writes but no output = background tool (alive); typing =
human engaged (don't alert).

### Surface

- Session sub-bar pill in the Terminal tab: amber dot on stuck panes
  (alongside the existing green/red pulse)
- Telegram ping (once per detection, not repeated): "🪤 Wedged:
  vellum-project · S2 · '<first-prompt>' stuck for 6m"
- Activity event `kind: blocked` so it shows in Activity tab

No HITL on this side — wedged-session is one-off, not durable.

### Implementation

- Per-session state in the existing `sessions` map: `{ lastOutputAt,
  lastHeartbeatAt, lastInputAt }`
- New `lsof`-poll loop on a 30s cadence per pane
- Heartbeat patterns matched against the existing PTY output stream

Probably ~150 lines in `src/main/`.

## App scope summary

- Crash-loop watcher: **0 app code.** Pure agent script in
  project-template.
- Wedged-session detector: **~150 lines in `src/main/`** + a small
  amber-dot in the Terminal sub-bar.

## Stage plan

**Stage 1** — Author the crash-loop agent script (in project-template).
Schedule it on the harness. Zero risk; reads existing data.

**Stage 2** — Wedged-session detection in `src/main/`. Dry-run for a
week (just log to activity, no Telegram).

**Stage 3** — Flip Telegram pings on for the wedged detector.

## Non-goals

- No auto-SIGKILL of stuck sessions
- No cross-session wedge correlation
- No alerting in focused-app context (always run regardless)

## Risk

- Crash-loop: zero (data-driven, no false positives possible)
- Wedged: medium — heartbeat pattern matching could miss Opus
  thinking long. Mitigated by the conjunction + tunable thresholds +
  dry-run week.

---

### Update — 2026-05-31 (analysis findings)

The wedged-session detector is still **Claude-only** (scans only
`~/.claude/projects`, never `~/.codex/sessions`), keys on a repeated error
signature (so confidently-wrong productive loops never trip), and surfaces
only a HITL/activity row — the specced amber sub-bar dot (Stage 2) was never
built. 80/20 next steps: (1) also scan `~/.codex/sessions` (biggest blind
spot; reuse the Codex jsonl parser); (2) cache `WedgedSession[]` + a
`fleet:wedged` IPC so SessionView/FleetView render an amber in-pane dot.
Note: the new `awaiting` fleet state (ticket #31) is adjacent but distinct —
it flags permission-gates/questions, not crash loops.

---
id: 10
title: "Worktree reaper: agent script + HITL surface (no dashboard panel)"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: medium
horizon: next
hitl: false
type: feature
source: research
created: 2026-05-30
updated: 2026-06-10
prs: []
refs: []
depends_on: []
---

> **Update 2026-06-02:** The core `.agents/worktree-reaper.sh` (+ sidecar)
> shipped to the `project-template` submodule (`4fa1d94`, direct-to-main on the
> fork). Deterministic, smoke-tested (stale detection, MIN_STALE gate, `--reap`
> safety). Remaining (optional): the ~15-line Telegram `/reap` command in
> `src/main/telegram.ts`, and wiring a daily schedule via `/new-schedule`.

Refactored: this is a `.agents/worktree-reaper.sh` script. No
dashboard panel, no IPC. When stale worktrees accumulate, the
script files a single HITL item with the count + disk size + a
one-liner reap command. User can reap manually or auto-reap by
re-running with a flag.

**Filter applied:** the agent has full access to the existing
helpers and the file system. The dashboard panel I proposed earlier
was over-engineering.

## The script

`.agents/worktree-reaper.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

# Scan every managed repo's .worktrees/ dir
# Classify: live / idle / stale / orphan
# Reap action: rm -rf + git worktree prune (guarded by uncommitted check)

WORKTREES_ROOT="${WORKTREES_ROOT:-$HOME/CompSci/gauntlet/.worktrees}"
[ -d "$WORKTREES_ROOT" ] || exit 0

stale=0
stale_bytes=0
stale_list=""

for wt in "$WORKTREES_ROOT"/*/*/; do
  [ -d "$wt" ] || continue
  # Skip if a live cron run owns it (read cron-runs/ JSON)
  worktree_path=$(realpath "$wt")
  if jq -e --arg w "$worktree_path" \
       '.worktree == $w and .status == "running"' \
       ~/.config/TerMinal/cron-runs/*.json 2>/dev/null | grep -q true; then
    continue  # live
  fi
  # Get age + size
  last_commit=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
  age_days=$(( ($(date +%s) - last_commit) / 86400 ))
  size=$(du -sk "$wt" | cut -f1)
  if [ "$age_days" -gt 14 ]; then
    stale=$((stale + 1))
    stale_bytes=$((stale_bytes + size))
    stale_list+="$wt ($age_days d, $((size / 1024)) MB)\n"
  fi
done

if [ "$stale" -gt 5 ]; then
  reclaim_mb=$((stale_bytes / 1024))
  terminal-cli hitl "Worktree cleanup · $stale stale" \
    "Reclaim ~$reclaim_mb MB:\n\n$stale_list\nRun: \
.agents/worktree-reaper.sh --reap"
fi

# If invoked with --reap, actually delete them
if [ "${1:-}" = "--reap" ]; then
  echo "$stale_list" | while read line; do
    wt=$(echo "$line" | awk '{print $1}')
    [ -d "$wt" ] || continue
    # Safety: don't reap with uncommitted changes
    if [ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
      git worktree remove "$wt" 2>/dev/null || rm -rf "$wt"
    fi
  done
  # Prune across every repo's git dir
  for r in ~/CompSci/gauntlet/*/.git; do
    git -C "$(dirname "$r")" worktree prune
  done
fi
```

That's it. Cron the report mode daily; reaping is a one-shot manual
invocation.

## Telegram

`/reap` — runs `.agents/worktree-reaper.sh --reap` against
TERMINAL_REPO. Confirms before destroying. ~15 lines added to
`src/main/telegram.ts`.

## What this does NOT do

- No dashboard panel (over-engineered for the value)
- No per-worktree action buttons
- No bulk-select UI
- No "open as session" from a worktree

When stale worktrees pile up, HITL ping. User decides.

## App scope summary

- 0 src/main changes for the detection
- ~15 lines for the Telegram `/reap` command (optional)

The script + a schedule entry is the whole feature.

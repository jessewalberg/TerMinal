---
id: 13
title: "SSH remote support — run claude/codex on remote hosts from the local cockpit"
status: closed
closed_reason: "obsolete — TerMinal decommissioned (vault ADR-0004; 2026-06-10 consolidation sweep); factory successor noted in triage report where applicable"
priority: medium
horizon: future
hitl: false
type: feature
source: brainstorm
created: 2026-05-30
updated: 2026-06-10
prs: []
refs: []
---

## Why

Trevor sometimes wants to drive claude/codex on a remote box (Meridian
prod, future cloud GPUs / dev boxes) without losing the TerMinal cockpit
(activity feed, AIRuns ledger, HITL inbox, MCP tools, scheduled agents,
/code-review artifacts). Currently the whole cockpit assumes everything
is local: PTY spawn, `~/.config/TerMinal/`, MCP server, file tails.

## Two shapes to choose between

### Shape A — SSH-wrapper sessions (small, ~1-2 days)

PTY spawn becomes `ssh -tt <host> 'claude'`. xterm renders, you type,
claude runs on the remote.

Adds:
- Hosts list in Settings (alias / host / ssh config / default cwd)
- EntryScreen "Remote" mode + host picker
- Session metadata records host; UI badge "REMOTE"
- PTY spawn switch in `src/main/agents.ts` / index.ts session spawn

**Cost: every local cockpit feature breaks for remote sessions** —
activity tail (on remote disk), AIRuns ledger (remote transcripts), MCP
tools (local server can't reach remote files), HITL auto-fire, schedules
(local-rooted), .reviews artifacts (live in remote repo). Becomes a
styled `ssh` tab.

Probably not worth shipping alone.

### Shape B — Remote agent + local cockpit (real, ~1-2 weeks)

Ship a `terminal-agent` daemon to the remote (`scp`-install via the
host-onboarding flow). Runs as a Unix-socket / SSH-tunneled service. The
Mac TerMinal:

- Spawns claude/codex on remote via the agent
- Subscribes to remote `activity.jsonl` → folds into the local feed
- Mirrors remote `~/.config/TerMinal/ai-runs/` into the local AIRuns
  ledger (one cost view across hosts)
- HITL still files locally → one consolidated inbox across hosts
- MCP tools proxy through the agent (file_ticket, file_hitl, etc. on
  remote repos) — could literally be `ssh -W` tunneling the stdio
  channel to a remote `terminal-mcp-server`
- Settings has a `hosts:` list; sessions tagged by host

This is the version worth building.

## Open design questions (to think on)

1. **Auth model.** SSH key forward + per-host config (zero extra creds)?
   Or per-host token signed by the agent install? Probably SSH key —
   it's what's already trusted on those boxes.
2. **Connection lifecycle.** Persistent SSH multiplex (ControlMaster) so
   spawning N sessions to one host is cheap? Or one tunnel per session?
3. **Agent install path.** TerMinal Settings "Add host" runs
   `scp terminal-agent host:~/.local/bin/` + a `launchctl`-equivalent
   bootstrap? Or just document the install and the app probes if it's
   present?
4. **File ops contract.** Does the activity tail + AIRuns mirroring
   stream incrementally (websocket-ish), or does TerMinal poll the agent
   for deltas every 5s? Probably incremental for activity (low-volume,
   high-importance), polled for AIRuns (high-volume, batchy).
5. **Multi-host UI.** Host selector lives in the sidebar / a top-level
   row? Sessions list groups by host? Per-host budget rollup?
6. **Forge CLIs on remote.** `gh` / `glab` / `claude` / `codex` must be
   installed + authed on the remote — TerMinal should detect missing
   pieces and surface "Install gh on this host" the same way the local
   env-detect surfaces local gaps.
7. **Cron parity.** Does cron continue to fire only locally (against
   local `terminal-cron`), or do remote-rooted schedules fire via the
   remote agent's launchd-equivalent? Probably the former for simplicity
   — schedules run from the Mac, dispatch work to remote.

## Non-goals (icebox-scope)

- Not a full VSCode-Remote-SSH replacement (no fs proxy for every
  read/write — only the cockpit surfaces above).
- Not multi-tenant — single-operator (Trevor), single Mac cockpit.
- Not running TerMinal itself headless on the remote.

## Why icebox

Decision deferred. The cost (~1-2 weeks of focused work) is real but the
ROI hinges on how many remote boxes Trevor actually wants to drive
agents on. Today: one (Meridian), and that one mostly needs an SSH tab
not full cockpit integration. The icebox value is: when there's a second
or third remote box, Shape B becomes obviously worth it.

Revisit triggers:
- A second prod box / cloud GPU / dev box enters the picture
- Trevor wants to run scheduled agents on Meridian (not just ad-hoc
  drives)
- TerMinal Mac gets sluggish with all the work happening locally

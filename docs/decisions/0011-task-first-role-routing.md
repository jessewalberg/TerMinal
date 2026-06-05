---
id: 0011
title: Tasks are the unit of work — a ⌘K prompt routes plan→code→review→verify to per-role engines (opus/cursor/codex/opus)
anchor: ADR-0011
status: accepted
date: 2026-06-05
owner: Jesse
area: agents runtime / model routing / task UX
confidence: medium
supersedes:
superseded-by:
---

## [1] Context

Starting work required opening a terminal session (or configuring an agent) and
manually picking ONE engine+model for the whole run. The owner wants the TASK to
be the unit of work: type a prompt anywhere, and the app routes each phase to
the right model — Opus plans, Cursor codes, Codex reviews (reviewer ≠
implementer is global policy), Opus verifies heavy changes.

A 12-agent design workflow mapped every engine/model decision point (agents.ts
runSpec/runStep, bg-tasks, rerun, schedules, bin/terminal-cron, settings/IPC/UI
surface, review artifacts, ai-runs/budgets) and judged three competing designs.
The minimal "widen Step with role" design won on the owner's "fit within the
current system, use what we have" constraint; the TaskRun-orchestrator
alternative scored higher on architecture but was judged a YAGNI violation
(new store + tab + reconciler for a personal app), and its restart-durability
claim was overstated (in-process children never survive restart).

## [2] Decision

- **Routing is data**: `Step` gains optional `role` ('plan'|'code'|'review'|
  'verify'); `Settings.roles` maps each role to {engine, model} (defaults:
  plan/verify→claude opus, code→cursor, review→codex). `resolveStepRouting`
  (src/main/routing.ts, pure) is the single resolution authority; role-unset
  steps resolve byte-identically to the old chain (regression-locked).
- **Snapshot semantics**: routing is resolved ONCE at spawn; a policy change
  never reshuffles an in-flight run, and (when scheduled tasks land) schedule
  saves freeze resolved roleSteps — cron replays, never re-derives. (Owner
  choice: "snapshot — replay as created".)
- **Entry**: ⌘K composer from any tab (`tasks:start` IPC takes an explicit
  repoRoot — no session required); Tickets tab pre-seeds via gt:task-compose.
  Repo default: seed > active workspace > last-used > most recent in fleet.
- **Verify gate**: verify runs only when the diff is heavy —
  `classifyRiskHeuristic` over `git diff --numstat` (high-risk paths or >500
  lines), not a naive line count. Modes: heavy (default) | always | never.
- **Separation of duties at runtime**: a review/verify stage that resolves to
  the code stage's engine family is SKIPPED with a visible log line — never
  silent same-family self-review, even if the user edits the roles table.
- **Plan gate OFF by default** (owner choice): plan→code flows automatically;
  the plan is always persisted (committed `.terminal/plan.md`). The toggle
  parks the run as a HITL item; resolving it (or the Runs-tab button) resumes.
- **Concurrency**: second simultaneous task in the same repo is REFUSED via the
  existing duplicate-run guard (owner choice — queueing is a follow-up).
- **PR-always**: the code stage opens a PR and never merges, regardless of the
  target repo's direct-to-main exemption — always policy-safe for siblings.
- **Spend honesty**: the ledger records per STEP keyed on the step's engine;
  cursor usage is parsed from the raw NDJSON `result` event (subscription CLIs
  price at $0, tokens tracked). Budget gate checked at task start AND at the
  verify boundary.

## [3] Options considered

1. **Minimal Step{role} (chosen)** — smallest diff, reuses pipelines/Runs/HITL/
   worktrees; riskiest edit is per-step resolution inside runStep, mitigated by
   the byte-identical fast path + pure-function tests.
2. **TaskRun orchestrator** — one runSpec per stage, tasks.json store, Tasks
   tab, boot reconciler. Cleanest invariants, most new machinery; rejected as
   over-built for a daily-driver personal app.
3. **Omnibox + data-driven pipelines** — pipelines as {role, engine, condition}
   data + ticket-first durability. Best secondary coverage; largest blast
   radius in runStep (paused state machine) for the same core win.

## [4] Tradeoffs & risks

- In-process task runs do NOT survive app restart (boot marks them
  interrupted) — accepted; bg-tasks stays the detached path. Walk-away
  durability is a follow-up (backlog 0041).
- A multi-engine run shows per-stage chips, but rerun semantics for task runs
  re-resolve the CURRENT policy via composeTaskSteps only if re-entered through
  tasks:start; `runs:rerun` of a task run falls back to single-engine replay
  (backlog 0042).
- OpenRouter is deliberately NOT a role target (roles are CLI engines only).
- The budget gate cannot see subscription-CLI spend (it gates cash-billed
  sources only) — the heavy-only verify mode is the real throttle today.

## [5] What would change our mind

- The heavy heuristic mis-gates in practice (verify firing on noise / missing
  risky diffs) → revisit thresholds or add an LLM classifier pass.
- Scheduled tasks, Telegram entry, or queueing demand a first-class TaskRun
  store → revisit design 2's orchestrator with the routing layer kept as-is.
- Cursor ships per-token pricing → revisit $0 subscription pricing convention.

## [6] Follow-up work

- backlog/0040 Telegram `/task <prompt>` entry point
- backlog/0041 walk-away durability (task flow on the detached bg runner)
- backlog/0042 task-aware rerun (replay original per-stage routing)
- backlog/0043 EnvDetect claude/codex readiness probes + queueing follow-ups

## Source notes

Implemented across src/main/{settings,pipelines,routing,agents,index,
cron-runs}.ts, src/preload/index.ts, renderer types/App/TaskComposer/
SettingsPanel/TicketsBrowser/runs tab. Latent bugs fixed in the same series:
cron cursor fall-through to codex (bin/terminal-cron), bg-tasks default-model
fallback, cursor usage absent from the spend ledger.

## Update 2026-06-05 — routing extended beyond ⌘K tasks (owner decisions)

Owner chose to extend routing to (a) the review/review-iterate pipelines and
(b) an Auto option in EnginePicker; factory-as-tasks and scheduled tasks stay
deferred. New precedence rule (supersedes the blanket "per-run beats policy"):
**an explicit engine/model pick governs the WORK stage only; review/verify
stages always route via Settings.roles**, with the same-family runtime skip as
backstop. Consequences encoded: REVIEW_STAGE carries role 'review' on every
pipeline run; a per-run model alias never leaks into role-tagged stages; the
separation guard's implementer reference falls back to the run's work engine
(and stays off for check-only runs like PR reviews). /factory and /stacked-mr
keep their existing skill-level codex review delegation — their implement
stages still run the session engine until the deferred factory-as-tasks work.

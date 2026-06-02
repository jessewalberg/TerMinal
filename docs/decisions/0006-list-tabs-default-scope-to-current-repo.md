---
id: 0006
title: List tabs default-scope to the window's current repo, with a persistent "all repos" opt-out
anchor: ADR-0006
status: proposed
date: 2026-06-01
owner: Trevor
area: renderer / tabs
confidence: medium
supersedes:
superseded-by:
---

## [1] Context

A TerMinal window is attached to one session/repo (`TabContext.repoRoot`). A
multi-agent UI audit (2026-06-01) found the data tabs were inconsistent about
which repo's data they show on open:

- **Repo-scoped already** (main keys off `repoRootOf(cur().cwd)`): Tickets, MRs,
  CI, Docs, Reports, Files.
- **Global by default, despite being attached to one repo:** Runs
  (`RunsTab({ ctx: _ctx })` discarded the context entirely), Schedules, the
  Agents tab's Runs panel (hard-coded the text "all repos"), and Activity
  (defaulted its `all/repo/session` toggle to `all`).
- **Intentionally fleet-grain:** HITL (global inbox), Triage (cross-repo PR/MR
  summary), Factory (cross-repo health).

Three different idioms coexisted for "which repo's data": a `Scope` union
defaulting to current-repo (Notes), the same union defaulting to `all`
(Activity), and a free-string `repoLabel` filter defaulting to `''`/all
(Runs, Schedules, Agents). So a freshly opened window had no predictable answer
to "what am I looking at," and a one-repo window routinely opened onto every
other repo's runs/schedules/activity.

## [2] Decision

Adopt one house rule for **client-facing list tabs**: default-scope to the
window's current repo (`repoBasename(ctx.repoRoot)`), with a **persistent**
"all repos" opt-out the user can select and have stick.

- Extract a shared `useRepoScope(repoRoot, storageKey)` hook
  (`src/renderer/src/lib/useRepoScope.ts`) for the `repoLabel`-string filter
  tabs (Runs, Schedules, Agents-runs). It defaults to the current repo, persists
  the choice in `localStorage` (including a deliberate `''` = all repos), and
  returns the current repo's label so callers can keep it a selectable option.
- Activity keeps its richer `all/repo/session` toggle but defaults to `repo`
  when a repo is attached (mirroring Notes).
- HITL, Triage, and Factory remain intentionally global — they are fleet views
  by design, documented in-code.

The pure default-resolution (`initialRepoScope`) and `repoBasename` are
unit-tested (`useRepoScope.test.ts`) so the "explicit '' wins over the default"
rule can't silently regress.

## [3] Tradeoffs & known limitations

- A window now hides other repos' rows by default; a user who relied on the
  global firehose must click "all repos" once (it then persists per tab).
- Scope is persisted per `storageKey`, not per repo — switching the window to a
  different repo reuses the same stored pick. Acceptable: the stored value is a
  filter preference ("show me my repo" vs "show me everything"), and the default
  already tracks the current repo when nothing is stored.
- The Agents Runs panel scopes the **in-process** runs list (runs started in
  this app), not the cron feed; cross-session cron runs live in the Runs tab.

## [4] What would change our mind

- If the daily workflow is predominantly cross-repo triage from a single window,
  the default should flip back to global (or become a global app setting rather
  than a per-tab default).
- If per-repo persisted scope (remembering the choice separately for each repo)
  turns out to matter, key the `localStorage` entry by `repoRoot`.

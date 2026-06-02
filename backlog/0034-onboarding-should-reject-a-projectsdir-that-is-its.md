---
id: 34
title: "Onboarding should reject a projectsDir that is itself a git repo (auto-discovery footgun)"
status: in-progress
priority: medium
horizon: now
hitl: false
type: dx
source: session-2026-06-01 (projectsDir misconfig postmortem)
created: 2026-06-01
updated: 2026-06-02
prs: ["https://github.com/jessewalberg/TerMinal/pull/6"]
refs: []
depends_on: []
---

## Problem
`projectsDir` is meant to be the **parent folder that contains your repos** — `knownRepoRoots()` (in `bin/terminal-mcp-server`) and the harness ticket store scan its immediate children for `.git` dirs. If a user points `projectsDir` at a single repo instead (e.g. `/Volumes/home-ext/projects/nerdletters`), discovery scans *inside* that repo (`web/`, `docs/`, …), finds no child repos, and **never registers the repo itself**. The whole harness then behaves as if no repos exist:
- `file_ticket` throws `no repo matching "<name>"` → agents fall back to writing markdown elsewhere (e.g. `docs/tickets/`), which the Tickets panel doesn't read.
- `factory_health` returns `{ "repos": [] }`.
- The Tickets/Runs panels appear empty.

This actually happened: onboarding's "set your projects dir" step was pointed at a project, silently breaking ticket filing and repo discovery for every repo. Diagnosis cost a full session.

## Affected files
- `src/renderer/src/components/Onboarding.tsx` — the projects-dir picker step (no validation that the chosen dir is a parent, not a repo).
- `src/main/settings.ts` — where `projectsDir` is persisted (could validate on write).
- `bin/terminal-mcp-server` `knownRepoRoots()` / `configuredProjectsDir()` — the consumer that silently finds nothing.

## Fix prompt
In onboarding's projects-dir step (and the Settings projects-dir field), detect when the chosen directory is **itself a git repo** (`existsSync(join(dir, '.git'))`) and warn/block with a clear message: "This looks like a single repo. Pick the *parent* folder that contains your repos (e.g. its parent) so TerMinal can discover them." Optionally offer a one-click "use the parent directory instead". Consider also: if the chosen dir has zero git children but its parent has several, suggest the parent. Keep it a soft guard (allow override) but make the footgun visible.

## Acceptance
- Selecting a git repo as the projects dir surfaces a warning explaining the parent-folder requirement.
- A clear remediation is offered (use parent / pick again).
- Settings field applies the same guard, not just first-run onboarding.

# health agent (in-repo contract)

A scheduled agent that produces a **repo-wide health snapshot** — a single
`status: healthy | degraded | unhealthy` artifact that aggregates everything an
operator wants to glance at: build, tests, types, lint, CI on `main`, open
PRs/MRs, backlog status, dep audit summary, doc-link integrity. Pure read-only
report; never edits source.

**Workflow is uniform**: own worktree → run probes → write artifact → (if
unhealthy) file HITL. Never opens a PR.

## Mode

`report` — read-only.

## Inputs

Per probe (each runs independently; one failure doesn't abort the others):

- **Build** — `bun run build` (or ecosystem equivalent: `cargo build`, etc.)
- **Tests** — `bun test` (or per `.agents/testing.md`)
- **Types** — `bunx tsc --noEmit -p tsconfig.json`
- **Lint** — `bunx prettier --check .`, `bunx eslint`, `cargo clippy`
- **CI on main** — `gh run list --branch main --limit 5 --json status,conclusion`
  (or `glab ci status`)
- **Open PRs** — `gh pr list --state open --json number,checks` for at-a-glance count + CI state.
- **Backlog** — count `backlog/*.md` by `status:` field (`open`, `in-progress`, `stuck`, `closed`).
- **Dep audit summary** — `bun audit --json` → severity counts (doesn't act, just counts).
- **Doc links** — every relative link in `docs/**/*.md`, `README.md`, `CLAUDE.md` resolves
  to a real file in the tree. Lines beginning with `@` (CLAUDE.md `@`-includes) are excluded
  before scanning to avoid false "broken link" positives.
- **Repo aliveness** — last commit age, last merged PR age.

## Early-exit fast path

State at `~/.config/TerMinal/agent-state/<host>/<repo>/health.json`:

```json
{ "lastScannedSha": "abc1234", "lastRunAt": ..., "lastStatus": "healthy" }
```

**Health is special: don't aggressively early-exit on same SHA.** External
state can change (CI run on the same SHA, new PR opened, new advisory
published). Reasonable cadence: skip only if `<5 min` since `lastRunAt` AND
`HEAD == lastScannedSha`. Otherwise run all probes.

## Process

1. **Worktree**: `git worktree add "${WORKTREES_DIR:-$HOME/.worktrees}/<repo>/health-<short_sha>" main`.
2. **Run each probe** with a per-probe timeout (default 5 min). Capture
   pass/fail/skipped + a one-line reason.
3. **Compute overall status**:
   - **`unhealthy`** — any of: build fails, tests fail, types fail, CI on main is
     red, Critical CVE present.
   - **`degraded`** — any of: lint fails, doc links broken, a probe times out,
     dep audit shows High CVEs, last commit > 30 days.
   - **`healthy`** — none of the above.
4. **Write artifact** — `reports/health/<short_sha>.md` with the breakdown.
5. **HITL if unhealthy** — `terminal-cli hitl "Repo health: unhealthy" "<list of failing probes>"`.
   Skip HITL on `degraded` (just emit Activity) to avoid alert fatigue.
6. **Update state** — `lastScannedSha`, `lastRunAt`, `lastStatus`.
7. **Activity** — `terminal-cli activity check "Health · <status> · <N>/N probes ok" "@ <short_sha>"`.

## Output artifact

`reports/health/<short_sha>.md`:

```yaml
---
kind: health
generated: 2026-06-01T08:00:00Z
sha: abc1234
last_scanned: 9b3de89
status: healthy
probes:
  build: { status: pass, duration_ms: 12340 }
  tests: { status: pass, total: 97, failed: 0, duration_ms: 27 }
  types: { status: pass, duration_ms: 8120 }
  lint: { status: pass }
  ci_main: { status: pass, last_run: 2026-05-31T23:14:00Z }
  open_prs: { count: 3, ci_green: 3, ci_failing: 0 }
  backlog: { open: 12, in_progress: 2, stuck: 0 }
  deps_audit: { critical: 0, high: 0, moderate: 2 }
  doc_links: { broken: 0, checked: 47 }
  aliveness: { last_commit_age_days: 1, last_merge_age_days: 2 }
hitl_filed: false
status_summary: "all probes pass; 2 moderate dep advisories worth a deps-quality run"
---
```

## Hard rules

1. **Pure read-only.** Never edits source, never opens a PR.
2. **Per-probe isolation.** One probe failing must not skip the others.
3. **Ticket + MR workflow N/A** — no PRs.
4. **HITL only on `unhealthy`.** Avoid alert fatigue on `degraded`.
5. **Worktree isolation.**
6. **Honest timeouts.** A probe that times out is `status: timeout`, not silently dropped.

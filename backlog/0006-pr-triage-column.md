---
id: 6
title: "PR triage: risk_tier in /code-review spec + dashboard column"
status: open
priority: low
horizon: next
hitl: false
type: feature
source: research
created: 2026-05-30
updated: 2026-05-30
prs: []
refs: []
depends_on: []
---

Refactored: 90% of this is a 1-paragraph edit to
`.agents/code-review.md` in `project-template`. The app surface is
literally one new column on the existing PRs tab.

**Filter applied:** the classification is what `/code-review` already
does in-session — we just give it a name (`risk_tier`) and a way for
the dashboard to sort. The cross-repo queue view is the only
harness-shaped slice and it's a single column.

## Step 1 — Edit `.agents/code-review.md` (project-template)

Add to the artifact frontmatter schema:

```yaml
---
verdict: approve | request-changes | blocked
overall: 0-100
correctness: 0-100
security: 0-100
architecture: 0-100
conformance: 0-100
quality: 0-100
dependencies: 0-100
test_status: pass | fail | skipped
risk_tier: low | medium | high      # NEW
---
```

Add to the prompt body of `code-review.md`:

> Assign `risk_tier`:
> - `high` — any axis < 70, OR test_status: fail, OR verdict: blocked,
>   OR touches auth/payments/migrations/external APIs
> - `medium` — verdict: request-changes, OR any axis 70-79
> - `low` — verdict: approve AND all axes ≥ 80

That's the spec change. Codex follows it on the next review pass.

## Step 2 — One column on the PRs tab

`dashboard/src/...` (the PRs tab data fetcher already parses the
review artifact frontmatter):

- Read `risk_tier` from the parsed YAML (gracefully default to
  `unscored` when missing)
- Add a `risk` column rendering a colored pill (🔴 high / 🟡 medium /
  🟢 low / — unscored)
- Default sort: opened MRs, risk=high first, then by MR age desc
- Filter chip set: `[ all  risk:high  risk:medium  unscored ]`

That's it. ~30 lines of dashboard code.

## Step 3 — Telegram (no work)

The existing `/prs` and `/mrs` commands accept `@repo` filtering. Add
one filter token parser for `risk:high` etc. and it composes naturally
with what's there. ~10 lines.

## What this does NOT do

- No separate triage agent. Codex's existing review pass does this
  along the way.
- No "estimated review time."
- No retroactive backfill — old artifacts sort as `unscored` until
  regenerated.

## App scope summary

- 1 spec edit in project-template (the heart of it)
- 1 column on the PRs tab
- 1 filter token in `/prs` Telegram command

No new IPCs, no new agents, no new storage.

---

### Update — 2026-05-31 (cross-repo Triage tab shipped)

The fit/gaps analysis surfaced a related, broader gap — no fleet-wide
"which PRs are ready vs need changes across all repos" view — now shipped
as the **Triage tab** (`fleet:mrs` IPC over `mrSummary()` per known repo).
This ticket's original scope (a `risk_tier` from /code-review + a per-PR
risk column) is still open and complementary: add risk to the new tab's rows.

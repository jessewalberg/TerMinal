---
name: stacked-mr
description: "Autonomous AFK mode that works a queue of tickets as a STACK of PRs: each branch is cut from the prior PR's tip (base = parent branch), implemented TDD-first, pushed, and opened as a PR — WITHOUT per-PR review — then immediately start the next PR on top. Once the whole stack is built, run ONE batch code-review pass that reviews every PR in parallel (one review per PR, each in its own worktree). No human in the loop until morning, when the user reviews the whole stack. Use when the user runs /stacked-mr or asks to stack PRs overnight / autonomously."
---

# /stacked-mr — Autonomous overnight PR stacking

A long-running, AFK, no-human-in-the-loop mode. Instead of one ticket → one PR →
wait for merge, this **stacks**: branch N+1 is cut from branch N's tip, so work
keeps flowing without ever merging to `main`. The human reviews the entire stack
(often ~20 PRs) in the morning and merges bottom-up themselves (global §8 — merge
is still human-only).

**Review is batched at the end, not per-PR.** Build the whole in-scope stack
*without* firing a review on each PR, then run **one batch review pass** that fans
out a `/code-review` per PR concurrently (each in its own worktree). This is not
"skip review" — every PR still has to hit the passing bar — it's "review the whole
stack once, in parallel, after it's built." Two reasons this beats per-PR review:

- **Speed.** A review is ~4 min. Reviewing N PRs serially is ~4·N min; running
  them concurrently at the end is ~4 min total (bounded by the slowest single PR).
- **No review-vs-build contention.** A code review mutates/inspects a checkout;
  running one while the builder is still editing the same repo contaminates the
  test checkout and produces bogus verdicts. Deferring *all* reviews until after
  the build phase removes that race entirely.

> Forge-agnostic: this doc says "PR" / `gh`, but the stacking model is identical
> on GitLab — "MR" / `glab mr create --target-branch <parent>` (resolve with
> `.claude/bin/forge`; mapping in [`.agents/forge.md`](../../../.agents/forge.md)).

## Invocation

```
/stacked-mr "work the vault + payment tickets"      # scoped to a goal
/stacked-mr                                          # work the now/next backlog in priority order
```

This is an AFK mode: **arm the Telegram bridge** (`/notify`) at kickoff and ping
at checkpoints. If the machine has no Telegram setup, run anyway but say so.

## TerMinal run visibility

At kickoff, register this slash-skill as a visible TerMinal workflow run. If
`terminal-cli` is on PATH, run:

```bash
run_id="$(terminal-cli run start stacked-mr "Stacked MR" \
  --engine "${TERMINAL_ENGINE:-codex}" \
  --repo "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
  --branch "$(git branch --show-current 2>/dev/null || true)" \
  --worktree "$(pwd)")"
```

Record `run_id` in the stack ledger. At major checkpoints append a short line
with `terminal-cli run log "$run_id" "<checkpoint>"`. At the morning handoff,
finalize it with `terminal-cli run finish "$run_id" done --exit-code 0`; if the
run blocks or fails, finalize it as `failed` with `--error "<reason>"`. If
`terminal-cli` is unavailable, continue the work and say the run could not be
registered.

## The stacking model

```
main
 └─ 0012-vault-create        (PR #1, base: main)
     └─ 0013-vault-spend     (PR #2, base: 0012-vault-create)
         └─ 0014-payment-link (PR #3, base: 0013-vault-spend)
             └─ ...
```

- Each branch is created from the **previous branch's tip**, not `main`.
- Each PR's **base** is its parent branch, so the PR diff (and the review) is
  just that PR's own delta — clean, reviewable units.
- `gh pr create --base <parent-branch>` sets this. `/code-review` resolves the
  base from the PR, so it reviews the right delta automatically — this is also
  what makes the end-of-stack batch review attribute each finding to the owning
  PR (each review sees only that PR's incremental slice).

## Phase 1 — Build the stack (no reviews)

Work the queue ticket-by-ticket with the loop below. **Do not run `/code-review`
during this phase** — reviews are deferred to the single batch pass in Phase 2.
Keep stacking until the in-scope queue is exhausted (or a stop condition hits).

## Loop (per ticket)

1. **Pick the next ticket** — from the goal, else the backlog by horizon
   (`now`, then `next`) and priority. Skip `future` unless told. Set the ticket
   `status: in-progress`.
2. **Cut the stacked branch** from the current stack tip:
   ```bash
   parent="<previous branch, or origin/main for the first>"
   branch="<id>-<slug>"
   git switch -c "$branch" "$parent"
   ```
3. **Implement TDD-first** — write the failing test, then the code to pass it.
   Commit incrementally. (See the project's TDD gate in CLAUDE.md.)
4. **Sanity-check + push** — type-check/build, eyeball the diff, then
   `git push -u origin "$branch"`.
5. **Open the PR** with `--base "$parent"`:
   ```bash
   gh pr create --base "$parent" --title "<ticket title>" --body "<summary + stack position + test plan>"
   ```
   Note the stack position in the body ("Stacked on #<parent-PR>. Part N of the
   <goal> stack."). Link the PR url into the ticket's `prs:`.
6. **Do NOT review here.** Ping a checkpoint via `/notify` if useful, update the
   ledger, then go straight to the next ticket. Review happens once, in Phase 2.
7. **Immediately start the next ticket on top** (step 1), branching from this
   PR's tip. No reviews are running, so the stack just keeps growing cleanly.

Keep a running ledger (in the active session doc, or a scratch note) of every
PR, its branch, its parent, and its ticket. **Refresh
`.claude/bin/status > .status.md` after each slice** so a human checking in
overnight sees current progress without reading the transcript.

> **Escape hatch:** for a genuinely trust-critical PR mid-stack (auth, money,
> data migrations) you *may* review it immediately rather than deferring — but
> that's the exception. The default is defer-and-batch.

## Context hygiene — `/compact` aggressively at checkpoints

A stacked-mr run is the second-highest-bloat surface after `/factory`: per-ticket
TDD output, push results, PR-creation bodies, then N review verdicts +
findings + diffs. Without compaction, context dies inside Phase 2 just when you
need clean recall of the verdicts.

**Rule:** the ledger, branch state, and review artifacts are all on disk
(`sessions/<id>/stacked-mr.md`, the forge, `.reviews/<pr>/`). The conversation
should never become the source of truth. Compact aggressively; re-read selectively.

Checkpoints — run `/compact` (or summarize-and-purge) at each:

1. **Every ~3–5 tickets inside Phase 1** — the per-ticket TDD output and diffs
   accumulate fast. After compacting, the ledger + `.status.md` carry the
   stack state forward.
2. **At the Phase 1 → Phase 2 boundary** — the build is done; tests/diffs from
   the build are no longer load-bearing. Only the ledger needs to survive into
   the review fan-out.
3. **After collecting all batch-review verdicts**, before handling them —
   findings/suggestions live in `.reviews/<pr>/`; keep a short per-PR verdict
   summary (approve / request-changes / blocked + counts) and drop the rest.
4. **After each fix + re-review** in the verdict-handling phase — the same
   logic applies per iteration.

Prefer **out-of-process delegation** so heavy steps never bloat the
orchestrator: each `/code-review` invocation runs in its own worktree under
`codex exec`, and the verdict is what comes back — the per-PR artifact path,
verdict, test counts, and finding counts, not the full review transcript. See
the `/factory` skill's `[2.6] Orchestrator pattern` for the full table of
delegation choices (in-process subagent / `codex exec` / `claude -p` /
worktree-spawn) and their tradeoffs; the same rules apply here.

## Phase 2 — Batch-review the whole stack

When the build phase ends (queue exhausted, or the user calls it), run **one
batch review pass** over every PR in the stack. The reviews run **concurrently**,
each in its **own worktree**, so the whole stack is reviewed in roughly the time
of a single review instead of N reviews back-to-back.

1. **Refresh the forge state once** for all PRs in the stack (so each review
   resolves the right head SHA + base). Build the review list from the ledger:
   one entry per PR with its number, branch, and parent branch.
2. **Fan out one `/code-review` per PR, in parallel, each in its own worktree.**
   A review inspects and tests a checkout — running N reviews in the *same*
   working tree corrupts git state and cross-contaminates results, so give each
   PR an isolated worktree at its branch tip:
   ```bash
   # for each PR branch in the stack (run these concurrently):
   wt="${WORKTREES_DIR:-$HOME/.worktrees}/<repo>/<branch>"
   git worktree add "$wt" "<branch>"
   ( cd "$wt" && /code-review for this PR in the background ) &
   ```
   Each review is still a normal **single-PR** review: it resolves its own base
   (the parent branch) → its incremental delta → its own per-PR artifact +
   `findings.json`/`suggestions.json`. "Batch" = the orchestration firing N of
   them at once, not a new combined-artifact format.
3. **Collect verdicts as they land** and record each in the ledger. When all
   reviews are in, you have the full stack scorecard for the morning handoff.
4. **Clean up worktrees** when reviews finish (`git worktree remove "$wt"`), or
   leave them if you'll iterate on fixes (a fix + re-review reuses the worktree).

> Mechanics note: each `/code-review` invocation is single-URL by design (one
> preflight packet, one artifact per PR). The batch is N concurrent invocations,
> not one call over N PRs. See [`.agents/code-review.md`](../../../.agents/code-review.md)
> ("Batch stacked-MR review").

## Handling review verdicts

Verdicts arrive together at the end of the batch pass. For each PR:

- **approve + tests pass + 0 medium+ findings** → that PR has hit the bar. Note
  it in the morning summary; nothing else to do.
- **request-changes / blocked** → apply the findings' fix prompts to **that PR's
  branch** (not the tip of the stack), push the fix, then **re-review just that
  PR** (a single `/code-review`, not the whole batch again). Then **restack
  children**: any branches cut from the fixed branch must be rebased onto its new
  tip so the stack stays coherent:
  ```bash
  git rebase --onto <fixed-branch> <old-parent-tip> <child-branch>
  git push --force-with-lease origin <child-branch>
  ```
  (`--force-with-lease` to a **feature** branch is allowed by the merge hook;
  never to main/master.) If a fix near the bottom of the stack restacks many
  children, re-review the affected sub-chain as a small second batch.

## Stop conditions

- Backlog queue (in-scope horizon) exhausted.
- A **true blocker** needing a human decision (ambiguous spec, a destructive or
  cost-bearing action, a design fork) → `/notify --kind=blocked` with options,
  pick a defensible default and continue if possible, else pause that line and
  move to an independent ticket.
- The user says stop / "I'm back".
- A PR can't reach passing after a reasonable number of fix cycles → mark the
  ticket `stuck`, note why, and move on (don't burn the night on one PR).

## Morning handoff

When the run ends (or the user returns), produce a **stack summary** in
dependency order:

```
Stack of N PRs (review bottom-up; merge after review):
  #1  0012-vault-create   base:main             approve   ✅ tests 9/9
  #2  0013-vault-spend     base:0012-vault-create approve   ✅ tests 12/12
  #3  0014-payment-link    base:0013-vault-spend  request-changes (1 medium) ⚠ — fix pushed, re-review running
  ...
```

Include each PR url, ticket id, base branch, and latest verdict. Flag any
`stuck` tickets and any PRs still awaiting a verdict. The human merges
bottom-up; as each merges, the next PR's base auto-retargets on GitHub (or note
where a restack is needed). **After the human finishes merging the batch, run
`/merge-sync`** to close the merged tickets and scrub their PR urls from `prs:`.

## Hard rules

1. **Never merge.** No `gh pr merge`, ever (global §8, hook-enforced). The stack
   waits for the human.
2. **Every PR gets reviewed to the bar.** approve + tests pass + 0 medium+
   findings — enforced via the **end-of-stack batch review**, not per-PR during
   the build. "Stacked" is not "unreviewed"; it's "reviewed all at once at the
   end."
3. **Force-push only to feature branches**, only for restacking, only with
   `--force-with-lease`. Never to main/master.
4. **TDD-first** on every ticket — failing test before code.
5. **No reviews during the build phase.** Reviews are batched into one
   parallelized pass after the stack is built (Phase 2) — this both speeds up
   review and avoids review-vs-build checkout contention. The lone exception is
   the trust-critical escape hatch.
6. **Batch reviews run in isolated worktrees**, one per PR, so the concurrent
   reviews don't corrupt each other's git state.
7. **One stack tip at a time.** The "current tip" is well-defined; always branch
   the next PR from it (or from a deliberate earlier point for parallel lines —
   note it in the ledger if so).

## Activity

Each stacked PR already emits `pr-opened` (via `/pr-creation`) and `pr-verdict`
(via the batch `/code-review`). Add the stack-level checkpoints:

```bash
# a true blocker needs a human decision (stop condition) → global HITL inbox:
.claude/bin/hitl "Stack blocked · <why>" "<action needed / options>"
# the whole stack is built + reviewed (morning handoff):
.claude/bin/activity task-complete "Stack complete · <N> PRs" "<X approve, Y rc>"
```

## What this is NOT

- Not a merge bot. It opens and reviews PRs; humans merge.
- Not a review skipper. The passing bar holds for every PR.
- Not for trust-critical one-offs that need human eyes mid-flight — use
  `/pr-creation` + manual `/code-review` for those.

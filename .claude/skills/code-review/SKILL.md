---
name: code-review
description: "Delegate a GitHub PR review to Codex via codex exec. Codex runs the test suite first (the gate), scores six axes, and writes ONE combined artifact IN THIS REPO under .reviews/<pr>/<sha>.md plus findings.json/suggestions.json. Use when the user runs /code-review, asks to review a PR, or is preparing a PR for human merge."
---

# /code-review — PR review with six-axis scoring + embedded tests

Produces **one combined artifact** in this repo at
`.reviews/<pr-number>/<short_sha>.md`. The schema, scoring rubric,
severity-based body rules, anti-slop checklist, and verdict logic are owned by
the in-repo contract — Codex **reads [`.agents/code-review.md`](../../../.agents/code-review.md)
before scoring** (and `.agents/testing.md` for runner detection).

Forge: **GitHub or GitLab**, detected per repo (`.claude/bin/forge`; command
mapping in [`.agents/forge.md`](../../../.agents/forge.md)). Artifacts are
**in-repo** — no central dashboard, no harness phone-home.

## Delegate to Codex

Do **not** perform the review inside Claude. Delegate the full review to Codex
so artifacts are produced by the standard reviewer. Run `codex exec` from this
repo's root (`-C "$PWD"`), and pass a self-contained prompt that points Codex at
the in-repo contract + output path. **Do not use Codex's global `/code-review`
slash command** — it targets a different (central) artifact store; the prompt
below keeps everything in-repo.

### Rule: run in the background — review is the dev-speed bottleneck

Code review is **the most common bottleneck to dev speed** in this workflow. A
review takes **~4 minutes** (test gate + six-axis scoring + artifact write).
Blocking the session on it is almost always the wrong call.

**Default to a non-blocking background run.** Fire Codex in the background,
surface the task id, and **immediately go do other useful work** during those
~4 minutes — start the next ticket, open the next PR, prep follow-up fixes,
update docs/session state. You'll be notified when the review completes; relay
the verdict + artifact path then. **Do not poll or sleep** waiting on it — that
just re-creates the block you were avoiding. Only stop and wait if there is
genuinely nothing else to advance.

Invoke via `Bash` with `run_in_background: true`:

```bash
codex exec -s danger-full-access -C "$PWD" "Review the PR/MR at <URL> at its current head commit. The forge is GitHub or GitLab: run .claude/bin/forge to find which, and use gh (GitHub) or glab (GitLab) per .agents/forge.md to resolve the change number, head SHA, base, and diff. Follow the review contract in .agents/code-review.md in this repo exactly: run the detected test suite first as the gate, and if tests are not green stop at a blocked test-gate artifact. Otherwise score the six axes (for the Security axis, first run the deterministic floor via .claude/skills/security-scan in diff mode and take the lower of its recommended score and your manual read), compose findings with copy-pasteable fix prompts, and pick a verdict. Write the combined artifact to .reviews/<number>/<short-sha>.md, and update .reviews/<number>/findings.json and .reviews/<number>/suggestions.json per the contract. If you spot real work that is out of scope for this change (latent bugs elsewhere, worthwhile refactors, missing test surfaces, follow-up extensions), file a backlog ticket using .claude/skills/ticket: check bin/tickets open for duplicates, allocate an id with bin/next-ticket-id, write backlog/NNNN-slug.md per EXAMPLE.md, and reference the ticket id in the artifact Suggestions section."
```

`-s danger-full-access` is required: the test gate frequently binds loopback
TCP ports, writes `/tmp`, or calls local infra. The default `workspace-write`
sandbox blocks loopback bind and turns a passing suite into a false
`test_status: fail` + `blocked` verdict.

**Backticks footgun.** The codex prompt is passed through the shell — any
literal backtick becomes command substitution and codex hangs reading stdin.
Keep the prompt backtick-free (write "tsc" not the backticked form). If
backticks are unavoidable, write the prompt to a temp file and pass
`"$(cat /tmp/prompt.txt)"`.

### Stacked-MR batch mode

In `/stacked-mr` mode this skill is invoked **once per PR as a parallel batch** at
the end of the stack — not per-PR during the build. Each invocation is still a
normal **single-PR** review (one URL → one preflight packet → one
`.reviews/<number>/<sha>.md` + its own `findings.json`/`suggestions.json`). The
`/stacked-mr` skill orchestrates the concurrency and gives each review its **own
worktree** so the parallel reviews don't corrupt each other's checkout. Don't try
to review N PRs in one call — there is no multi-URL mode. See
[`.agents/code-review.md`](../../../.agents/code-review.md) → "Batch stacked-MR
review".

### When to run synchronously (foreground)

Only when the next step depends on the verdict: the user said "wait for it",
you're inside an explicit fix-until-approve loop, or this is the final pass
before an imminent manual merge. When in doubt, background.

### Reading background results

When the completion notification arrives, read the task output and surface, in
one concise message: the verdict (`approve`/`request-changes`/`blocked`), the
artifact path (`.reviews/<pr>/<sha>.md`), test totals, and key findings
(counts + severities). Don't replay the transcript.

### Fallback

Run the review directly in Claude only if `codex` is unavailable OR the user
explicitly asks. Inline reviews lose the standard-reviewer behavior (six-axis,
test gate, findings.json diff) so are last-resort. If you do, follow
`.agents/code-review.md` yourself.

**Model pin (fallback only):** When running the review inline in Claude, use
`claude-opus-*` or `claude-sonnet-*`. **Never use Haiku** — a merge+security gate
must not run on a small model. Set `generator: claude:opus` or `generator: claude:sonnet`
in the artifact frontmatter accordingly.

## Hard rules (override everything in the contract)

1. **Tests must pass.** `test_status != pass` → `verdict: blocked`. No exceptions.
2. **Approve is earned.** Requires `test_status == pass`, zero ≥ medium
   findings, AND a one-sentence articulation of *why* the PR is safe. If you
   can't write that sentence, don't approve. (Per this project's bar the
   overall score is informational — the gate is verdict + 0 medium+ + tests.)
3. **No merge-to-main bypassing.** Any push/force-push/merge to a protected
   branch, anything violating global §8 → automatic critical finding, verdict
   `blocked`.

## What this skill is NOT

- **Not the built-in `/review`** (a generic ad-hoc reviewer). This produces the
  in-repo `.reviews/` artifact format.
- **Not a fixer.** Findings get fix prompts; fixes happen in a follow-up commit
  — re-run `/test-suite` to confirm green, then `/code-review` to re-score.
- **Not standalone test-run.** Use `/test-suite` for ad-hoc runs that print to
  chat without writing an artifact.

## Activity

After the review artifact is written, emit a feed event:

```bash
.claude/bin/activity pr-verdict "Review · <verdict> · !<iid>" "<repo> @ <short_sha>" --pr <iid>
```

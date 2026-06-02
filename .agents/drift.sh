#!/usr/bin/env bash
# drift-auditor — compares what the docs claim against what the code does
# since the last successful scan. Demonstrates the canonical state pattern
# documented in .agents/scripts.md:
#
#   last=$(terminal-cli state get-sha)        # "" on first run
#   range="${last:-cold-window}..origin/main"
#   if no new commits: exit 0
#   otherwise: do the work, file tickets/PR, then `terminal-cli state mark-main`
#
# The full agent contract lives in .agents/drift.md — this script implements
# the report-mode subset (audit + ticket-file; no PR opening). Trivial-fix PR
# mode (broken-path, renamed-symbol) can be layered on later by branching
# inside this script before the mark-main call.
#
# Runner env (set by TerMinal):
#   TERMINAL_REPO      repo root
#   TERMINAL_AGENT_ID  this agent's id ("drift") — state key
#   TERMINAL_RUN_ID    uuid of this run
#   TERMINAL_BRANCH    worktree branch (or "main" if inPlace)
#   TERMINAL_WORKTREE  worktree path
#   TERMINAL_ENGINE    "claude" | "codex"
#   TERMINAL_MODEL     model hint (default: sonnet for the analysis pass)

set -uo pipefail

# ---------------------------------------------------------------------------
# 1. Determine the scan range. lastScannedSha is "" on first run, in which
#    case we look back 50 commits as a sensible cold-start window.
# ---------------------------------------------------------------------------
last=$(terminal-cli state get-sha)

git -C "$TERMINAL_REPO" fetch --quiet origin || true
head=$(git -C "$TERMINAL_REPO" rev-parse origin/main 2>/dev/null \
    || git -C "$TERMINAL_REPO" rev-parse origin/master 2>/dev/null \
    || git -C "$TERMINAL_REPO" rev-parse HEAD)

if [ "$head" = "$last" ]; then
  echo "drift: no new commits since $last — nothing to scan."
  exit 0
fi

range="${last:-HEAD~50}..$head"

# Changed files since last scan (relative to repo root).
changed=$(git -C "$TERMINAL_REPO" diff --name-only "$range" 2>/dev/null || true)
if [ -z "$changed" ]; then
  echo "drift: empty diff for $range — recording $head and exiting."
  terminal-cli state mark-main
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Cheap heuristic: if EVERY changed file is under docs/ or CHANGELOG.md,
#    there's no source→docs drift to check (a doc-only edit can still introduce
#    contradictions, but the LLM pass is more useful when there's real code
#    motion). Mark and exit.
# ---------------------------------------------------------------------------
non_docs=$(echo "$changed" | grep -Ev '^(docs/|CHANGELOG\.md$|\.md$)' || true)
if [ -z "$non_docs" ]; then
  echo "drift: only docs changed in $range — skipping cross-check."
  terminal-cli state mark-main
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Hand the diff + the relevant docs to claude. The report-mode prompt asks
#    for STRUCTURED findings categorized by the .agents/drift.md catalog so
#    downstream parsing is simple: each finding becomes either a ticket or a
#    trivial-fix PR (layer in later).
# ---------------------------------------------------------------------------
model=${TERMINAL_MODEL:-sonnet}
short=$(git -C "$TERMINAL_REPO" rev-parse --short "$head")
mkdir -p "$TERMINAL_REPO/reports/drift"
report="$TERMINAL_REPO/reports/drift/${short}.md"

# Limit the diff size we hand to claude — 3000 lines is enough to spot drift
# patterns without blowing the context window on huge refactors.
diff_excerpt=$(git -C "$TERMINAL_REPO" log --stat "$range" | head -3000)
docs_index=$(find "$TERMINAL_REPO/docs" -name '*.md' 2>/dev/null | head -50)
claude_md=$(find "$TERMINAL_REPO" -maxdepth 3 -name 'CLAUDE.md' 2>/dev/null | head -20)

# Build the prompt in a tmp file — nesting a heredoc inside $(cat <<EOF ...)
# is fragile across bash versions; writing to a file and reading back with
# "$(<file)" sidesteps the parser pain entirely.
prompt_file=$(mktemp)
trap 'rm -f "$prompt_file"' EXIT
cat > "$prompt_file" <<EOF
You are the drift-auditor for repo $TERMINAL_REPO. Compare what the docs claim
against what the code does in the commits ${last:-HEAD~50}..$head.

Changed files:
$changed

Commit log (excerpt):
$diff_excerpt

Doc files to verify against:
$docs_index

CLAUDE.md files:
$claude_md

Categorize each finding using this catalog from .agents/drift.md:
- broken-path: doc references a path that no longer exists
- renamed-symbol: doc refers to an old symbol, only the new one exists
- stale-runbook: runbook last-verified is >90 days old
- adr-contradiction: an accepted ADR claims X but code does Y
- claude-md-drift: CLAUDE.md rule contradicts shipped code
- module-undocumented: new top-level src file/folder with no doc entry

Write the audit report to $report with frontmatter listing the finding count
per category, then a sectioned body per finding (file path + line + the doc
that's drifting + the code that contradicts it).

For each non-trivial finding (everything except broken-path / renamed-symbol
where the substitution is mechanical), file a backlog ticket via:
  terminal-cli ticket "<title>" "<body with file:line refs>"

When the report is written, emit:
  terminal-cli activity check "Drift · N findings" "@ $short"

If you find ZERO findings, still write the report with status: ok and the
activity event with N=0 — the artifact records the run either way.
EOF

claude -p "$(<"$prompt_file")" --dangerously-skip-permissions --model "$model"
exit_code=$?

# ---------------------------------------------------------------------------
# 4. Mark scan complete regardless of the LLM's exit code. Re-running with a
#    bad LLM exit and the same lastScannedSha would just re-scan the same range,
#    which is wasteful. Better to record the sha + let next run pick up new
#    commits; the report file is the durable record either way.
# ---------------------------------------------------------------------------
terminal-cli state mark-main
# Capture the finding count out of the report if it was written, for the
# extras viewer in the Agents tab's state section.
if [ -f "$report" ]; then
  total=$(grep -E '^\s+[a-z-]+:\s+[0-9]+' "$report" | awk '{ s += $2 } END { print s+0 }')
  terminal-cli state set lastFindings "$total"
fi

exit $exit_code

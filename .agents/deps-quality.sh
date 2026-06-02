#!/usr/bin/env bash
# deps-quality — two-tier dependency hygiene + security triage
#
# TIER 1 (deterministic, free):
#   - Incremental-skip: exits 0 if origin/main hasn't moved since last scan
#     AND the advisory feed was already checked in the last 24 h.
#   - Runs `bun audit --json` (or cargo/pip/go equivalent) and counts advisories.
#   - If zero advisories AND lock is clean AND no deps changed → exit 0.
#
# TIER 2 (haiku — cheap classification):
#   - Each advisory is classified: severity bucket (Critical/High/Moderate/Low),
#     exploitability context, whether the package is a real production dep or a
#     dev-only placeholder, and whether a bump is semver-safe (minor/patch) or
#     would be breaking (major).
#   - Critical or High advisories → IMMEDIATELY file a HITL and stop.
#     "Fast path" here means: escalate to a human RIGHT NOW, never auto-resolve.
#     A Critical/High CVE is NEVER silently skipped, silently downgraded, or
#     auto-applied without human review — the HITL IS the required action.
#   - Moderate/Low, bump-safe advisories → collect for the sonnet fix pass.
#   - Moderate/Low, breaking or dev-placeholder → ticket, no auto-fix.
#
# TIER 3 (sonnet — authoring, only when SAFE fixes exist):
#   - Apply the safe (minor/patch, ≥3-day-old) bumps in a worktree.
#   - Run formatter auto-fix (prettier/eslint/ruff/etc.) in the same pass.
#   - Open a PR: chore(deps): bump N packages + lint sweep
#   - Write the report artifact to reports/deps-quality/<short_sha>.md
#
# OPUS: reserved for human-escalated critical review only (not called here).
#
# Runner env (set by TerMinal):
#   TERMINAL_REPO        repo root (absolute)
#   TERMINAL_AGENT_ID    "deps-quality"
#   TERMINAL_RUN_ID      run uuid
#   TERMINAL_BRANCH      worktree branch (or "main" if inPlace)
#   TERMINAL_WORKTREE    worktree path
#   TERMINAL_ENGINE      hint: claude | codex
#   TERMINAL_MODEL       model hint (overrides tier defaults)
#   TERMINAL_TICKET      ticket id if invoked from a ticket context
#   TERMINAL_PR          PR/MR number if invoked from a PR-tab agent
#
# Helpers on PATH: terminal-cli ticket|hitl|activity|notify|state

set -uo pipefail

# ---------------------------------------------------------------------------
# 0. CONSTANTS & GUARD RAILS
# ---------------------------------------------------------------------------
MODEL_HAIKU="${TERMINAL_MODEL:-haiku}"
MODEL_SONNET="sonnet"
ADVISORY_CACHE_TTL=86400   # re-check advisory feed at most once per day (secs)
MIN_BUMP_AGE_DAYS=3        # global §10 — never adopt a version < 3 days old

# ---------------------------------------------------------------------------
# 1. TIER 1-A: INCREMENTAL SKIP — has origin/main changed?
# ---------------------------------------------------------------------------
last=$(terminal-cli state get-sha)

git -C "$TERMINAL_REPO" fetch --quiet origin || true
head=$(git -C "$TERMINAL_REPO" rev-parse origin/main 2>/dev/null \
    || git -C "$TERMINAL_REPO" rev-parse origin/master 2>/dev/null \
    || git -C "$TERMINAL_REPO" rev-parse HEAD)

if [ "$head" = "$last" ]; then
  # Main hasn't changed; also check whether the advisory feed TTL has elapsed.
  last_audit_at=$(terminal-cli state get lastAuditAt 2>/dev/null || true)
  last_audit_at=${last_audit_at:-0}
  now_ts=$(date +%s)
  age_secs=$(( now_ts - last_audit_at ))
  if [ "$age_secs" -lt "$ADVISORY_CACHE_TTL" ]; then
    terminal-cli activity check "Deps-quality · skipped" \
      "No commits and advisory feed checked <24h ago — nothing to do."
    exit 0
  fi
  # Feed may have new advisories even with no code changes — fall through to
  # the audit pass but skip the diff/bump detection.
  code_changed=false
else
  code_changed=true
fi

short=$(git -C "$TERMINAL_REPO" rev-parse --short "$head")

# ---------------------------------------------------------------------------
# 1-B: DETECT PACKAGE MANAGER & RUN AUDIT
# ---------------------------------------------------------------------------
audit_json=""
pkg_manager="none"

if [ -f "$TERMINAL_REPO/package.json" ]; then
  pkg_manager="bun"
  audit_json=$(cd "$TERMINAL_REPO" && bun audit --json 2>/dev/null || true)
fi

if [ -z "$audit_json" ] && [ -f "$TERMINAL_REPO/Cargo.toml" ]; then
  pkg_manager="cargo"
  # cargo audit outputs JSON with --json flag
  audit_json=$(cd "$TERMINAL_REPO" && cargo audit --json 2>/dev/null || true)
fi

if [ -z "$audit_json" ] && [ -f "$TERMINAL_REPO/pyproject.toml" ]; then
  pkg_manager="pip"
  audit_json=$(cd "$TERMINAL_REPO" && pip-audit --format=json 2>/dev/null || true)
fi

if [ -z "$audit_json" ] && [ -f "$TERMINAL_REPO/go.mod" ]; then
  pkg_manager="go"
  # govulncheck -json; fall back to empty if not installed
  audit_json=$(cd "$TERMINAL_REPO" && govulncheck -json ./... 2>/dev/null || true)
fi

# Record time of audit regardless of findings (resets the feed-TTL clock).
terminal-cli state set lastAuditAt "$(date +%s)" >/dev/null

# If we got no audit output at all and code hasn't changed either, nothing to do.
if [ -z "$audit_json" ] && [ "$code_changed" = "false" ]; then
  terminal-cli activity check "Deps-quality · no audit tool" \
    "No supported package manager audit output for $pkg_manager — skipping."
  terminal-cli state mark-main
  exit 0
fi

# Quick zero-advisory early-exit: count advisories from JSON if parseable.
advisory_count=0
if [ -n "$audit_json" ] && command -v jq >/dev/null 2>&1; then
  # bun audit JSON shape: {"advisories":{...}}
  # cargo audit JSON shape: {"vulnerabilities":{"found":true,"list":[...]}}
  advisory_count=$(
    echo "$audit_json" | jq '
      if .advisories then (.advisories | length)
      elif .vulnerabilities.list then (.vulnerabilities.list | length)
      elif type == "array" then length
      else 0 end
    ' 2>/dev/null || echo 0
  )
fi

if [ "$advisory_count" -eq 0 ] && [ "$code_changed" = "false" ]; then
  terminal-cli activity check "Deps-quality · clean" \
    "0 advisories, no code changes — @ $short"
  terminal-cli state mark-main
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. TIER 2: HAIKU CLASSIFIES EACH ADVISORY
#    Returns a JSON array: [{pkg, severity, exploitable, dev_only, bump_safe}]
#    CRITICAL RULE: Critical or High severity → IMMEDIATELY HITL, NEVER auto-fix.
# ---------------------------------------------------------------------------
if [ "$advisory_count" -eq 0 ]; then
  classification_json="[]"
else
  prompt_file=$(mktemp)
  trap 'rm -f "$prompt_file"' EXIT

  cat > "$prompt_file" <<EOF
You are classifying dependency advisories for automated triage.

Repo: $TERMINAL_REPO
Package manager: $pkg_manager
Advisory count: $advisory_count

Audit JSON:
$audit_json

For each advisory output a JSON array (and NOTHING else — no prose):
[
  {
    "pkg": "<package name>",
    "severity": "Critical|High|Moderate|Low|Unknown",
    "exploitable": true|false,
    "dev_only": true|false,
    "bump_safe": true|false
  },
  ...
]

Classification rules:
- severity: use the advisory's own severity field; if absent, infer from CVSS.
- exploitable: true if it affects runtime code paths (not just build tools).
- dev_only: true if the package is only in devDependencies / dev-deps / test deps.
- bump_safe: true ONLY if a minor or patch upgrade is available AND the advisory
  is fixed in that version. false for major-only fixes, no-fix-available, or
  when the available fix version is < 3 days old (creation date unknown → false).
EOF

  classification_json=$(
    claude -p "$(<"$prompt_file")" \
      --dangerously-skip-permissions \
      --model "$MODEL_HAIKU" 2>/dev/null \
    | grep -E '^\[' | head -1 \
    || echo "[]"
  )
  rm -f "$prompt_file"
  trap - EXIT
fi

# ---------------------------------------------------------------------------
# 2-B: ACT ON CRITICAL / HIGH ADVISORIES — ALWAYS FILE HITL, NEVER AUTO-RESOLVE
#
# This is the "fast path" for Critical/High: fast escalation to a human.
# These are NEVER silently skipped, silently fixed, or auto-applied.
# The HITL item IS the required action — a human must review and decide.
# ---------------------------------------------------------------------------
critical_count=0
high_count=0
critical_hitl_body=""

if command -v jq >/dev/null 2>&1 && [ "$classification_json" != "[]" ]; then
  critical_count=$(echo "$classification_json" | jq '[.[] | select(.severity=="Critical")] | length' 2>/dev/null || echo 0)
  high_count=$(echo "$classification_json"     | jq '[.[] | select(.severity=="High")]     | length' 2>/dev/null || echo 0)

  if [ "$critical_count" -gt 0 ] || [ "$high_count" -gt 0 ]; then
    critical_hitl_body=$(echo "$classification_json" | jq -r '
      .[] | select(.severity == "Critical" or .severity == "High") |
      "• \(.pkg) [\(.severity)] exploitable=\(.exploitable) dev_only=\(.dev_only) bump_safe=\(.bump_safe)"
    ' 2>/dev/null || echo "(parse failed — see audit JSON above)")

    terminal-cli hitl \
      "deps-quality: Critical/High CVE(s) require human review @ $short" \
      "$(printf '%d Critical, %d High advisory/advisories found in %s.\n\nThese MUST be reviewed and resolved by a human — they are never auto-fixed.\n\nAffected packages:\n%s\n\nFull audit output is in: reports/deps-quality/%s.md\nRepo: %s' \
        "$critical_count" "$high_count" "$TERMINAL_REPO" \
        "$critical_hitl_body" "$short" "$TERMINAL_REPO")"

    terminal-cli activity error \
      "Deps-quality · HITL filed: $critical_count Critical / $high_count High CVEs" \
      "Repo $TERMINAL_REPO @ $short — human review required"

    # Write partial report so the HITL item can reference it.
    mkdir -p "$TERMINAL_REPO/reports/deps-quality"
    report="$TERMINAL_REPO/reports/deps-quality/${short}.md"
    cat > "$report" <<RPTEOF
---
kind: deps-quality
generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
sha: $short
pkg_manager: $pkg_manager
advisories_total: $advisory_count
critical_cves: $critical_count
high_cves: $high_count
status: hitl-required
hitl_reason: "Critical or High CVE(s) require human review before any automated action"
---

## Critical / High advisories (HITL required — no auto-fix attempted)

$critical_hitl_body

## Full advisory classification

\`\`\`json
$classification_json
\`\`\`
RPTEOF

    terminal-cli state mark-main
    # Exit 0: the HITL was successfully filed; the run itself succeeded.
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# 3. COLLECT SAFE FIXES (Moderate/Low, bump_safe=true, non-dev-only or dev-ok)
#    File tickets for everything else (major-only fix, no fix available, etc.)
# ---------------------------------------------------------------------------
safe_pkgs=""
ticket_pkgs=""

if command -v jq >/dev/null 2>&1 && [ "$classification_json" != "[]" ]; then
  safe_pkgs=$(echo "$classification_json" | jq -r '
    .[] | select(
      (.severity == "Moderate" or .severity == "Low" or .severity == "Unknown") and
      .bump_safe == true
    ) | .pkg
  ' 2>/dev/null || true)

  ticket_pkgs=$(echo "$classification_json" | jq -r '
    .[] | select(
      (.severity == "Moderate" or .severity == "Low" or .severity == "Unknown") and
      .bump_safe == false
    ) | "[\(.severity)] \(.pkg)"
  ' 2>/dev/null || true)
fi

# File tickets for un-auto-fixable advisories.
if [ -n "$ticket_pkgs" ]; then
  while IFS= read -r pkg_line; do
    [ -z "$pkg_line" ] && continue
    terminal-cli ticket \
      "deps-quality: manual bump needed — $pkg_line" \
      "Advisory found in $TERMINAL_REPO but no safe automated bump is available (major-only fix or no fix yet). Requires manual review.\n\nPackage: $pkg_line\nRepo: $TERMINAL_REPO @ $short" \
      >/dev/null || true
  done <<< "$ticket_pkgs"
fi

# If no safe fixes exist and code hasn't changed since last scan, we're done.
if [ -z "$safe_pkgs" ] && [ "$code_changed" = "false" ]; then
  terminal-cli activity check "Deps-quality · no auto-fix candidates" \
    "$advisory_count advisory/advisories, none auto-fixable — @ $short"
  terminal-cli state mark-main
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. TIER 3: SONNET APPLIES SAFE FIXES + OPENS PR
#    Only reached when there are safe-bumpable packages OR code changed.
# ---------------------------------------------------------------------------
wt_dir="${WORKTREES_DIR:-$HOME/.worktrees}/$(basename "$TERMINAL_REPO")/deps-quality-${short}"
mkdir -p "$(dirname "$wt_dir")"

git -C "$TERMINAL_REPO" worktree add "$wt_dir" main 2>/dev/null \
  || git -C "$TERMINAL_REPO" worktree add "$wt_dir" origin/main 2>/dev/null \
  || { terminal-cli hitl "deps-quality: worktree setup failed @ $short" \
         "Could not create worktree at $wt_dir for repo $TERMINAL_REPO"; exit 0; }

trap 'git -C "$TERMINAL_REPO" worktree remove --force "$wt_dir" 2>/dev/null || true' EXIT

mkdir -p "$TERMINAL_REPO/reports/deps-quality"
report="$TERMINAL_REPO/reports/deps-quality/${short}.md"

sonnet_prompt=$(mktemp)
trap 'rm -f "$sonnet_prompt"; git -C "$TERMINAL_REPO" worktree remove --force "$wt_dir" 2>/dev/null || true' EXIT

cat > "$sonnet_prompt" <<EOF
You are the deps-quality fix agent for $TERMINAL_REPO.

Working directory (your worktree): $wt_dir
Package manager: $pkg_manager
Short SHA: $short

## Your mandate

1. Apply ONLY the safe minor/patch bumps for these packages (each has an
   advisory with a minor/patch fix available; already verified by haiku):
${safe_pkgs:-(none — only quality sweep needed)}

   SAFETY RULES you must enforce:
   - Only minor (x.Y.z) or patch (x.y.Z) bumps — NEVER major bumps.
   - Only adopt a version that has been published for at least $MIN_BUMP_AGE_DAYS days.
     Check the registry publication date; if unknown or < $MIN_BUMP_AGE_DAYS days,
     skip that bump and file a ticket with: terminal-cli ticket "deps-quality: bump
     age-locked: <pkg>" "Version <ver> not yet $MIN_BUMP_AGE_DAYS days old. Retry next run."
   - Only bump if lockfile resolves cleanly.

2. Run the formatter (prettier/ruff/gofmt as appropriate) with auto-fix in $wt_dir.
   Capture a line count of changes.

3. Run linter auto-fix if safe (eslint --fix, ruff --fix, etc.). Do NOT apply
   fixes that change semantics — format-only is fine; logic changes are not.

4. Run the test suite (bun test / cargo test / pytest / go test ./...) to confirm
   the worktree is green after the changes. If tests fail, revert the changes,
   file a HITL with: terminal-cli hitl "deps-quality: bump broke tests @ $short"
   "Tests failed after applying safe bumps. Reverted. Manual review needed."
   and exit.

5. If there are any changes in the worktree after steps 1-3 AND tests pass:
   a. Commit: "chore(deps): bump N packages + lint sweep"
   b. Push the branch to origin.
   c. Open a PR with title "chore(deps): bump N packages + lint sweep @ $short".
      PR body should list: packages bumped, formatter changes, linter changes.
   d. File an activity event:
      terminal-cli activity check "Deps-quality · PR opened" "N bumps + lint @ $short"

6. Write the report to $report with this frontmatter:
---
kind: deps-quality
generated: <ISO timestamp>
sha: $short
pkg_manager: $pkg_manager
advisories_total: $advisory_count
critical_cves: 0
high_cves: 0
deps:
  bumped: <count>
  age_locked: <count>
quality:
  format_fixes: <count>
  lint_fixes: <count>
pr_opened: <url or "none">
tickets_filed: [<list>]
status: ok
---

If nothing changed (all bumps age-locked, formatter clean), write the report
with status: ok and pr_opened: none, then emit:
  terminal-cli activity check "Deps-quality · clean" "No changes needed @ $short"

7. NEVER touch: Critical/High advisories (those are under human review via HITL),
   major version bumps, or any file outside $wt_dir.
EOF

claude -p "$(<"$sonnet_prompt")" \
  --dangerously-skip-permissions \
  --model "$MODEL_SONNET"
sonnet_exit=$?

rm -f "$sonnet_prompt"

# ---------------------------------------------------------------------------
# 5. RECORD STATE
# ---------------------------------------------------------------------------
terminal-cli state mark-main

if [ -f "$report" ]; then
  bumped=$(grep -E '^\s+bumped:\s+[0-9]+' "$report" | awk '{print $2+0}' | head -1 || echo 0)
  terminal-cli state set lastBumped "${bumped:-0}" >/dev/null || true
fi

exit $sonnet_exit

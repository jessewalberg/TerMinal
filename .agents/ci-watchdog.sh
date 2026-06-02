#!/usr/bin/env bash
# ci-watchdog — classify a failed CI pipeline log and attempt a cheap auto-fix
# (v0: prettier-formatting only) or file HITL. Invoked detached by the
# TerMinal CI webhook receiver when GitLab reports a failed pipeline.
set -uo pipefail

MAX_FIXES=3
# v0 allowlist — broaden one class at a time after a week of clean dry-run logs.
ALLOWED_CLASSES="prettier-formatting"

if [[ -z "${TERMINAL_REPO:-}" || -z "${CI_PIPELINE_ID:-}" ]]; then
  echo "ci-watchdog: TERMINAL_REPO and CI_PIPELINE_ID required" >&2
  exit 2
fi

# Dry-run flag lives in agent state — set via:
#   terminal-cli state set dryRun false
_dry_run_val=$(terminal-cli state get dryRun 2>/dev/null || true)
dry_run=true
if [[ "$_dry_run_val" == "false" ]]; then
  dry_run=false
fi

# 1. Fetch the failed pipeline log (GitLab)
log=""
if command -v glab >/dev/null 2>&1; then
  log=$(glab ci view --log "$CI_PIPELINE_ID" 2>&1 | tail -500 || true)
fi
if [[ -z "$log" ]]; then
  log="(no glab log — CI_PIPELINE_ID=${CI_PIPELINE_ID})"
fi

# 2. Classify — heuristic via terminal-cli, LLM fallback when ambiguous
tmp=$(mktemp)
printf '%s' "$log" >"$tmp"
class=$(terminal-cli classify ci "$tmp" 2>/dev/null || echo ambiguous)
rm -f "$tmp"

# Known label allowlist — keep in sync with the case statement below.
_LABEL_ALLOWLIST=(
  prettier-formatting eslint-fixable typecheck-isolated snapshot-mismatch
  test-real build-config deploy-infra dependency lockfile-drift flake-network
  ambiguous
)

# normalize_llm_class <raw_output>
# Case-insensitively searches raw LLM output for the first allowlisted token.
# Prints the matched label, or prints nothing on failure.
normalize_llm_class() {
  local raw label
  raw=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  for label in "${_LABEL_ALLOWLIST[@]}"; do
    if printf '%s' "$raw" | grep -qF "$label"; then
      printf '%s' "$label"
      return 0
    fi
  done
  return 1
}

# Precheck: in dry-run mode, skip the LLM entirely — just record and exit.
if [[ "$dry_run" == true && "$class" != "ambiguous" ]]; then
  mr_label="${CI_MR_IID:+!$CI_MR_IID}"
  would_action="hitl"
  if [[ " $ALLOWED_CLASSES " == *" $class "* ]]; then
    would_action="autofix-$class"
  fi
  terminal-cli activity check "CI dry-run · $class" \
    "Pipeline ${CI_PIPELINE_ID}${mr_label:+ · MR $mr_label} · would ${would_action}"
  exit 0
fi

if [[ "$class" == "ambiguous" ]] && command -v claude >/dev/null 2>&1; then
  _llm_raw=$(
    claude -p "Classify this CI failure into EXACTLY ONE label from the list below.
Reply with ONLY the label, nothing else — no punctuation, no explanation.

Labels: prettier-formatting, eslint-fixable, typecheck-isolated, snapshot-mismatch, test-real, build-config, deploy-infra, dependency, lockfile-drift, flake-network, ambiguous

Examples:
  Input: \"error: Replace \`foo\` with \`bar\`  prettier/prettier\"
  Output: prettier-formatting

  Input: \"Error: Cannot find module './missing'\"
  Output: build-config

Log:
$log" \
      --dangerously-skip-permissions --model haiku 2>/dev/null || true
  )
  _matched=$(normalize_llm_class "$_llm_raw" || true)
  if [[ -n "$_matched" ]]; then
    class="$_matched"
  else
    class=ambiguous
    terminal-cli activity info "CI watchdog · unparseable LLM classification" \
      "Haiku replied: $(printf '%s' "$_llm_raw" | head -c 120 | tr -d '\n') — falling back to HITL" 2>/dev/null || true
  fi
fi

terminal-cli state set "lastClass-${CI_MR_IID:-none}" "$class" >/dev/null

mr_label="${CI_MR_IID:+!$CI_MR_IID}"
fix_key="fixCount-${CI_MR_IID:-none}"
fix_count=$(terminal-cli state get "$fix_key" 2>/dev/null || echo 0)
fix_count=${fix_count:-0}

would_action="hitl"
if [[ " $ALLOWED_CLASSES " == *" $class "* ]]; then
  would_action="autofix-$class"
fi

# Post-LLM dry-run exit: class was resolved via LLM — record and stop.
if [[ "$dry_run" == true ]]; then
  terminal-cli activity check "CI dry-run · $class" \
    "Pipeline ${CI_PIPELINE_ID}${mr_label:+ · MR $mr_label} · would ${would_action}"
  exit 0
fi

# 3. Branch by class (live mode)
case "$class" in
  prettier-formatting)
    if [[ "$fix_count" -ge "$MAX_FIXES" ]]; then
      terminal-cli hitl "CI auto-fix cap reached${mr_label:+ · MR $mr_label}" \
        "Already auto-fixed ${fix_count} times for this MR. Class: ${class}. Pipeline ${CI_PIPELINE_ID}."
      exit 0
    fi
    if [[ -z "${CI_BRANCH:-}" ]]; then
      terminal-cli hitl "CI red · no branch${mr_label:+ · MR $mr_label}" \
        "Pipeline ${CI_PIPELINE_ID} failed (prettier) but CI_BRANCH was empty."
      exit 0
    fi
    wt=$(mktemp -d)
    trap 'rm -rf "$wt"' EXIT
    git -C "$TERMINAL_REPO" fetch origin "$CI_BRANCH" 2>/dev/null || true
    git -C "$TERMINAL_REPO" worktree add "$wt" "origin/$CI_BRANCH" 2>/dev/null \
      || git -C "$TERMINAL_REPO" worktree add "$wt" "$CI_BRANCH"
    cd "$wt" || exit 1
    bunx prettier --write . 2>/dev/null || npx prettier --write . 2>/dev/null || true
    if git diff --quiet; then
      terminal-cli hitl "CI prettier class but no diff${mr_label:+ · MR $mr_label}" \
        "Pipeline ${CI_PIPELINE_ID} looked like prettier but nothing to format."
      exit 0
    fi
    git commit -am 'chore: prettier'
    git push origin "HEAD:$CI_BRANCH"
    if [[ -n "${CI_MR_IID:-}" ]] && command -v glab >/dev/null 2>&1; then
      glab mr note "$CI_MR_IID" -m "🤖 Auto-fixed prettier" 2>/dev/null || true
    fi
    terminal-cli activity check "CI auto-fix · prettier" "MR ${mr_label:-$CI_BRANCH}"
    terminal-cli state set "$fix_key" "$((fix_count + 1))" >/dev/null
    ;;
  test-real|ambiguous|*)
    terminal-cli hitl "CI red${mr_label:+ · MR $mr_label} · $class" \
      "Pipeline ${CI_PIPELINE_ID} failed. Class: ${class}.
Last lines: $(echo "$log" | tail -20)"
    ;;
esac

exit 0

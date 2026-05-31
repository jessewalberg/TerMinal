#!/usr/bin/env bash
# ci-watchdog — classify a failed CI pipeline log and attempt a cheap auto-fix
# (v0: prettier-formatting only) or file HITL. Invoked detached by the
# TerMinal CI webhook receiver when GitLab reports a failed pipeline.
set -uo pipefail

CFG="${HOME}/.config/TerMinal/ci-watchdog.json"
DRYRUN_LOG="${HOME}/.config/TerMinal/ci-watchdog-dryrun.jsonl"
MAX_FIXES=3
# v0 allowlist — broaden one class at a time after a week of clean dry-run logs.
ALLOWED_CLASSES="prettier-formatting"

if [[ -z "${TERMINAL_REPO:-}" || -z "${CI_PIPELINE_ID:-}" ]]; then
  echo "ci-watchdog: TERMINAL_REPO and CI_PIPELINE_ID required" >&2
  exit 2
fi

dry_run=true
if [[ -f "$CFG" ]]; then
  if grep -q '"dryRun"[[:space:]]*:[[:space:]]*false' "$CFG" 2>/dev/null; then
    dry_run=false
  fi
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

if [[ "$class" == "ambiguous" ]] && command -v claude >/dev/null 2>&1; then
  class=$(
    claude -p "Classify this CI failure into ONE label: prettier-formatting, eslint-fixable, typecheck-isolated, snapshot-mismatch, test-real, build-config, deploy-infra, ambiguous.

Log:
$log" \
      --dangerously-skip-permissions --model haiku 2>/dev/null | tr -d '\n' || echo ambiguous
  )
fi

class=$(echo "$class" | tr -d '[:space:]')
[[ -z "$class" ]] && class=ambiguous

terminal-cli state set "lastClass-${CI_MR_IID:-none}" "$class" >/dev/null

mr_label="${CI_MR_IID:+!$CI_MR_IID}"
fix_key="fixCount-${CI_MR_IID:-none}"
fix_count=$(terminal-cli state get "$fix_key" 2>/dev/null || echo 0)
fix_count=${fix_count:-0}

would_action="hitl"
if [[ " $ALLOWED_CLASSES " == *" $class "* ]]; then
  would_action="autofix-$class"
fi

record_dryrun() {
  mkdir -p "$(dirname "$DRYRUN_LOG")"
  ts=$(($(date +%s) * 1000))
  printf '{"ts":%s,"repo":"%s","pipeline":"%s","mr":"%s","class":"%s","action":"%s"}\n' \
    "$ts" "$(basename "$TERMINAL_REPO")" "$CI_PIPELINE_ID" "${CI_MR_IID:-}" "$class" "$would_action" \
    >>"$DRYRUN_LOG"
  terminal-cli activity check "CI dry-run · $class" \
    "Pipeline ${CI_PIPELINE_ID}${mr_label:+ · MR $mr_label} · would ${would_action}"
}

if [[ "$dry_run" == true ]]; then
  record_dryrun
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

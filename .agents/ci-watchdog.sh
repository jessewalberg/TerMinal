#!/usr/bin/env bash
# ci-watchdog — self-healing CI agent (ticket #0005).
# Triggered by the dashboard webhook shim on failed pipeline events.
# Classifies the failure, auto-fixes allowlisted classes, or files HITL.
set -uo pipefail

CFG="${HOME}/.config/TerMinal"
DRYRUN_CFG="${CFG}/ci-watchdog.json"
DRYRUN_LOG="${CFG}/ci-watchdog-dryrun.jsonl"
MAX_AUTOFIXES=3
# v0 allowlist — broaden one class at a time after a week of clean operation.
ALLOWLIST=(prettier-formatting)

: "${TERMINAL_REPO:?TERMINAL_REPO required}"
: "${CI_PIPELINE_ID:?CI_PIPELINE_ID required}"
: "${TERMINAL_AGENT_ID:=ci-watchdog}"

read_dry_run() {
  if [[ ! -f "$DRYRUN_CFG" ]]; then
    echo true
    return
  fi
  bun -e "const j=JSON.parse(require('fs').readFileSync('${DRYRUN_CFG}','utf8')); process.stdout.write(j.dryRun!==false?'true':'false')" 2>/dev/null || echo true
}

DRY_RUN=$(read_dry_run)

log_dryrun() {
  local action="$1" class="$2"
  mkdir -p "$CFG"
  bun -e "
    const fs=require('fs');
    const line=JSON.stringify({ts:Date.now(),repo:'$(basename "$TERMINAL_REPO")',pipeline:'${CI_PIPELINE_ID}',mr:'${CI_MR_IID:-}',branch:'${CI_BRANCH:-}',class:'$class',action:'$action',dryRun:true})+'\n';
    fs.appendFileSync('${DRYRUN_LOG}', line);
  " 2>/dev/null || true
}

# 1. Fetch the failed pipeline log (tail keeps token cost down for classification).
log_file=$(mktemp)
trap 'rm -f "$log_file"' EXIT
if ! glab ci view --log "$CI_PIPELINE_ID" >"$log_file" 2>&1; then
  tail -500 "$log_file" >"${log_file}.tail" && mv "${log_file}.tail" "$log_file"
fi
tail -500 "$log_file" >"${log_file}.tail" && mv "${log_file}.tail" "$log_file"
log=$(cat "$log_file")

# 2. Classify — deterministic heuristics first (free), haiku fallback on ambiguous.
class=$(terminal-cli classify ci "$log_file" 2>/dev/null | tr -d '\n' || echo ambiguous)
if [[ "$class" == "ambiguous" ]] && command -v claude >/dev/null 2>&1; then
  class=$(claude -p "Classify this CI failure into ONE label: prettier-formatting, eslint-fixable, typecheck-isolated, snapshot-mismatch, test-real, build-config, deploy-infra, ambiguous.

Log:
$log" --dangerously-skip-permissions --model haiku 2>/dev/null | tr -d '\n' || echo ambiguous)
fi

terminal-cli state set "lastClass-${CI_MR_IID:-none}" "$class" 2>/dev/null || true

allowed=false
for a in "${ALLOWLIST[@]}"; do
  [[ "$class" == "$a" ]] && allowed=true && break
done

# Per-MR auto-fix cap
fix_count=0
if [[ -n "${CI_MR_IID:-}" ]]; then
  fix_count=$(terminal-cli state get "autofixCount-${CI_MR_IID}" 2>/dev/null || echo 0)
  fix_count=${fix_count:-0}
fi

would_autofix=false
if $allowed && [[ "$fix_count" -lt "$MAX_AUTOFIXES" ]] && [[ -n "${CI_BRANCH:-}" ]] && [[ -n "${CI_MR_IID:-}" ]]; then
  would_autofix=true
fi

if [[ "$DRY_RUN" == "true" ]]; then
  if $would_autofix; then
    log_dryrun "autofix-prettier" "$class"
    terminal-cli activity check "CI auto-fix (dry-run) · $class" "Would prettier-fix MR !${CI_MR_IID} · pipeline ${CI_PIPELINE_ID}"
  else
    log_dryrun "hitl" "$class"
    terminal-cli activity check "CI watchdog (dry-run) · $class" "Would HITL MR !${CI_MR_IID:-?} · pipeline ${CI_PIPELINE_ID}"
  fi
  exit 0
fi

# 3. Branch by class (live mode)
case "$class" in
  prettier-formatting)
    if ! $would_autofix; then
      terminal-cli hitl "CI red on MR !${CI_MR_IID:-?} · $class (cap or missing MR/branch)" \
        "Pipeline $CI_PIPELINE_ID failed. Class: $class. Auto-fix skipped (count=$fix_count)."
      exit 0
    fi
    wt=$(mktemp -d)
    trap 'rm -rf "$wt"' EXIT
    git -C "$TERMINAL_REPO" worktree add "$wt" "$CI_BRANCH"
    cd "$wt" || exit 1
    bunx prettier --write . 2>/dev/null || prettier --write . 2>/dev/null || true
    if git diff --quiet; then
      terminal-cli hitl "CI prettier class but no diff · MR !${CI_MR_IID}" \
        "Pipeline $CI_PIPELINE_ID · class=$class but prettier made no changes."
      exit 0
    fi
    git commit -am 'chore: prettier'
    git push origin "$CI_BRANCH"
    glab mr note "$CI_MR_IID" -m "🤖 Auto-fixed prettier" 2>/dev/null || true
    terminal-cli activity check "CI auto-fix · prettier" "MR !${CI_MR_IID}"
    terminal-cli state set "autofixCount-${CI_MR_IID}" "$((fix_count + 1))" 2>/dev/null || true
    ;;
  test-real|ambiguous|*)
    terminal-cli hitl "CI red on MR !${CI_MR_IID:-?} · $class" \
      "Pipeline $CI_PIPELINE_ID failed. Class: $class. Last lines: $(echo "$log" | tail -20)"
    ;;
esac

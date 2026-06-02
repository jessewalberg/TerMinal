#!/usr/bin/env bash
# perf — benchmark regression checker.
# Contract: .agents/perf.md
#
# COST LADDER:
#   Tier 0  Deterministic precheck (no LLM) — incremental skip, no-bench guard,
#           baseline compare, threshold check.  exit 0 when nothing to do.
#   Tier 1  haiku — one-line culprit hypothesis per regressing benchmark.
#   Tier 2  sonnet — draft opt-in fix-attempt PR. CEILING: never opus.
#           Gated by DETERMINISTIC condition (see Fix-PR gate section).
#
# Fix-PR gate (deterministic — not model judgement):
#   File .agents/perf/config.json with { "openPrOnRegression": true }
#   AND the regression name matches a pattern in .agents/perf/fix-patterns.json.
#   Both conditions must be true; if either is absent/false the PR is skipped.
#
# PR ceiling: at most MAX_PR_PER_RUN (default 1) fix PRs per agent run.
#
# SELF-DISABLE: if no benchmark script is discoverable (package.json bench,
#   bench/ dir, Cargo.toml [[bench]]) → write not-configured artifact + exit 0.
#   This makes the agent a clean no-op on repos with no bench setup.
#
# Runner env (set by TerMinal):
#   TERMINAL_REPO      repo root
#   TERMINAL_AGENT_ID  this agent's id ("perf")
#   TERMINAL_RUN_ID    run uuid
#   TERMINAL_BRANCH    worktree branch (or "main" if inPlace)
#   TERMINAL_WORKTREE  worktree path
#   TERMINAL_ENGINE    "claude" | "codex"
#   TERMINAL_MODEL     model hint (honoured for sonnet-tier calls; ceiling: sonnet)

set -uo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
HAIKU_MODEL="claude-haiku-4-5"
SONNET_MODEL="claude-sonnet-4-5"
MAX_PR_PER_RUN=1
DEFAULT_THRESHOLD=10   # percent

REPO="${TERMINAL_REPO:-$(git rev-parse --show-toplevel)}"
REPO_NAME=$(basename "$REPO")
WORKTREES_DIR="${WORKTREES_DIR:-$HOME/.worktrees}"

CONFIG_JSON="$REPO/.agents/perf/config.json"
BASELINE_JSON="$REPO/.agents/perf/baseline.json"
FIX_PATTERNS_JSON="$REPO/.agents/perf/fix-patterns.json"

# ── Cleanup trap ──────────────────────────────────────────────────────────────
wt_path=""
# shellcheck disable=SC2329  # invoked via trap below
_perf_cleanup() {
  if [[ -n "$wt_path" ]] && [[ -d "$wt_path" ]] && [[ "$wt_path" != "$REPO" ]]; then
    git -C "$REPO" worktree remove --force "$wt_path" 2>/dev/null || true
  fi
}
trap _perf_cleanup EXIT

# ── Tier-0: incremental-skip ──────────────────────────────────────────────────
last=$(terminal-cli state get-sha)

git -C "$REPO" fetch --quiet origin || true
head=$(git -C "$REPO" rev-parse origin/main 2>/dev/null \
    || git -C "$REPO" rev-parse origin/master 2>/dev/null \
    || git -C "$REPO" rev-parse HEAD)

if [[ "$head" = "$last" ]]; then
  echo "perf: no new commits since $last — nothing to benchmark."
  exit 0
fi

short=$(git -C "$REPO" rev-parse --short "$head")

# ── Tier-0: discover benchmark script ────────────────────────────────────────
bench_runner=""

if [[ -f "$REPO/package.json" ]]; then
  has_bench=$(python3 -c "
import json, sys
try:
    d = json.load(open('$REPO/package.json'))
    print('yes' if d.get('scripts', {}).get('bench') else 'no')
except Exception:
    print('no')
" 2>/dev/null || echo "no")
  if [[ "$has_bench" == "yes" ]]; then
    bench_runner="bun"
  fi
fi

if [[ -z "$bench_runner" ]] && [[ -d "$REPO/bench" ]] && [[ -f "$REPO/package.json" ]]; then
  bench_runner="bun-bench-dir"
fi

if [[ -z "$bench_runner" ]] && [[ -f "$REPO/Cargo.toml" ]]; then
  if grep -q '\[\[bench\]\]' "$REPO/Cargo.toml" 2>/dev/null; then
    bench_runner="cargo"
  fi
fi

if [[ -z "$bench_runner" ]]; then
  # Self-disable: not-configured is not a failure
  mkdir -p "$REPO/reports/perf"
  printf -- '---\nkind: perf\nsha: %s\nstatus: not-configured\n---\n\nNo benchmark script found.\n' \
    "$short" > "$REPO/reports/perf/${short}.md"
  terminal-cli activity info "Perf · not configured" "No bench script in $REPO_NAME — skipping"
  terminal-cli state mark-main
  exit 0
fi

# ── Tier-0: read config ───────────────────────────────────────────────────────
threshold=$DEFAULT_THRESHOLD
open_pr_on_regression=false

if [[ -f "$CONFIG_JSON" ]]; then
  parsed=$(python3 -c "
import json, sys
try:
    d = json.load(open('$CONFIG_JSON'))
    print(d.get('threshold', $DEFAULT_THRESHOLD))
    print('true' if d.get('openPrOnRegression', False) else 'false')
except Exception:
    print($DEFAULT_THRESHOLD)
    print('false')
" 2>/dev/null || printf '%s\nfalse\n' "$DEFAULT_THRESHOLD")
  threshold=$(printf '%s\n' "$parsed" | sed -n '1p')
  open_pr_on_regression=$(printf '%s\n' "$parsed" | sed -n '2p')
fi

# ── Worktree setup ────────────────────────────────────────────────────────────
wt_path="${WORKTREES_DIR}/${REPO_NAME}/perf-${short}"
mkdir -p "${WORKTREES_DIR}/${REPO_NAME}"

if ! git -C "$REPO" worktree add "$wt_path" "$head" 2>/dev/null; then
  wt_path="$REPO"
fi

# Install deps if needed
if [[ "$bench_runner" == bun* ]] && [[ -f "$wt_path/package.json" ]]; then
  bun install --cwd "$wt_path" --frozen-lockfile 2>/dev/null || true
fi

# ── Tier-0: run benchmark ─────────────────────────────────────────────────────
bench_out=$(mktemp)
bench_exit=0

case "$bench_runner" in
  bun|bun-bench-dir)
    bun run bench --cwd "$wt_path" >"$bench_out" 2>&1 || bench_exit=$?
    ;;
  cargo)
    cargo bench --manifest-path "$wt_path/Cargo.toml" >"$bench_out" 2>&1 || bench_exit=$?
    ;;
  *)
    echo "perf: unknown bench_runner '$bench_runner'" >&2
    bench_exit=1
    ;;
esac

if [[ $bench_exit -ne 0 ]]; then
  terminal-cli hitl "Perf · benchmark run failed" \
    "Exit $bench_exit for $REPO_NAME @ $short. Check reports/perf/${short}.md."
  mkdir -p "$REPO/reports/perf"
  {
    printf -- '---\nkind: perf\nsha: %s\nstatus: bench-error\nbench_exit: %s\n---\n\n```\n' \
      "$short" "$bench_exit"
    cat "$bench_out"
    printf '```\n'
  } > "$REPO/reports/perf/${short}.md"
  rm -f "$bench_out"
  terminal-cli state mark-main
  exit 0
fi

bench_output=$(<"$bench_out")
rm -f "$bench_out"

# ── Tier-0: parse benchmark output to JSON ────────────────────────────────────
# Handles common formats:
#   Bun bench:  "name  12.34 ns/iter (+/- 0.1)"
#   Vitest:     "name x 1,234 ops/sec"
#   Criterion:  "name  time:  [1.23 ms ...]"  (extracts median)
# Normalises all results to ops/sec equivalent (higher=faster).
parse_script=$(mktemp)
cat > "$parse_script" <<'PYEOF'
import sys, re, json

results = {}
for line in sys.stdin:
    line = line.strip()
    # Bun/generic: "name  123.45 ns/iter" or "name  123.45 ops/sec"
    m = re.match(r'^(.+?)\s{2,}([\d,]+\.?\d*)\s+(ns/iter|ops/sec|ms/iter|µs/iter)', line)
    if m:
        name = m.group(1).strip()
        val  = float(m.group(2).replace(',', ''))
        unit = m.group(3)
        if   unit == 'ns/iter': val = 1e9 / val if val else 0
        elif unit == 'µs/iter': val = 1e6 / val if val else 0
        elif unit == 'ms/iter': val = 1e3 / val if val else 0
        results[name] = round(val, 4)
        continue
    # Vitest ops/sec style: "name  x  1,234 ops/sec"
    m = re.match(r'^(.+?)\s+x\s+([\d,]+\.?\d*)\s+ops/sec', line)
    if m:
        name = m.group(1).strip()
        val  = float(m.group(2).replace(',', ''))
        results[name] = round(val, 4)
        continue

print(json.dumps(results))
PYEOF

results_json=$(printf '%s\n' "$bench_output" | python3 "$parse_script")
rm -f "$parse_script"

# ── Tier-0: compare to baseline ───────────────────────────────────────────────
regressions=()
improvements=0
comparison_possible=false

if [[ -f "$BASELINE_JSON" ]]; then
  comparison_possible=true
  compare_script=$(mktemp)
  cat > "$compare_script" <<PYEOF
import sys, json

baseline_path = sys.argv[1]
results_json  = sys.argv[2]
threshold     = float(sys.argv[3])

try:
    current  = json.loads(results_json)
    baseline = json.load(open(baseline_path))
except Exception as e:
    sys.stderr.write(f"compare: {e}\n")
    sys.exit(0)

for name, bval in baseline.items():
    cval = current.get(name)
    if cval is None or bval == 0:
        continue
    pct = (cval - bval) / bval * 100.0
    if pct < -threshold:
        print(f"R|{name}|{pct:.1f}")
    elif pct > threshold:
        print(f"I|{name}|{pct:.1f}")
PYEOF

  while IFS='|' read -r kind bname delta; do
    [[ -z "$kind" ]] && continue
    if [[ "$kind" == "R" ]]; then
      regressions+=("${bname}|${delta}")
    elif [[ "$kind" == "I" ]]; then
      improvements=$((improvements + 1))
    fi
  done < <(python3 "$compare_script" "$BASELINE_JSON" "$results_json" "$threshold" 2>/dev/null || true)
  rm -f "$compare_script"
fi

regression_count=${#regressions[@]}

# ── Tier-0: update baseline (first run or net improvement) ───────────────────
if [[ "$comparison_possible" == "false" ]] || \
   [[ $regression_count -eq 0 && $improvements -gt 0 ]]; then
  if [[ -n "$results_json" ]] && [[ "$results_json" != "{}" ]]; then
    mkdir -p "$REPO/.agents/perf"
    printf '%s\n' "$results_json" > "$BASELINE_JSON"
  fi
fi

# ── Tier-0: write artifact ────────────────────────────────────────────────────
report_dir="$REPO/reports/perf"
mkdir -p "$report_dir"
report_file="$report_dir/${short}.md"

{
  printf -- '---\nkind: perf\nsha: %s\nlast_scanned: %s\nregressions: %s\nimprovements: %s\nthreshold_pct: %s\nstatus: %s\n---\n\n' \
    "$short" "${last:-none}" "$regression_count" "$improvements" "$threshold" \
    "$([ "$regression_count" -eq 0 ] && echo ok || echo regression)"
  if [[ $regression_count -gt 0 ]]; then
    printf '## Regressions\n\n'
    for entry in "${regressions[@]}"; do
      bname=$(printf '%s' "$entry" | cut -d'|' -f1)
      bdelta=$(printf '%s' "$entry" | cut -d'|' -f2)
      printf -- '- **%s** — \xce\x94 %s%%\n' "$bname" "$bdelta"
    done
    printf '\n'
  fi
  # shellcheck disable=SC2016  # \n inside printf format is intentional
  printf '## Benchmark output\n\n```\n%s\n```\n' "$bench_output"
} > "$report_file"

# ── Tier-0: exit early when no regression ────────────────────────────────────
if [[ $regression_count -eq 0 ]]; then
  terminal-cli activity check \
    "Perf · 0 regressions · ${improvements} wins" \
    "@ $short"
  terminal-cli state mark-main
  exit 0
fi

# ── Tier-1: haiku — one-line culprit hypothesis ───────────────────────────────
commit_log=$(git -C "$REPO" log --oneline "${last:-HEAD~50}..${head}" 2>/dev/null \
  | head -40 || true)

regression_list=$(printf '%s\n' "${regressions[@]}")

hypothesis=""
if command -v claude >/dev/null 2>&1; then
  hyp_prompt=$(mktemp)
  cat > "$hyp_prompt" <<PROMPT
You are a performance engineer. Given these benchmark regressions and the recent
commit log, reply with ONE sentence identifying the most likely culprit commit and why.

Regressions (name|delta_pct):
${regression_list}

Recent commits:
${commit_log}

Reply format: "Likely caused by <commit-sha> — <one-line reason>."
If you cannot determine the cause, reply: "Culprit unclear — multiple commits touched relevant paths."
PROMPT
  hypothesis=$(claude -p "$(<"$hyp_prompt")" \
    --dangerously-skip-permissions --model "${HAIKU_MODEL}" 2>/dev/null || true)
  rm -f "$hyp_prompt"
fi

if [[ -n "$hypothesis" ]]; then
  printf '\n## Culprit hypothesis\n\n%s\n' "$hypothesis" >> "$report_file"
fi

# File a ticket per regressing benchmark
tickets_filed=()
for entry in "${regressions[@]}"; do
  bname=$(printf '%s' "$entry" | cut -d'|' -f1)
  bdelta=$(printf '%s' "$entry" | cut -d'|' -f2)
  title="perf regression: ${bname} (${bdelta}%) @ ${short}"
  body="Benchmark **${bname}** regressed by **${bdelta}%** at commit ${short}.

Range: ${last:-HEAD~50}..${head}

${hypothesis:+Hypothesis: ${hypothesis}

}Report: reports/perf/${short}.md"
  terminal-cli ticket "$title" "$body"
  tickets_filed+=("$title")
done

# ── Tier-2: sonnet — fix-attempt PR (deterministic gate) ─────────────────────
# Gate 1: openPrOnRegression == true in .agents/perf/config.json
# Gate 2: regression name matches a pattern in .agents/perf/fix-patterns.json
# Gate 3: pr_count < MAX_PR_PER_RUN
# Failure of any gate = silent skip. No model judgement involved.
pr_count=0

if [[ "$open_pr_on_regression" == "true" ]] && [[ -f "$FIX_PATTERNS_JSON" ]]; then
  fix_patterns=$(python3 -c "
import json
try:
    pats = json.load(open('$FIX_PATTERNS_JSON'))
    print('\n'.join(pats) if isinstance(pats, list) else '')
except Exception:
    pass
" 2>/dev/null || true)

  if [[ -n "$fix_patterns" ]]; then
    matched_regression=""
    matched_pattern=""
    for entry in "${regressions[@]}"; do
      bname=$(printf '%s' "$entry" | cut -d'|' -f1)
      while IFS= read -r pat; do
        [[ -z "$pat" ]] && continue
        if printf '%s' "$bname" | grep -qiF "$pat" 2>/dev/null; then
          matched_regression="$bname"
          matched_pattern="$pat"
          break 2
        fi
      done < <(printf '%s\n' "$fix_patterns")
    done

    if [[ -n "$matched_regression" ]] && [[ $pr_count -lt $MAX_PR_PER_RUN ]]; then
      matched_delta=""
      for entry in "${regressions[@]}"; do
        if printf '%s' "$entry" | grep -qF "$matched_regression"; then
          matched_delta=$(printf '%s' "$entry" | cut -d'|' -f2)
          break
        fi
      done

      # Sonnet ceiling — reject any opus variant
      fix_model="${TERMINAL_MODEL:-$SONNET_MODEL}"
      if printf '%s' "$fix_model" | grep -qi "opus"; then
        fix_model="$SONNET_MODEL"
      fi

      fix_branch="perf/fix-${matched_regression//[^a-zA-Z0-9]/-}-${short}"
      fix_branch="${fix_branch:0:80}"

      fix_prompt=$(mktemp)
      cat > "$fix_prompt" <<PROMPT
You are a performance engineer working in the repo at $REPO.

Benchmark regression detected:
  Name:    $matched_regression
  Delta:   ${matched_delta}%
  Pattern: $matched_pattern

${hypothesis:+Culprit hypothesis: ${hypothesis}

}Recent commits:
$commit_log

Benchmark output (excerpt):
$(printf '%s\n' "$bench_output" | head -100)

Task:
1. Create a new git branch named: $fix_branch
2. Investigate source code related to the "$matched_regression" benchmark.
3. Apply the minimal fix that restores performance without changing behaviour.
   Do NOT edit benchmark files. Do NOT widen the regression threshold.
4. Commit with message: "perf: fix $matched_regression regression @ $short"
5. Push the branch.
6. Open a PR (use 'gh pr create' or 'glab mr create' per the repo forge) with
   title "perf: fix $matched_regression regression" and a body summarising the
   change and expected benchmark improvement.
7. Run: terminal-cli activity check "Perf · fix PR opened" "branch: $fix_branch"

If you cannot identify a safe minimal fix, do NOT open the PR — instead run:
  terminal-cli hitl "Perf · fix unclear for $matched_regression" \
    "Delta ${matched_delta}%, pattern $matched_pattern. Manual investigation needed."
PROMPT

      claude -p "$(<"$fix_prompt")" \
        --dangerously-skip-permissions \
        --model "$fix_model"
      rm -f "$fix_prompt"
      pr_count=$((pr_count + 1))
    fi
  fi
fi

# ── Finalize ──────────────────────────────────────────────────────────────────
if [[ ${#tickets_filed[@]} -gt 0 ]]; then
  {
    printf '\n## Tickets filed\n\n'
    for t in "${tickets_filed[@]}"; do
      printf -- '- %s\n' "$t"
    done
  } >> "$report_file"
fi

reg_s="$([ "$regression_count" -ne 1 ] && echo s || true)"
imp_s="$([ "$improvements" -ne 1 ] && echo s || true)"
terminal-cli activity check \
  "Perf · ${regression_count} regression${reg_s} · ${improvements} win${imp_s}" \
  "@ $short — see reports/perf/${short}.md"

terminal-cli state mark-main
terminal-cli state set lastRegressionCount "$regression_count"
terminal-cli state set lastImprovementCount "$improvements"

exit 0

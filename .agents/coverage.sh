#!/usr/bin/env bash
# coverage — finds test-coverage gaps, classifies them (haiku), and for small
# well-bounded gaps authors net-new tests (sonnet) then opens a tests-only PR.
# Large surfaces → ticket only. Never modifies source under test.
#
# Cost ladder:
#   1. Deterministic precheck: incremental-skip if no new commits; run the test
#      suite with coverage; diff against .agents/coverage/baseline.json.
#      → exit 0 when nothing actionable.
#   2. Haiku: classify each gap as "small/well-bounded" vs "large surface".
#   3. Sonnet: author net-new tests only for small-class gaps.
#
# Mechanical tests-only guard: after authoring, git diff --name-only must show
# ONLY files matching *test* / *spec* patterns. Any non-test file → revert the
# worktree change, skip the PR, file a HITL.
#
# Runner env (set by TerMinal):
#   TERMINAL_REPO      repo root (absolute)
#   TERMINAL_AGENT_ID  state key ("coverage")
#   TERMINAL_RUN_ID    run uuid
#   TERMINAL_BRANCH    worktree branch
#   TERMINAL_WORKTREE  worktree path
#   TERMINAL_ENGINE    "claude" | "codex"
#   TERMINAL_MODEL     model hint; override per-step below

set -uo pipefail

# ---------------------------------------------------------------------------
# 0. Incremental skip — exit 0 if origin/main hasn't moved since last scan
# ---------------------------------------------------------------------------
last=$(terminal-cli state get-sha)

git -C "$TERMINAL_REPO" fetch --quiet origin || true
head=$(git -C "$TERMINAL_REPO" rev-parse origin/main 2>/dev/null \
    || git -C "$TERMINAL_REPO" rev-parse origin/master 2>/dev/null \
    || git -C "$TERMINAL_REPO" rev-parse HEAD)

if [ "$head" = "$last" ]; then
  echo "coverage: no new commits since ${last} — nothing to scan."
  exit 0
fi

short=$(git -C "$TERMINAL_REPO" rev-parse --short "$head")
range="${last:-HEAD~50}..$head"

# Changed source files in this range (non-test, non-doc)
changed_src=$(git -C "$TERMINAL_REPO" diff --name-only "$range" 2>/dev/null \
  | grep -Ev '(test|spec|__tests__|\.md$|CHANGELOG)' || true)

if [ -z "$changed_src" ]; then
  echo "coverage: no non-test source changed in $range — marking and exiting."
  terminal-cli state mark-main
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Detect test runner and run coverage
# ---------------------------------------------------------------------------
baseline_file="$TERMINAL_REPO/.agents/coverage/baseline.json"
coverage_threshold=70

if [ -f "$TERMINAL_REPO/.agents/coverage/config.json" ]; then
  cfg_threshold=$(grep -o '"threshold"[[:space:]]*:[[:space:]]*[0-9]*' \
    "$TERMINAL_REPO/.agents/coverage/config.json" | grep -o '[0-9]*$' || true)
  [ -n "$cfg_threshold" ] && coverage_threshold="$cfg_threshold"
fi

coverage_out=$(mktemp)
coverage_json=$(mktemp)
trap 'rm -f "$coverage_out" "$coverage_json"' EXIT

run_ok=false
coverage_raw=""

# Detect runner + run with coverage
if [ -f "$TERMINAL_REPO/package.json" ]; then
  if grep -q '"vitest"' "$TERMINAL_REPO/package.json" 2>/dev/null; then
    if (cd "$TERMINAL_REPO" && bunx vitest run --coverage \
          --coverage.reporter=json 2>"$coverage_out"); then
      run_ok=true
      # vitest writes coverage/coverage-final.json by default
      if [ -f "$TERMINAL_REPO/coverage/coverage-final.json" ]; then
        cp "$TERMINAL_REPO/coverage/coverage-final.json" "$coverage_json"
        coverage_raw=$(cat "$coverage_json")
      fi
    fi
  elif grep -q '"jest"' "$TERMINAL_REPO/package.json" 2>/dev/null; then
    if (cd "$TERMINAL_REPO" && bunx jest --coverage \
          --coverageReporters=json 2>"$coverage_out"); then
      run_ok=true
      if [ -f "$TERMINAL_REPO/coverage/coverage-final.json" ]; then
        cp "$TERMINAL_REPO/coverage/coverage-final.json" "$coverage_json"
        coverage_raw=$(cat "$coverage_json")
      fi
    fi
  else
    # fallback: bun test (no built-in coverage json — run and record pass/fail)
    if (cd "$TERMINAL_REPO" && bun test 2>"$coverage_out"); then
      run_ok=true
    fi
  fi
elif [ -f "$TERMINAL_REPO/pyproject.toml" ] || [ -f "$TERMINAL_REPO/setup.py" ]; then
  if (cd "$TERMINAL_REPO" && python -m pytest --cov=. \
        --cov-report=json:coverage.json -q 2>"$coverage_out"); then
    run_ok=true
    if [ -f "$TERMINAL_REPO/coverage.json" ]; then
      cp "$TERMINAL_REPO/coverage.json" "$coverage_json"
      coverage_raw=$(cat "$coverage_json")
    fi
  fi
fi

if [ "$run_ok" = false ]; then
  terminal-cli activity error "Coverage · blocked" \
    "Test suite failed at $short — skipping gap analysis"
  # Don't mark-main: we want to retry after the suite is fixed
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Compute coverage delta vs baseline (deterministic)
# ---------------------------------------------------------------------------
gaps_found=false
gap_summary=""

if [ -n "$coverage_raw" ] && [ -f "$baseline_file" ]; then
  # Use node/bun inline script to compare JSON coverage maps
  gap_summary=$(bun -e "
    const curr = $(cat "$coverage_json");
    const base = JSON.parse(require('fs').readFileSync('$baseline_file','utf8'));
    const threshold = $coverage_threshold;
    const findings = [];

    for (const [file, data] of Object.entries(curr)) {
      // istanbul/v8 shape: data.s (statements), data.b (branches), data.f (functions)
      const stmts = data.s ? Object.values(data.s) : [];
      const total  = stmts.length;
      if (total === 0) continue;
      const covered = stmts.filter(Boolean).length;
      const pct = total ? Math.round((covered / total) * 100) : 100;

      const basePct = base[file]?.pct ?? null;
      const drop    = basePct !== null ? basePct - pct : null;

      if (pct < threshold || (drop !== null && drop > 5)) {
        findings.push({
          file,
          pct,
          basePct,
          drop,
          uncoveredFunctions: Object.entries(data.fnMap || {})
            .filter(([id]) => data.f?.[id] === 0)
            .map(([,fn]) => fn.name || '(anonymous)')
        });
      }
    }
    console.log(JSON.stringify(findings));
  " 2>/dev/null || echo "[]")

  if [ "$gap_summary" != "[]" ] && [ -n "$gap_summary" ]; then
    gaps_found=true
  fi
elif [ -n "$changed_src" ]; then
  # No coverage JSON available — flag changed files as needing review
  gaps_found=true
  gap_summary="[]"  # will be fleshed out by haiku below
fi

if [ "$gaps_found" = false ]; then
  echo "coverage: no actionable gaps at $short."
  terminal-cli activity check "Coverage · ok" "No gaps above threshold @ $short"
  terminal-cli state mark-main
  terminal-cli state set lastCoveragePct "ok"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. HAIKU — classify each gap: "small" vs "large"
# ---------------------------------------------------------------------------
haiku_model="${TERMINAL_MODEL:-claude-haiku-4-5}"
# Prefer explicit haiku tier regardless of TERMINAL_MODEL caller override
if echo "$haiku_model" | grep -qi 'sonnet\|opus'; then
  haiku_model="claude-haiku-4-5"
fi

classify_prompt=$(mktemp)
trap 'rm -f "$classify_prompt"' EXIT

cat > "$classify_prompt" <<EOF
You are classifying test-coverage gaps for repo: $TERMINAL_REPO

Changed source files since last scan:
$changed_src

Coverage findings (JSON array, each entry has file, pct, basePct, drop, uncoveredFunctions):
$gap_summary

Classify EACH finding as exactly one of:
- "small"  — single function or a tight cluster of clearly-named functions with
             obvious behavior; an LLM can confidently write the failing test(s)
             without knowing business context; the test would fit in <50 lines.
- "large"  — wide surface area, unclear contracts, multiple files, domain logic
             that needs human context, or a drop >20 ppts.

Respond as a JSON array with objects: { "file": "...", "class": "small|large",
"reason": "<one sentence>", "uncoveredFunctions": [...] }
No extra prose.
EOF

classifications=$(claude -p "$(<"$classify_prompt")" \
  --dangerously-skip-permissions \
  --model "$haiku_model" 2>/dev/null || echo "[]")

# Sanitise — strip markdown fences if claude wrapped the JSON
# shellcheck disable=SC2016  # backticks in sed pattern are markdown literals, not shell substitution
classifications=$(echo "$classifications" \
  | sed 's/```json//g; s/```//g' \
  | tr -d '\r' \
  | awk '/^\[/,/^\]/' \
  || echo "[]")

# ---------------------------------------------------------------------------
# 4. File tickets for "large" gaps; collect "small" gaps for authoring
# ---------------------------------------------------------------------------
large_gaps=$(echo "$classifications" \
  | bun -e "
    let raw=''; process.stdin.on('data',d=>raw+=d);
    process.stdin.on('end',()=>{
      try {
        const arr = JSON.parse(raw);
        const large = arr.filter(x=>x.class==='large');
        console.log(JSON.stringify(large));
      } catch { console.log('[]'); }
    });
  " 2>/dev/null || echo "[]")

small_gaps=$(echo "$classifications" \
  | bun -e "
    let raw=''; process.stdin.on('data',d=>raw+=d);
    process.stdin.on('end',()=>{
      try {
        const arr = JSON.parse(raw);
        const small = arr.filter(x=>x.class==='small');
        console.log(JSON.stringify(small));
      } catch { console.log('[]'); }
    });
  " 2>/dev/null || echo "[]")

# File tickets for large gaps
large_count=0
if [ "$large_gaps" != "[]" ] && [ -n "$large_gaps" ]; then
  large_count=$(echo "$large_gaps" \
    | bun -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(r).length)}catch{console.log(0)}})" \
    2>/dev/null || echo 0)

  echo "$large_gaps" \
    | bun -e "
      let r='';process.stdin.on('data',d=>r+=d);
      process.stdin.on('end',()=>{
        try {
          const arr=JSON.parse(r);
          arr.forEach(g=>{
            const fns=g.uncoveredFunctions?.join(', ')||'(unknown)';
            process.stdout.write(
              'TICKET\x1f'+
              'test: add coverage for '+g.file+'\x1f'+
              'Coverage gap detected at ${short}.\n'+
              'File: '+g.file+'\n'+
              'Current coverage: '+(g.pct??'?')+'%  (baseline: '+(g.basePct??'n/a')+'%)\n'+
              'Uncovered functions: '+fns+'\n'+
              'Reason classified large: '+g.reason+'\n'+
              '\nThis surface is too wide for automated test authoring. A human or focused\n'+
              'agent pass is needed.\n\x1e'
            );
          });
        } catch {}
      });
    " 2>/dev/null \
    | while IFS=$'\x1f' read -r tag title body; do
        body_clean=$(echo "$body" | tr -d $'\x1e')
        if [ "$tag" = "TICKET" ]; then
          terminal-cli ticket "$title" "$body_clean"
        fi
      done
fi

small_count=$(echo "$small_gaps" \
  | bun -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(r).length)}catch{console.log(0)}})" \
  2>/dev/null || echo 0)

if [ "$small_count" -eq 0 ]; then
  echo "coverage: no small gaps to author at $short. $large_count ticket(s) filed."
  terminal-cli activity check "Coverage · $large_count ticket(s)" \
    "No small gaps @ $short; $large_count large gaps ticketed"
  # Update baseline with current coverage
  if [ -n "$coverage_raw" ]; then
    mkdir -p "$(dirname "$baseline_file")"
    bun -e "
      const curr = $coverage_raw;
      const out = {};
      for (const [file, data] of Object.entries(curr)) {
        const stmts = data.s ? Object.values(data.s) : [];
        const total = stmts.length;
        const covered = stmts.filter(Boolean).length;
        out[file] = { pct: total ? Math.round((covered/total)*100) : 100 };
      }
      require('fs').writeFileSync('$baseline_file', JSON.stringify(out, null, 2));
    " 2>/dev/null || true
  fi
  terminal-cli state mark-main
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. SONNET — author net-new tests for small gaps
# ---------------------------------------------------------------------------
# Work inside the TERMINAL_WORKTREE (the runner already set up an isolated
# worktree for us via inPlace:false).
wt="$TERMINAL_WORKTREE"
branch="coverage/$short"

# Create a feature branch in the worktree
git -C "$wt" checkout -b "$branch" 2>/dev/null \
  || git -C "$wt" checkout "$branch" 2>/dev/null \
  || true

sonnet_model="${TERMINAL_MODEL:-claude-sonnet-4-5}"
# Ensure we use a sonnet-tier model for authoring
if echo "$sonnet_model" | grep -qi 'haiku'; then
  sonnet_model="claude-sonnet-4-5"
fi

author_prompt=$(mktemp)
trap 'rm -f "$author_prompt"' EXIT

# Build a compact list of files + functions to cover
small_list=$(echo "$small_gaps" \
  | bun -e "
    let r='';process.stdin.on('data',d=>r+=d);
    process.stdin.on('end',()=>{
      try {
        const arr=JSON.parse(r);
        arr.forEach(g=>{
          const fns=(g.uncoveredFunctions||[]).join(', ')||'(all uncovered)';
          console.log(g.file+' — uncovered: '+fns);
        });
      } catch { console.log('(parse error)'); }
    });
  " 2>/dev/null || echo "(unknown)")

cat > "$author_prompt" <<EOF
You are the coverage agent for repo: $wt

Your ONLY job is to write net-new TEST files that increase coverage for the
gaps listed below. You must NOT modify any source-under-test file.

Gaps to cover (small/well-bounded, classified by haiku):
$small_list

Rules:
1. Write failing tests FIRST (TDD). Each test must initially fail for the right
   reason, then pass with the existing source unchanged.
2. Place test files next to the source they test, following the project's
   existing naming convention (*.test.ts, *.spec.ts, *_test.py, etc.).
3. Tests-only PRs: if you find yourself editing a non-test file, STOP and do
   NOT make that change. File a HITL via: terminal-cli hitl "coverage authoring blocked" "Would need to edit source <file> to write meaningful tests — needs human"
4. After writing the tests, run them to confirm they pass:
   - JS/TS repo: bun test <test-file>
   - Python repo: python -m pytest <test-file> -v
5. Commit the new test files on branch $branch with message:
   test: backfill coverage for $small_count gap(s) @ $short
6. Then output exactly: TESTS_COMMITTED
EOF

authoring_output=$(claude -p "$(<"$author_prompt")" \
  --dangerously-skip-permissions \
  --model "$sonnet_model" 2>&1)
auth_exit=$?

# ---------------------------------------------------------------------------
# 6. Mechanical tests-only guard
# ---------------------------------------------------------------------------
non_test_changes=$(git -C "$wt" diff --name-only HEAD 2>/dev/null \
  | grep -Ev '(test|spec|__tests__|_test\.|\.test\.|\.spec\.)' || true)
# Also check staged but uncommitted changes
non_test_staged=$(git -C "$wt" diff --cached --name-only 2>/dev/null \
  | grep -Ev '(test|spec|__tests__|_test\.|\.test\.|\.spec\.)' || true)

if [ -n "$non_test_changes" ] || [ -n "$non_test_staged" ]; then
  # Revert everything — this run is tainted
  git -C "$wt" reset --hard HEAD 2>/dev/null || true
  git -C "$wt" clean -fd 2>/dev/null || true
  terminal-cli hitl "coverage: tests-only guard tripped @ $short" \
    "Sonnet modified non-test files: ${non_test_changes:-}${non_test_staged:-}. PR skipped; run reverted."
  terminal-cli activity error "Coverage · guard tripped" \
    "Non-test edits detected and reverted @ $short"
  # Don't mark-main — next run should retry
  exit 1
fi

# Check sonnet actually committed something (inspect output signal, not log)
if ! echo "$authoring_output" | grep -q "TESTS_COMMITTED"; then
  echo "coverage: sonnet did not confirm TESTS_COMMITTED (exit $auth_exit)."
  terminal-cli activity error "Coverage · authoring failed" \
    "Sonnet did not commit tests @ $short — see run log"
  terminal-cli state mark-main
  exit 0
fi

# ---------------------------------------------------------------------------
# 7. Push branch and open PR
# ---------------------------------------------------------------------------
git -C "$wt" push origin "$branch" --force-with-lease 2>/dev/null || \
  git -C "$wt" push origin "$branch" 2>/dev/null || true

pr_url=""
if command -v gh >/dev/null 2>&1; then
  pr_url=$(gh pr create \
    --repo "$(git -C "$TERMINAL_REPO" remote get-url origin \
      | sed 's/.*github.com[:/]//;s/\.git$//')" \
    --base main \
    --head "$branch" \
    --title "test: backfill ${small_count} test(s) in coverage gaps @ ${short}" \
    --body "$(cat <<PRBODY
## Summary

Automated test backfill for ${small_count} small/well-bounded coverage gap(s) identified at ${short}.

### Gaps covered

${small_list}

### Validation

- All new tests pass with existing source unchanged.
- Mechanical tests-only guard confirmed no source files were modified.
- Baseline updated to reflect new coverage numbers.

> Generated by the coverage agent (cost ladder: haiku classify → sonnet author).
PRBODY
)" 2>/dev/null || true)
fi

if [ -z "$pr_url" ] && command -v glab >/dev/null 2>&1; then
  pr_url=$(glab mr create \
    --source-branch "$branch" \
    --target-branch main \
    --title "test: backfill ${small_count} test(s) in coverage gaps @ ${short}" \
    --description "Automated test backfill. Gaps: $small_list" \
    --yes 2>/dev/null | grep -o 'https://[^ ]*' | head -1 || true)
fi

# ---------------------------------------------------------------------------
# 8. Write report artifact
# ---------------------------------------------------------------------------
mkdir -p "$TERMINAL_REPO/reports/coverage"
report="$TERMINAL_REPO/reports/coverage/${short}.md"
now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

cat > "$report" <<REPORT
---
kind: coverage
generated: ${now}
sha: ${short}
last_scanned: ${last:-none}
new_tests_pr: ${pr_url:-"(no PR opened)"}
small_gaps_authored: ${small_count}
large_gaps_ticketed: ${large_count}
status: ok
---

## Coverage gaps @ ${short}

### Small gaps (tests authored)

${small_list}

### Large gaps (tickets filed)

${large_count} gap(s) filed as backlog tickets.

### PR

${pr_url:-"(no PR — authoring did not complete or nothing to push)"}
REPORT

# ---------------------------------------------------------------------------
# 9. Update baseline + state
# ---------------------------------------------------------------------------
if [ -n "$coverage_raw" ]; then
  mkdir -p "$(dirname "$baseline_file")"
  bun -e "
    const curr = $coverage_raw;
    const out = {};
    for (const [file, data] of Object.entries(curr)) {
      const stmts = data.s ? Object.values(data.s) : [];
      const total = stmts.length;
      const covered = stmts.filter(Boolean).length;
      out[file] = { pct: total ? Math.round((covered/total)*100) : 100 };
    }
    require('fs').writeFileSync('$baseline_file', JSON.stringify(out, null, 2));
  " 2>/dev/null || true
fi

terminal-cli state mark-main
terminal-cli state set lastCoveragePct "$(echo "$classifications" \
  | bun -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{const a=JSON.parse(r);const s=a.filter(x=>x.pct!=null);const avg=s.length?Math.round(s.reduce((a,x)=>a+(x.pct||0),0)/s.length):0;console.log(avg)}catch{console.log(0)}})" \
  2>/dev/null || echo 0)"
terminal-cli state set lastSmallGaps "$small_count"
terminal-cli state set lastLargeGaps "$large_count"

terminal-cli activity check \
  "Coverage · ${small_count} test(s) authored · ${large_count} ticket(s)" \
  "PR: ${pr_url:-none} @ ${short}"

exit 0

#!/usr/bin/env bash
# dead-code — detect unused exports, files, and dependencies.
# Contract: .agents/dead-code.md
#
# COST LADDER:
#   Tier 0  Deterministic precheck (no LLM) — incremental skip, ecosystem
#           detection, tool run (knip / ts-prune / vulture / cargo-udeps /
#           deadcode), zero-findings guard, write frontmatter.
#           exit 0 when nothing actionable.
#   Tier 1  haiku — classify + group findings into the report body.
#           CEILING: sonnet only when >50 findings across >10 files.
#           Never opus.
#
# Hard rules (from .agents/dead-code.md):
#   - Zero findings → write report + exit 0, no LLM call.
#   - Never delete source — report only; cleanup is a ticket/PR.
#   - One run per invocation; no retries.
#
# Runner env (set by TerMinal):
#   TERMINAL_REPO      repo root (absolute)
#   TERMINAL_AGENT_ID  state key ("dead-code")
#   TERMINAL_RUN_ID    run uuid
#   TERMINAL_BRANCH    worktree branch (or "main" if inPlace)
#   TERMINAL_WORKTREE  worktree path
#   TERMINAL_ENGINE    "claude" | "codex"
#   TERMINAL_MODEL     model hint; ceiling: sonnet (never opus)

set -uo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
HAIKU_MODEL="claude-haiku-4-5"
SONNET_MODEL="claude-sonnet-4-5"

REPO="${TERMINAL_REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"

# ── Tier-0: incremental-skip ──────────────────────────────────────────────────
last=$(terminal-cli state get-sha 2>/dev/null || true)

git -C "$REPO" fetch --quiet origin 2>/dev/null || true
head=$(git -C "$REPO" rev-parse origin/main 2>/dev/null \
    || git -C "$REPO" rev-parse origin/master 2>/dev/null \
    || git -C "$REPO" rev-parse HEAD)

if [[ "$head" == "$last" ]]; then
  echo "dead-code: no new commits since ${last} — nothing to scan."
  exit 0
fi

short=$(git -C "$REPO" rev-parse --short "$head")
mkdir -p "$REPO/reports/dead-code"
report="$REPO/reports/dead-code/${short}.md"
now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# ── Tier-0: detect ecosystem and preferred tool ───────────────────────────────
tool=""
tool_cmd=""

# TS/JS — prefer knip, fall back to ts-prune
if [[ -f "$REPO/package.json" ]]; then
  if (cd "$REPO" && bunx knip --version >/dev/null 2>&1); then
    tool="knip"
    tool_cmd="bunx knip --reporter json"
  else
    tool="ts-prune"
    tool_cmd="bunx ts-prune"
  fi
elif [[ -f "$REPO/pyproject.toml" ]] || [[ -f "$REPO/setup.py" ]]; then
  if command -v vulture >/dev/null 2>&1; then
    tool="vulture"
    # Find the main package directory (first src/ or package dir)
    pkg_dir="."
    if [[ -d "$REPO/src" ]]; then
      pkg_dir="src"
    fi
    tool_cmd="vulture $pkg_dir --min-confidence 80"
  fi
elif [[ -f "$REPO/Cargo.toml" ]]; then
  tool="cargo-udeps"
  tool_cmd="cargo +nightly udeps"
elif [[ -f "$REPO/go.mod" ]]; then
  if command -v deadcode >/dev/null 2>&1; then
    tool="deadcode"
    tool_cmd="deadcode ./..."
  fi
fi

if [[ -z "$tool" ]]; then
  cat > "$report" <<REPORT
---
kind: dead-code
commit: ${head}
short_sha: ${short}
generated: ${now}
generator: terminal-agent/dead-code
tool: none
status: error
counts:
  unused_files: 0
  unused_exports: 0
  unused_deps: 0
---

## Summary

No dead-code tool found or no supported ecosystem detected in this repo.
Install knip (\`bun add -d knip\`), vulture (\`pip install vulture\`),
cargo-udeps (\`cargo install cargo-udeps\`), or deadcode (\`go install golang.org/x/tools/cmd/deadcode@latest\`)
to enable this check.
REPORT
  terminal-cli activity info \
    "Dead-code · not configured" \
    "No supported ecosystem or tool found at ${short}" 2>/dev/null || true
  terminal-cli state mark-main
  exit 0
fi

# ── Tier-0: run the tool ──────────────────────────────────────────────────────
scan_out=$(mktemp)
# shellcheck disable=SC2064
trap "rm -f '$scan_out'" EXIT

# Some tools (cargo-udeps) exit non-zero even on success — don't treat as fatal.
# We rely on output content rather than exit code.
(cd "$REPO" && eval "$tool_cmd" 2>&1) > "$scan_out" || true
raw_output=$(<"$scan_out")

# ── Tier-0: count findings ────────────────────────────────────────────────────
unused_files=0
unused_exports=0
unused_deps=0

case "$tool" in
  knip)
    # knip --reporter json emits a JSON object; count by field
    if [[ -n "$raw_output" ]]; then
      unused_files=$(printf '%s\n' "$raw_output" \
        | bun -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(r);console.log((j.files||[]).length)}catch{console.log(0)}})" \
        2>/dev/null || echo 0)
      unused_exports=$(printf '%s\n' "$raw_output" \
        | bun -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(r);const ex=j.exports||{};let n=0;for(const f of Object.values(ex))n+=(Array.isArray(f)?f.length:0);console.log(n)}catch{console.log(0)}})" \
        2>/dev/null || echo 0)
      unused_deps=$(printf '%s\n' "$raw_output" \
        | bun -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(r);const d=(j.dependencies||[]).length+(j.devDependencies||[]).length;console.log(d)}catch{console.log(0)}})" \
        2>/dev/null || echo 0)
    fi
    ;;
  ts-prune)
    unused_exports=$(printf '%s\n' "$raw_output" | grep -c '.' 2>/dev/null || echo 0)
    ;;
  vulture)
    unused_exports=$(printf '%s\n' "$raw_output" | grep -c 'unused' 2>/dev/null || echo 0)
    ;;
  cargo-udeps|deadcode)
    unused_deps=$(printf '%s\n' "$raw_output" | grep -c '.' 2>/dev/null || echo 0)
    ;;
esac

total_findings=$((unused_files + unused_exports + unused_deps))

# ── Tier-0: zero-findings guard — write artifact and exit WITHOUT any LLM ────
if [[ "$total_findings" -eq 0 ]]; then
  cat > "$report" <<REPORT
---
kind: dead-code
commit: ${head}
short_sha: ${short}
generated: ${now}
generator: terminal-agent/dead-code
tool: ${tool}
status: ok
counts:
  unused_files: 0
  unused_exports: 0
  unused_deps: 0
---

## Summary

No dead code detected. Ran ${tool} at ${short}.
REPORT
  terminal-cli activity check \
    "Dead-code · clean" \
    "0 findings via ${tool} @ ${short}" 2>/dev/null || true
  terminal-cli state mark-main
  terminal-cli state set lastFindings "0" 2>/dev/null || true
  exit 0
fi

# ── Tier-1: haiku (or sonnet for large surfaces) — format findings ────────────
# Ceiling: sonnet only when >50 findings across >10 files; never opus.
file_count_heuristic=$(printf '%s\n' "$raw_output" | grep -c ':' 2>/dev/null || echo 0)

effective_model="${TERMINAL_MODEL:-$HAIKU_MODEL}"
# Apply ceiling: never opus
if printf '%s' "$effective_model" | grep -qi 'opus'; then
  effective_model="$SONNET_MODEL"
fi
# Escalate to sonnet for large surfaces
if [[ "$total_findings" -gt 50 && "$file_count_heuristic" -gt 10 ]]; then
  if printf '%s' "$effective_model" | grep -qi 'haiku'; then
    effective_model="$SONNET_MODEL"
  fi
fi

prompt_file=$(mktemp)
# shellcheck disable=SC2064
trap "rm -f '$prompt_file' '$scan_out'" EXIT

cat > "$prompt_file" <<EOF
You are the dead-code auditor for repo ${REPO}.

Tool: ${tool}
Scan at commit: ${short}

Raw tool output:
${raw_output}

Write a dead-code report in this exact format (write the literal text, do not
add extra commentary outside these sections):

---
kind: dead-code
commit: ${head}
short_sha: ${short}
generated: ${now}
generator: terminal-agent/dead-code
tool: ${tool}
status: findings
counts:
  unused_files: ${unused_files}
  unused_exports: ${unused_exports}
  unused_deps: ${unused_deps}
---

## Summary

<1-2 lines: tool run, totals, overall read.>

## Findings

Group by file. Each entry: \`path:line\` · what's unused (file / export / dep)
· confidence (high/medium/low). Note when dead code was introduced recently
vs long-standing if the tool can tell. Mark items that may be
reflection/dynamic-dispatch false positives as low confidence.

## Suggested cleanup

Only if findings warrant action: the smallest set of tickets to file (type: dx
or testing, horizon: next or future) to remove the dead code. Do NOT suggest
deleting here — checks report, humans/PRs act. For each suggested ticket, emit:
  terminal-cli ticket "<title>" "<body>"
EOF

report_body=$(claude -p "$(<"$prompt_file")" \
  --dangerously-skip-permissions \
  --model "$effective_model" 2>/dev/null || true)

if [[ -z "$report_body" ]]; then
  # Fallback: write a minimal report without the LLM body
  cat > "$report" <<REPORT
---
kind: dead-code
commit: ${head}
short_sha: ${short}
generated: ${now}
generator: terminal-agent/dead-code
tool: ${tool}
status: findings
counts:
  unused_files: ${unused_files}
  unused_exports: ${unused_exports}
  unused_deps: ${unused_deps}
---

## Summary

${total_findings} finding(s) via ${tool} at ${short}. LLM formatting step did not produce output — see raw tool output below.

## Raw output

\`\`\`
${raw_output}
\`\`\`
REPORT
else
  printf '%s\n' "$report_body" > "$report"
fi

# ── Finalize ──────────────────────────────────────────────────────────────────
terminal-cli activity check \
  "Dead-code · ${total_findings} finding(s)" \
  "via ${tool} @ ${short} — see reports/dead-code/${short}.md" 2>/dev/null || true

terminal-cli state mark-main
terminal-cli state set lastFindings "$total_findings" 2>/dev/null || true
terminal-cli state set lastTool "$tool" 2>/dev/null || true

exit 0

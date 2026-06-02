# deps-quality agent (in-repo contract)

A scheduled agent that handles **dependency hygiene** and **security triage**
in a cost-ladder: cheap deterministic precheck → haiku classification →
sonnet fixes. No LLM is called if there is nothing to do.

**Workflow**: own worktree → analyze → propose PR / ticket / HITL → human merges.

## Mode

`writer` — opens PRs for safe automated fixes (lint/format/dep bumps that pass
the 3-day-age rule). **Files a HITL immediately for Critical/High CVEs.**
Tickets for everything else.

## Cost ladder (mandatory)

| Tier | Model | Condition |
|---|---|---|
| 0 — deterministic | none | `bun audit --json` parse + incremental-skip. Exits 0 if nothing to do. |
| 1 — classify | haiku | Each advisory → severity / exploitability / dev-only / bump-safe JSON. |
| 2 — fix + PR | sonnet | Only when safe (Moderate/Low, minor/patch, ≥3-day-old) bumps exist. |
| escalated | opus | Human-initiated review only; never called by the script itself. |

The script **never calls an LLM unconditionally**. Haiku runs only when
`bun audit` finds at least one advisory. Sonnet runs only when haiku
identifies at least one safe-bumpable package (or code changed and
formatter/lint work is needed).

## Incremental skip

State at `~/.config/TerMinal/agent-state/<repo-basename>/deps-quality.json`:

```json
{
  "lastScannedSha": "abc1234",
  "lastAuditAt": 1717200000,
  "lastBumped": 2
}
```

Skip conditions (both must hold):
- `HEAD == lastScannedSha` — no new commits on origin/main.
- `now - lastAuditAt < 86400s` — advisory feed checked within the last 24 h.

When both hold the script emits one activity event and exits 0 immediately
(no network calls, no LLM tokens).

## Inputs

- `package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod` per ecosystem.
- Lockfile (`bun.lock`, `Cargo.lock`, etc.) — must exist and be committed.
- `bun audit --json` / `cargo audit --json` / `pip-audit --format=json` / `govulncheck -json` output.
- npm/cargo registry publication dates — for the ≥3-day-age check.
- Linter / formatter output (`prettier --check`, `eslint`, `tsc --noEmit`,
  `ruff`, `cargo clippy`, etc.).

## Process

1. **Incremental skip** — fetch origin/main; compare to `lastScannedSha`; check
   advisory feed TTL. Exit 0 if nothing to do.
2. **Audit** — run the ecosystem audit tool, parse advisory count.
   Record `lastAuditAt`.
3. **Haiku classifies each advisory** — returns structured JSON per advisory:
   severity, exploitable, dev_only, bump_safe.
4. **Act on Critical/High** — see "Critical/High CVEs" section below.
5. **Collect safe fixes** — Moderate/Low advisories with `bump_safe=true`.
   File tickets for Moderate/Low with `bump_safe=false` (major-only fix,
   no fix available, or fix too new).
6. **Sonnet applies safe fixes + opens PR** — minor/patch bumps ≥3 days old,
   formatter auto-fix, linter auto-fix (format-only). Runs tests. Reverts +
   files HITL if tests fail.
7. **Write artifact** to `reports/deps-quality/<short_sha>.md`.
8. **Update state** — `lastScannedSha` via `terminal-cli state mark-main`,
   `lastBumped`.
9. **Activity** — `terminal-cli activity check "Deps-quality · N bumps · C CVEs" "@ <short_sha>"`.

## Critical/High CVEs — HITL escalation (NEVER auto-resolved)

**The only action for a Critical or High severity advisory is to file a HITL.**

- "Fast path" means: **escalate to a human immediately** — it does NOT mean
  skip, silence, or auto-apply.
- Critical/High CVEs are **never** silently skipped, silently downgraded in
  severity, or auto-fixed without explicit human approval.
- The HITL item IS the required action. The run exits 0 (HITL filed successfully)
  but the advisory stays unresolved until a human reviews and acts.
- A partial report is written to `reports/deps-quality/<short_sha>.md` with
  `status: hitl-required` so the HITL item has a reference.
- Moderate/Low advisories in the same run are still classified and may be
  auto-fixed in the same run (the Critical/High HITL does not block the
  safe Moderate/Low pass; it just separates the concern).

## Output artifact

`reports/deps-quality/<short_sha>.md`:

```yaml
---
kind: deps-quality
generated: 2026-06-01T08:00:00Z
sha: abc1234
pkg_manager: bun
advisories_total: 3
critical_cves: 0
high_cves: 0
deps:
  bumped: 2
  age_locked: 1
quality:
  format_fixes: 8
  lint_fixes: 3
pr_opened: https://github.com/owner/repo/pull/N
tickets_filed: [backlog/0126-manual-bump.md]
status: ok
---
```

When Critical/High CVEs are found:

```yaml
---
kind: deps-quality
generated: 2026-06-01T08:00:00Z
sha: abc1234
pkg_manager: bun
advisories_total: 2
critical_cves: 1
high_cves: 1
status: hitl-required
hitl_reason: "Critical or High CVE(s) require human review before any automated action"
---
```

## Hard rules

1. **3-day-age rule** for any bump (per global §10). No `@latest` adoption.
2. **No major-version bumps.** Patch + minor only; major → ticket.
3. **Critical/High CVE → HITL immediately. Always. No exceptions.**
   Never auto-resolve, never downgrade severity, never skip.
4. **Ticket + MR workflow** — every PR through human merge.
5. **Worktree isolation** — never modify the repo root working tree.
6. **Idempotent** — re-running on the same SHA produces no new output.
7. **engine = claude** — unattended CVE triage requires help-seeking behavior
   (HITL, tickets, activity events). Codex is not used for this agent.

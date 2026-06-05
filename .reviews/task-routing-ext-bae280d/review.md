# Codex review — role-routing extension series (a393ab2..)

**Verdict: REQUEST-CHANGES** (1 finding, P1)

1. **P1 — Auto picker validates the wrong engine for PR reviews and agent
   overrides.** EnginePicker hard-coded Auto availability/copy to
   roles.code.engine, but backend routing uses the review role for PR-review
   Auto and per-agent overrides beat the policy. Scenarios: code-role engine
   missing disables PR-review Auto needlessly; review-role engine missing
   enables an Auto that spawn-fails; agent override ignored by the gate.
   Fix: context-aware autoRole + autoEngineOverride props, availability and
   copy computed from the engine the context actually launches.

Reviewer verified: routing+pipelines suites (42 tests), typecheck, diff check.

---
reviewer: codex (codex exec, read-only, separate process — reviewer ≠ implementer)
scope: git diff a393ab2..HEAD (3-commit extension: pipeline review routing + Auto pick)
addressed-by: bae280dc5680ad7e8ee6c862430a76beb41bb8cd — context-aware Auto card; suite 383 green post-fix
date: 2026-06-05

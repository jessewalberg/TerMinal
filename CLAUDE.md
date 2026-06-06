@AGENTS.md

## Claude Code specifics

- Direct-to-main is enforced (or rather, deliberately not blocked) via Claude
  Code hooks: the `block-main-merge.sh` hook is intentionally NOT wired in
  `.claude/settings.json`. The hook file is kept under `.claude/hooks/` in case
  the policy ever flips. (Branching policy itself: see AGENTS.md.)

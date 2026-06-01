---
id: 5
title: "Self-healing CI: webhook receiver shim + .agents/ci-watchdog.sh"
status: closed
priority: medium
horizon: next
hitl: false
type: feature
source: research
created: 2026-05-30
updated: 2026-05-31
prs:
  - https://github.com/jessewalberg/TerMinal/pull/3
refs: []
depends_on: []
---

Refactored from earlier scope: the app surface is **tiny** — a single
webhook endpoint in the dashboard's existing Hono server. Everything
downstream (log fetch, classification, autofix, HITL routing) is a
`.agents/ci-watchdog.sh` script that uses existing harness helpers.

**Filter applied:** the trigger is harness-shaped (the dashboard is
already running on `:4848` and only it can receive a webhook). The
intelligence is foundation-model territory; runs as codex exec
spawned by the script.

## App surface — minimal

One new route in the dashboard server (`dashboard/src/server.ts`):

```ts
app.post('/api/ci-webhook/:repo', verifySignature, async (c) => {
  const repo = c.req.param('repo')
  const payload = await c.req.json()
  if (payload.object_kind === 'pipeline' && payload.status === 'failed') {
    spawn('.agents/ci-watchdog.sh', [], {
      env: {
        ...process.env,
        TERMINAL_REPO: repoRootFor(repo),
        TERMINAL_AGENT_ID: 'ci-watchdog',
        CI_PIPELINE_ID: String(payload.object_attributes.id),
        CI_MR_IID: String(payload.merge_request?.iid || ''),
      },
      detached: true,
    }).unref()
  }
  return c.json({ ok: true })
})
```

Plus signature verification (HMAC against a per-repo secret in
`prs/config.yml`). Plus one config field naming the secret. That's the
whole app change — maybe 40 lines.

## Agent script — everything else

`.agents/ci-watchdog.sh` does:

```bash
#!/usr/bin/env bash
set -uo pipefail

# 1. Fetch the failed pipeline log
log=$(glab ci view --log "$CI_PIPELINE_ID" 2>&1 | tail -500)

# 2. Classify (cheap-model one-shot)
class=$(claude -p "Classify this CI failure into ONE label: \
prettier-formatting, eslint-fixable, typecheck-isolated, \
snapshot-mismatch, test-real, build-config, deploy-infra, ambiguous.\n\nLog:\n$log" \
  --dangerously-skip-permissions --model haiku | tr -d '\n')

# 3. Branch by class
case "$class" in
  prettier-formatting)
    # Worktree, prettier --write, commit, push, comment on MR
    wt=$(mktemp -d)
    git -C "$TERMINAL_REPO" worktree add "$wt" "$CI_BRANCH"
    cd "$wt" && bunx prettier --write . && git commit -am 'chore: prettier'
    git push origin "$CI_BRANCH"
    glab mr note "$CI_MR_IID" -m "🤖 Auto-fixed prettier"
    terminal-cli activity check "CI auto-fix · prettier" "MR !$CI_MR_IID"
    ;;
  test-real|ambiguous|*)
    # HITL — let the human investigate
    terminal-cli hitl "CI red on MR !$CI_MR_IID · $class" \
      "Pipeline $CI_PIPELINE_ID failed. Class: $class. \
Last lines: $(echo "$log" | tail -20)"
    ;;
esac

terminal-cli state set "lastClass-$CI_MR_IID" "$class"
```

Per-MR fix cap (3 auto-fixes max) enforced via
`terminal-cli state get/set` counter.

## Allowlist evolution

Same as before — `prettier-formatting` only at v0, broaden one class
at a time after a week of clean operation. This is all in the script;
no app code involved in tuning.

## Dry-run mode

The script reads `~/.config/TerMinal/ci-watchdog.json` for
`{ dryRun: true }`. When true: classifies, logs the would-be-action
to `~/.config/TerMinal/ci-watchdog-dryrun.jsonl`, but does NOT push
or file HITL. Operator reviews the log for a week before flipping.

## Telegram

- `/ci` — last 10 CI fixes/HITLs (reads activity feed for `kind: check
  · title: CI auto-fix`)
- HITL pings inherit the existing inline buttons

Both come for free from the existing TG bridge — no new code.

## Stage plan

**Stage 1** — Webhook endpoint + signature verify in `dashboard/src/
server.ts`. Test with `curl`.

**Stage 2** — `.agents/ci-watchdog.sh` in dry-run, classify-only.
Activity events for the dry-run record.

**Stage 3** — Flip dry-run off for `prettier-formatting` only.

**Stage 4+** — Broaden the allowlist as confidence grows.

## App scope summary

- 1 new HTTP route (~40 lines)
- 1 config field per repo (`ci_webhook_secret`)
- Nothing else

The 95% of the work is the agent script.

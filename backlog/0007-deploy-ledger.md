---
id: 7
title: "Deploy ledger: terminal-cli helper + activity events + small dashboard view"
status: open
priority: low
horizon: future
hitl: false
type: feature
source: research
created: 2026-05-30
updated: 2026-05-30
prs: []
refs: []
depends_on: []
---

Refactored: the ledger is a flat JSONL file written by a
`terminal-cli deploy` subcommand. Logged either manually from a
deploy script or by a `/deploy` skill (project-template). The
"dashboard view" is a small table that reads activity events — no
new schema, no separate store.

**Filter applied:** the JSONL itself is just data. The harness adds
value via cross-session persistence + cross-repo aggregation. Both
fall out of using `activity.jsonl` as the underlying store with a
`kind: deploy` tag.

## Storage

Reuse the existing `~/.config/TerMinal/activity.jsonl` with a new
kind:

```jsonl
{"id":"...","ts":...,"kind":"deploy","title":"vellum-project · prod","detail":"abc1234","repo":"trevormiller/vellum-project","repoRoot":"...","ref":{"env":"prod","sha":"abc1234"}}
```

No new file, no new sweep, no new schema. The deploy ledger IS the
activity feed filtered to `kind: deploy`.

## Logging — small `terminal-cli` extension

```bash
terminal-cli deploy log <env> [sha] [--note "<text>"]
# Defaults to git rev-parse HEAD in cwd
```

Emits one activity event with `kind: deploy`. ~30 lines added to
`bin/terminal-cli`.

## Telegram — no work

`/activity deploy` already filters; nothing new to write. Add
`/deploys` as a thin alias if it earns its keep:

```
/deploys              # last 10 deploy events (all repos)
/deploys @repo        # one repo
/deploys prod         # env-filter — uses ref.env
```

~20 lines in `src/main/telegram.ts`.

## Dashboard surface

Small section on the existing **Activity tab** (NOT a new tab): a
filter chip "deploy" toggles to show only deploy events with a
table-style render (env / sha / repo / when / note).

No new tab, no new IPC. The Activity tab already lists events.

## What this does NOT do

- No APM/Sentry/Datadog ingestion.
- No auto-detect of deploys (per-repo `/deploy` skill calls
  `terminal-cli deploy log` after a successful deploy — opt-in per
  repo).
- No regression detection or rollback.
- No new Deploys tab (collapses into Activity instead).

## App scope summary

- 1 new `terminal-cli` subcommand (~30 lines)
- 1 filter chip on Activity tab (~10 lines)
- 1 Telegram alias (~20 lines)

Plus a `/deploy` skill in project-template that calls the CLI after a
successful deploy. That's an agent script, not app code.

---

### Update — 2026-05-31 (largely implemented)

The auto-capture half shipped: a `deploy` ActivityKind (events.ts + renderer
mirror, classifier pattern, Activity icon/label/tone, NOTIFY:false), a
`terminal-cli deploy "<env>" "[sha]"` subcommand, and `cf-builds.ts` — a
read-only Cloudflare Workers deployments poller (off until a CF token +
account id in Settings + a `~/.config/TerMinal/cf-builds.json` watch list).
Deploy events now flow to the feed, tray, and Factory tab. Remaining: a
per-repo `/deploy` skill calling `terminal-cli deploy` after `wrangler
deploy`/send, and (optional) extending `cycle.ts` to a deploy funnel stage.

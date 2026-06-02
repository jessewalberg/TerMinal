---
id: 14
title: "Cross-repo fleet inventory + retire/archive state"
status: in-progress
priority: medium
horizon: next
hitl: false
type: feature
source: analysis
created: 2026-05-31
updated: 2026-06-02
prs: ["https://github.com/jessewalberg/TerMinal/pull/8"]
refs: []
---

## Why
The cockpit only "sees" repos with open sessions, schedules, or recent activity (`fleet:list` iterates the in-memory open-sessions map; `factory-health.byRepo` ranks by event volume so silent repos vanish). ~46 of ~57 fleet dirs are dormant and invisible. Missing visibility, not active damage (cron only fires explicit schedules).

## Recommendation
Add `fleet-inventory.ts` + a `fleet:repos` IPC that scans `resolvedProjectsDir()` once for git toplevel, `git log -1 --format=%ct` age, is-git-repo, last-activity ts, has-schedule. Bucket active/dormant/dead-end as a second FleetView section with a manual archive/hide toggle in settings.json. Visibility + a hide flag — not a retire *workflow*.

_Severity medium · effort medium · from the 2026-05-31 fit/gaps analysis._

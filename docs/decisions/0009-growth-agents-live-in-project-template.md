---
id: 0009
title: SEO/GEO/growth agents ship into project-template as opt-in dormant agents, not default fleet
anchor: ADR-0009
status: proposed
date: 2026-06-02
owner: Jesse
area: growth / agent distribution / project-template
confidence: medium
supersedes:
superseded-by:
---

## [1] Context

A multi-agent audit (2026-06-01) catalogued a set of growth and
reliability agents: SEO decay detection (`seo-content-decay`),
LLM-SEO / GEO posture (`robots-ai-policy`, `llm-seo-corpus-health`),
and related reliability/monitoring agents. These agents are only
meaningful for web properties that have:

- A public URL Google (or an AI crawler) can index.
- Google Search Console or equivalent analytics wired up.
- Deployable `robots.txt` / meta-tag tooling.

Non-web repos — TerMinal itself (a packaged macOS Electron app), CLI
tools, libraries, internal services with no public surface — have no
use for these agents. Running them in a default fleet would produce
noisy no-ops, spurious HITL prompts, and wasted AI spend on every
scheduled run.

The question is **where the agent definitions live** and **whether
they activate automatically** when a new project inherits from
`project-template`.

## [2] Decision

SEO, GEO, LLM-SEO, and growth/reliability agents are placed under
`templates/project-template/.agents/` as **opt-in, dormant-until-
configured** agents:

- The agent script files are present in the template so they can be
  copied and activated by repos that need them.
- Each such agent's script checks for a required configuration signal
  before doing any real work (e.g., `GSC_PROPERTY` env var set,
  `ai_crawler_posture` state key present, a `public_url` state key
  non-empty). If the signal is absent the script exits 0 with a
  single log line: `"[agent-name] not configured for this repo — skipping."`.
- They are **not** added to the default scheduled fleet that activates
  automatically for every repo inheriting from the template.
- A repo maintainer opts in by setting the relevant config keys and
  enabling the schedule in `~/.config/TerMinal/schedules.json`.

This keeps non-web repos (TerMinal, Electron apps, libraries) clean:
the agent files are present but completely silent when unconfigured,
producing a trivial no-op run rather than errors or HITL interrupts.

## [3] Tradeoffs & known limitations

- **Discovery friction.** Agents that live dormant in the template are
  less discoverable than agents that run and surface a "not configured"
  UI prompt. A web-repo maintainer must know to look for and activate
  them. Mitigate with a `docs/agents.md` or template README listing
  available opt-in agents and their activation requirements.
- **Copy-divergence risk.** If `project-template/.agents/` is updated,
  repos that copied the agent scripts do not automatically inherit the
  change. This is an existing template-propagation problem, not new.
- **No-op run cost.** Even a dormant exit-0 script incurs a tiny agent
  spin-up cost. Acceptable given the alternative (missing agents for
  configured repos), but schedules for growth agents should default to
  low frequency (daily or weekly, not sub-hourly).
- **TerMinal itself is a canonical non-web repo.** It is an Electron
  app; it has no public URL, no GSC property, and no meaningful
  `robots.txt`. It was the primary motivating example for this
  decision — growth agents must not clutter its agent fleet.

## [4] What would change our mind

- If the majority of repos in the portfolio are web properties and
  opting in manually creates a recurring maintenance burden, the
  default should flip to opt-out (agents active by default, disabled
  by a `growth_agents_disabled: true` state key).
- If TerMinal itself gains a public web presence (landing page, docs
  site) that benefits from GSC monitoring, a TerMinal-specific growth-
  agent config would be appropriate and this ADR would be updated to
  note the exception.
- If a centralized fleet-management UI in TerMinal makes activating
  dormant agents a one-click action with clear configuration guidance,
  the discoverability concern weakens and the opt-in posture becomes
  clearly correct.

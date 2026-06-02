---
id: 0007
title: Default portfolio AI-crawler posture is ALLOW; per-repo opt-out via ai_crawler_posture state key
anchor: ADR-0007
status: proposed
date: 2026-06-02
owner: Jesse
area: growth / seo / robots policy
confidence: medium
supersedes:
superseded-by:
---

## [1] Context

The `robots-ai-policy` agent needs a stable, authoritative signal for
whether a given repo/site should allow or block AI web crawlers
(GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot,
Bytespider, etc.).

Two competing interests exist across the portfolio:

- **Visibility / GEO** — allowing AI crawlers means the content can
  appear in generative-engine answers (ChatGPT, Perplexity, Claude,
  Google AI Overviews), which is a net positive for discovery and
  brand reach for public-facing products.
- **Content control / privacy** — some repos publish content that the
  owner does not want scraped into training corpora or surfaced in
  third-party model outputs (private docs, draft copy, client work,
  credentials-adjacent pages).

Without a default, each run of the policy agent would need an
ambiguous per-repo decision, creating drift and gaps.

## [2] Decision

The **portfolio-wide default is ALLOW** for all AI crawlers. A site
that has no explicit `ai_crawler_posture` state key is treated as
permitting all major AI crawlers by the `robots-ai-policy` agent.

Per-repo override is supported via the agent-state key
`ai_crawler_posture`:

- `"allow"` (or absent) — emit `Allow: *` for known AI crawler
  `User-agent` blocks in `robots.txt` / `robots` meta tags.
- `"block"` — emit `Disallow: /` for each known AI crawler bot.
- `"selective"` — a future extension; blocks training-crawler bots
  (GPTBot, CCBot) while allowing search/retrieval bots (ClaudeBot,
  Perplexity). Not implemented yet; treat as `"allow"` until the agent
  supports it.

The state key lives in the per-(repo, agent) state namespace consumed
by `terminal-cli state get/set`, matching the convention documented in
`project-template/.agents/scripts.md`.

## [3] Tradeoffs & known limitations

- **Default ALLOW is aggressive for content-sensitive repos.** Anyone
  maintaining private documentation or draft marketing copy in a
  public repo must actively opt out; the agent will not ask.
- **GEO upside is meaningful but not guaranteed.** Allowing crawlers
  does not guarantee citation; it only enables it.
- **Bot list maintenance.** The agent must keep its known-crawler list
  up to date as new AI crawlers emerge. An outdated list silently
  misses new bots.
- **`selective` mode is deferred.** The distinction between
  training-corpus bots and retrieval/search bots is valuable but
  requires per-bot metadata that does not yet exist in the agent.

## [4] What would change our mind

- A privacy-sensitive repo (client work, draft copy, credentials-
  adjacent pages) opts out — that is the canonical case for `"block"`.
- Evidence that default ALLOW leads to meaningful negative outcomes
  (scraped content mis-attributed, confidential data surfaced in model
  outputs) would shift the default to `"block"` or `"selective"`.
- If the portfolio expands to include repos with strong content-
  ownership requirements (publishing, media, legal), the default
  should be re-evaluated and the opt-in/opt-out polarity may flip.
- Broad industry move to treating `Disallow` on AI bots as a ranking
  signal (positive or negative) in conventional search would change
  the tradeoff calculus.

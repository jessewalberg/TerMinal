import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import {
  readFileSync,
  existsSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  chmodSync,
  unlinkSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { emitActivity } from './events'
import { repoForCwd } from './repo'
import { forgeFor } from './forge'
import { getPersona } from './personas'
import { learningsPreambleFor } from './learnings'
import {
  enginePath,
  engineDefaultModel,
  engineBinaryName,
  resolvedWorktreesDir,
  readSettings,
  roleRouting,
} from './settings'
import { resolveStepRouting, stageSkipReason, pickStreamDecoder, type StepRouting } from './routing'
import { planWatchdogTimers } from './run-watchdog'
import { readGlobalAgents, saveGlobalAgent } from './agents-global'
import { fileHitl, resolveHitl, onHitlResolve } from './hitl'
import { composeSteps, composeTaskSteps, pipelineLabel, TASK_PIPELINE_LABEL, type Step } from './pipelines'
import { buildEngineCmd } from './engine-cmd'
import { createCursorStreamDecoder } from './cursor-stream'
import { createClaudeStreamDecoder } from './claude-stream'
import { formatAgentRunCompletion, readRunLogFile } from './agent-run-log'

export { listPipelines, type PipelineId } from './pipelines'

export type Engine = 'codex' | 'claude' | 'cursor'

// On-demand Codex agents. Each runs in its own git worktree off the default
// branch; codex does the work, files tickets, and opens the PR itself. We just
// orchestrate the worktree + process and stream the output.

export type Agent = {
  id: string
  title: string
  description?: string
  icon?: string
  prompt: string
  opensPr?: boolean
  engine?: Engine // default engine; overridable per run
  // Per-engine model alias (claude: "haiku"|"sonnet"|"opus"; codex: model name
  // like "gpt-5-codex", "gpt-5", "o4-mini"). undefined → engine default. Lets
  // lightweight agents (health, deps audit) avoid burning the biggest model.
  model?: string
  // Computed by readAgents: true when .agents/<id>.sh (or the global script)
  // exists. The runner branches on this — UI uses it for a "sh" badge so
  // operators can see at a glance which agents are script-first.
  hasScript?: boolean
  // Run directly in the repo (no fresh worktree) — e.g. orchestrators like
  // /factory that manage their own worktrees internally, or quick additive ops.
  inPlace?: boolean
  // FORCE MODE — the runner sets TERMINAL_FORCE_MAIN=1 in the child env so the
  // global block-main-merge hook lets the agent push to / merge into main.
  // The prompt is auto-prepended with a FORCE preamble so the agent's own
  // skills don't refuse. UI labels these with a red FORCE chip. Reserve for
  // genuine emergencies — every other agent should go through the PR/MR gate.
  force?: boolean
  // provenance (set by readAgents): a built-in default, a default overridden by
  // this repo's .agents/agents.json, a repo-only agent, a global agent
  // (~/.config/TerMinal/agents/global.json), or a default overridden globally.
  source?: 'default' | 'override' | 'repo' | 'global'
}

export type AgentRunStatus = 'running' | 'done' | 'failed' | 'canceled' | 'interrupted'
export type AgentRun = {
  id: string
  agentId: string
  agentTitle: string
  engine: Engine
  persona?: string
  pipeline?: string // display label when this run chained multiple stages
  status: AgentRunStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
  repoRoot: string
  worktree: string
  branch: string
  output: string
  /** Snapshot of the agent's force flag at run-time — so historical runs
   *  display FORCE even if the agent is later deleted or rescoped. */
  force?: boolean
  /** Per-step resolved engines (task runs) — snapshot at spawn so the Runs tab
   *  can show a chip row instead of mislabeling a multi-engine run with one logo. */
  stepEngines?: Engine[]
  /** True while the run is parked at a plan-approval gate (HITL) — no child
   *  process is alive; resumeGate() continues it. */
  gateWaiting?: boolean
}

const OUTPUT_CAP = 400_000
const LOGIN_SHELL = process.env.SHELL || '/bin/zsh'
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

// Prepended to every FORCE-MODE agent's prompt so the spawned Claude/Codex
// knows it has main-push authority. Keep this terse and explicit — the
// agent's normal skills will refuse main pushes without it.
export const FORCE_PREAMBLE =
  '⚠ FORCE MODE — you are running with TERMINAL_FORCE_MAIN=1. You are authorized to commit and push DIRECTLY to main/master and to merge PRs/MRs without human approval. Use this authority ONLY for the specific emergency below; never use it to take shortcuts on routine work. Always file a follow-up backlog ticket capturing what you did and why so the team can audit it later.\n\n'

// Shipped by default on every repo. A repo's .agents/agents.json overrides or
// extends these (matched by id). All are ticket/MR-driven: file tickets
// for findings, open a PR when there are code changes. The factory entry is
// inPlace (no worktree) because /factory itself manages worktrees per stacked
// MR — wrapping it in one would create confusing worktree-inside-worktree.
const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'factory',
    title: 'Run /factory',
    description:
      'Continuous orchestrator — reconcile, run /stacked-mr passes, handle verdicts. Never merges main.',
    icon: 'Factory',
    opensPr: false,
    inPlace: true,
    prompt:
      "Act as the /factory orchestrator for THIS repository, following the project's /factory skill exactly. Continuously turn the backlog into REVIEWED, merge-ready PRs: reconcile with /merge-sync, then run /stacked-mr passes (build a stack TDD-first → batch-review to the bar → handle verdicts), repeating until the in-scope backlog is dry. NEVER merge to main/master — the human merges. Park any TRUE human-need (decision, approval, creds, hard blocker) to the global HITL inbox with .claude/bin/hitl. Skip tickets blocked by depends_on (any dependency whose status is not closed). Emit an activity event at each checkpoint. Do not invent scope. End with the stack summary for the human to merge.",
  },
  {
    id: 'docs',
    title: 'Improve docs',
    description: 'Generate/improve developer-facing documentation, then open a PR.',
    icon: 'BookText',
    opensPr: true,
    prompt:
      "Act as the documentation agent for technical developers. Improve and generate developer-facing documentation for this repository: README, docs/architecture.md, docs/runbooks, ADRs/learnings, and sidecar docs where behavior is undocumented or stale. Sweep recent git history for undocumented changes. Make accurate, surgical edits — never invent behavior. Then commit your changes and open a PR with a clear summary. For larger documentation gaps you can't finish in one pass, file a backlog ticket each (type: docs). End with a summary of the PR and any tickets filed.",
  },
  {
    id: 'deep-audit',
    title: 'Deep audit',
    description: 'Audit the codebase; file a ticket per finding, PR any safe fixes.',
    icon: 'ScanSearch',
    opensPr: true,
    prompt:
      'Act as a deep-audit agent for this repository. Thoroughly audit the codebase across correctness, security, architecture, performance, dead code, and dependency hygiene. For EVERY notable finding, file a backlog ticket (one per finding) with an accurate title, a type (bug/security/performance/dx/etc.), a priority, a specific description citing files and lines, and a self-contained agent-runnable fix prompt. Prefer filing tickets over making changes. If you apply any safe, self-contained fixes during the audit, commit them and open a PR. Do not make sweeping refactors. End with a summary listing every ticket filed (by id) and the PR if one was opened.',
  },
  {
    id: 'ticket-pr-cleanup',
    title: 'Ticket / PR cleanup',
    description: 'Reconcile the backlog + open PRs; close/dedupe/fix, file follow-ups, PR changes.',
    icon: 'ListChecks',
    opensPr: true,
    prompt:
      'Act as the ticket & PR cleanup agent for this repository. Review the backlog/ tickets and the open PRs, and reconcile them with reality: close or icebox stale, duplicate, or obsolete tickets (add a brief closing note to each), fix inconsistent or missing metadata (status, priority, type, horizon), and close tickets whose work already shipped (unlink merged PRs). File new tickets for any gaps or follow-ups you discover. If your cleanup changes ticket files or code, commit and open a PR. End with a summary of what you closed, edited, and filed, plus the PR if one was opened.',
  },
  {
    id: 'test-coverage',
    title: 'Strengthen tests',
    description: 'Add meaningful tests for under-tested behavior, then open a PR.',
    icon: 'TestTube2',
    opensPr: true,
    prompt:
      'Act as a test-coverage agent for this repository. Identify the most important under-tested or untested behavior (prioritize core logic, error paths, and recently-changed code) and add meaningful, adversarial tests that would catch real regressions — no tautological or implementation-mirroring assertions. Follow the project test runner and conventions, keep changes surgical, and make sure new tests exercise a real entry point. Commit and open a PR. For larger coverage gaps you cannot finish in one pass, file a backlog ticket each (type: testing). End with a summary of what you covered and the PR URL.',
  },
  {
    id: 'security-sweep',
    title: 'Security sweep',
    description: 'Focused security audit; ticket per finding, PR the safe fixes.',
    icon: 'ShieldAlert',
    opensPr: true,
    prompt:
      'Act as a focused security-sweep agent for this repository. Audit for exploitable vulnerabilities: injection (SQL/command/template), XSS/SSRF, broken authentication/authorization, insecure deserialization, secrets committed in code or git history, unsafe file/path handling, and vulnerable dependencies. For every finding, file a backlog ticket (type: security) with a precise title, a severity-aware priority, the affected files/lines, and a self-contained agent-runnable fix prompt. Apply only clearly-safe, self-contained fixes (with tests) and open a PR for those. End with a summary listing every ticket filed and the PR if one was opened.',
  },
  {
    id: 'perf-pass',
    title: 'Performance pass',
    description: 'Find + fix the highest-impact runtime/memory issues; PR the wins.',
    icon: 'Gauge',
    opensPr: true,
    prompt:
      'Act as a performance agent for this repository. Find the highest-impact runtime and memory issues — N+1 queries, accidentally-quadratic loops, redundant work in hot paths, missing batching/streaming, and avoidable allocations. Measure before/after where feasible and record the numbers. Apply safe, well-scoped optimizations with tests (do not trade readability for marginal gains) and open a PR. File a backlog ticket (type: performance) for any larger optimization you cannot safely land in one pass. End with a summary of the wins and the PR URL.',
  },
  {
    id: 'dep-upgrade',
    title: 'Dependency hygiene',
    description: 'Audit deps; bump safe pinned versions; PR with lockfile.',
    icon: 'PackageCheck',
    opensPr: true,
    prompt:
      'Act as a dependency-hygiene agent for this repository. Audit dependencies for known vulnerabilities and staleness. Upgrade safe, low-risk dependencies — pin exact versions (no ^ or ~), commit the lockfile, and only adopt versions at least 3 days old (a security-critical CVE fix may override the age rule; note it in the commit). Run the project audit and full test suite to confirm nothing breaks, then open a PR. File a backlog ticket for any risky or major upgrade that needs human judgment. End with a summary of what was bumped and the PR URL.',
  },
  {
    id: 'dead-code',
    title: 'Dead-code cleanup',
    description: 'Remove provably-unused code safely; ticket the uncertain; PR.',
    icon: 'Eraser',
    opensPr: true,
    prompt:
      'Act as a dead-code cleanup agent for this repository. Find unused exports, unreachable branches, orphaned files, and stale feature flags. Remove only what is provably unused (verify with a references/usage search and the type checker/build), keeping changes surgical and reversible. Run the test suite and build to confirm nothing breaks, then open a PR. For anything you suspect is dead but cannot prove safely, file a backlog ticket instead of deleting. End with a summary of what you removed and the PR URL.',
  },
  // ━━ Generic daily-loop presets (modeled on Trevor's old BitBadges daily) ━━
  // Each preset is repo-agnostic and ticket/PR-driven. Skipping presets that
  // overlap existing defaults (auto-docs → docs, auto-test → test-coverage,
  // security-audit → security-sweep, perf-infra → perf-pass, dependabot →
  // dep-upgrade, auto-fix → deep-audit+ticket-pr-cleanup).
  {
    id: 'comments-inspector',
    title: 'Comments inspector',
    description: 'Audit READMEs, CLAUDE.md, JSDoc, inline comments for staleness or low-value noise.',
    icon: 'MessageSquare',
    opensPr: true,
    prompt:
      "Act as a comments-quality agent for this repository. Audit in-repo READMEs (root + nested), CLAUDE.md files, JSDoc / docstrings, and inline comments. Flag: WHAT-comments that just restate the code (delete-candidate per global §7 — code should self-document), stale comments that contradict current behavior, missing WHY-comments where a non-obvious constraint or invariant would surprise a reader, and incorrect/outdated docs at the top of files. Apply only safe, surgical changes (delete dead WHAT-comments, fix wrong-vs-code comments). File a backlog ticket (type: docs) for larger rewrites you can't do in one pass. Open a PR for any changes. End with a summary of fixes + tickets filed.",
  },
  {
    id: 'product-audit',
    title: 'Product audit',
    description: 'Static product/UX read — features, flows, copy, IA. File tickets for gaps.',
    icon: 'ClipboardList',
    opensPr: false,
    prompt:
      "Act as a product-audit agent for this repository. Without running the app, do a static read of the product surface: routes, screens/components, copy, navigation/IA, primary user flows, and onboarding. Identify product gaps — missing affordances, confusing copy, broken/half-built flows, inconsistencies across surfaces, and accessibility issues visible from the source. For each finding, file a backlog ticket (type: ux or feature) with a precise title, the affected files, and a self-contained fix prompt. Don't edit code. End with a summary of every ticket filed.",
  },
  {
    id: 'friction-hunter',
    title: 'Friction hunter',
    description: 'Walk onboarding/first-use as a new user; file tickets where things confuse or break.',
    icon: 'Footprints',
    opensPr: false,
    prompt:
      "Act as a friction-hunter agent for this repository. Pretend you are a brand-new user encountering this product for the first time. Walk the onboarding / first-use path end-to-end — read the README, attempt the setup, run the first flow (CLI command, route, UI). Note every point of friction: ambiguous instructions, missing steps, errors with poor messages, half-wired features, dead links, broken happy paths. For each friction point, file a backlog ticket (type: ux or bug) with the exact reproduction and a fix prompt. Don't edit code. End with a numbered list of friction points + ticket ids.",
  },
  {
    id: 'red-team-audit',
    title: 'Red-team audit',
    description: 'Adversarial cross-layer sweep — chain weaknesses, abuse cases, real attacker mindset.',
    icon: 'Swords',
    opensPr: false,
    prompt:
      "Act as a red-team agent for this repository. Unlike a per-vector security sweep, do an ADVERSARIAL cross-layer audit: think like a motivated attacker trying to chain small weaknesses into a real compromise. Look at auth + session flow + state mutation + IPC + external calls as a SYSTEM, not in isolation. Identify abuse cases (rate-limit bypass, race conditions on the auth boundary, trust assumptions that don't hold under concurrency, side-channel leaks). File a backlog ticket per attack-chain (type: security) with the chain laid out step-by-step and the smallest fix that breaks the chain. Don't edit code. End with the list of attack chains and ticket ids.",
  },
  {
    id: 'intelligence',
    title: 'Intelligence sweep',
    description: 'Scan for market / competitor / ecosystem signals relevant to this project.',
    icon: 'Telescope',
    opensPr: false,
    prompt:
      "Act as an intelligence-gathering agent for this repository. Identify what this product/codebase does (from README, package.json, code) and then sweep for relevant external signals: competitor moves, ecosystem/protocol updates, new libraries that obsolete current dependencies, market shifts that change the priority of in-flight work. Use whatever web/search tools you have. File a backlog ticket per actionable signal (type: feature or docs, horizon: future or next) with the source link and the implication. Don't edit code. End with a digest of signals + ticket ids.",
  },
  {
    id: 'strategy',
    title: 'Strategy review',
    description: 'Step back: are we building the right things? Surface drift from stated goals.',
    icon: 'Target',
    opensPr: false,
    prompt:
      "Act as a strategy-review agent for this repository. Step back from execution and assess direction: read the README, architecture.md, ADRs, recent commits, and the open backlog. Identify drift between stated goals and actual work, abandoned-but-not-formally-deprioritized lines, and missing strategic bets the codebase implies but doesn't pursue. File backlog tickets (type: docs for ADR candidates, type: feature for missing strategic moves) — never edit code. Write the substantive strategic read (alignment vs. drift assessment + top 3 strategic moves) to reports/YYYY-MM-DD-strategy-read.md (create reports/ if missing). End with the report path and the ticket ids filed.",
  },
  {
    id: 'cert-check',
    title: 'TLS / cert check',
    description: 'Check production TLS expiry + cert hygiene for any prod hostnames this repo serves.',
    icon: 'Lock',
    opensPr: false,
    prompt:
      "Act as a TLS-hygiene agent for this repository. Find every production hostname this repo serves (from deployment manifests, docker-compose, k8s yaml, .env.example, docs). For each hostname, probe its TLS certificate (openssl s_client or equivalent) and check: days-until-expiry, certificate chain validity, hostname match, and minimum TLS version. File a backlog ticket (type: security or dx) for any cert expiring within 30 days, mismatched cert, or weak TLS config. Don't edit code. Write the full hostname / expiry / chain / TLS-version table to reports/YYYY-MM-DD-cert-check.md (create reports/ if missing) — durable snapshot of cert hygiene, not just the flagged issues. End with the report path and the ticket ids filed.",
  },
  {
    id: 'translations-check',
    title: 'Translations check',
    description: 'Find hardcoded English strings + drifted locale files; file tickets for gaps.',
    icon: 'Languages',
    opensPr: false,
    prompt:
      "Act as a translations-hygiene agent for this repository. Determine if this product uses i18n (look for next-intl, react-i18next, formatjs, locale files under src/locales or similar). If not, no-op and report. If yes, scan for: hardcoded user-facing English strings that bypass the i18n system, missing keys in non-default locale files, stale translations where the source key changed, and untranslated UI surfaces. File a backlog ticket per gap (type: ux or docs) with the affected files and a fix prompt. Don't edit code. End with the gap summary and ticket ids.",
  },
  {
    id: 'changelog',
    title: 'Changelog update',
    description: 'Roll recent merged commits/PRs into a CHANGELOG entry; PR the result.',
    icon: 'ScrollText',
    opensPr: true,
    prompt:
      "Act as a changelog agent for this repository. If a CHANGELOG.md or similar exists, identify the last release entry date and roll all merged work since then into a new Unreleased (or next-version) section: features, fixes, breaking changes, internal/chore. Pull from git log + closed PRs + closed backlog tickets. Use Conventional Commits prefixes to bucket. Keep entries user-facing — drop pure refactors unless they change behavior. Commit and open a PR. If no CHANGELOG exists, file a docs ticket proposing one rather than creating it unilaterally. End with the entry diff summary and PR URL.",
  },
  {
    id: 'simplification',
    title: 'Simplification pass',
    description: 'Find over-engineering / premature abstraction; PR safe simplifications.',
    icon: 'Scissors',
    opensPr: true,
    prompt:
      "Act as a simplification agent for this repository. Find over-engineering per global §2: speculative flexibility, single-use abstractions, configurability nobody uses, error handling for impossible scenarios, generic helpers that wrap one call site. Apply safe, well-scoped simplifications with tests still green (rewrite a 200-line module to 50 only when it stays readable and equivalent). File backlog tickets (type: refactor or dx) for larger simplifications you can't safely land. Open a PR for what you simplify. End with a list of what was simplified (lines before/after) + tickets filed + PR URL.",
  },
  {
    id: 'devils-advocate',
    title: "Devil's advocate",
    description: 'Counter-argue a recent decision/ADR; file a ticket if the counter holds.',
    icon: 'MessageCircleQuestion',
    opensPr: false,
    prompt:
      "Act as a devil's-advocate agent for this repository. Pick the most consequential recent decision — last accepted ADR, last significant architecture commit, last major feature direction — and build the strongest counter-argument. Steelman the opposite choice: what would have made it correct, what costs the chosen path now carries, what's the smallest reversal that would unwind it. Always write the full counter-argument to reports/devils-advocate/YYYY-MM-DD-<slug>.md (create reports/devils-advocate/ if missing) so the steelman is durable, not chat-only. Only if the counter holds enough water that reconsideration would be cheaper than the eventual reversal, additionally file a backlog ticket (type: docs, source: devils-advocate) proposing an ADR-revisit and linking the report. Don't edit code. End with the report path and the ticket id (if filed).",
  },
  {
    id: 'bloat-check',
    title: 'Bloat check',
    description: 'Delete low-value tickets, suggestions, and dead artifacts. Keep the backlog honest.',
    icon: 'Recycle',
    opensPr: false,
    prompt:
      "Act as a bloat-check agent for this repository. Audit the backlog and artifact surfaces — open tickets, .reviews/ suggestions, .checks/ reports, sessions/ closed docs — for low-value or stale items: tickets nobody will ever do, suggestions copy-pasted into ticket form, reports older than the work they discuss, abandoned session docs. Close (with a one-line closing note) or icebox the cruft. Don't delete prose lightly; preserve genuinely useful learnings. End with a list of every item closed/iceboxed and the rationale.",
  },
  {
    id: 'knowledge-base',
    title: 'Knowledge base sweep',
    description: 'Cross-link, deduplicate, surface gaps across ADRs / learnings / runbooks.',
    icon: 'Library',
    opensPr: true,
    prompt:
      "Act as a knowledge-base agent for this repository. Sweep docs/decisions/, docs/learnings/, and docs/runbooks/ for: duplicate entries (same gotcha captured twice), missing cross-links between related items, ADRs that should be superseded by newer ones but aren't marked, runbooks whose last-verified date is stale. Apply safe edits (add cross-link references, mark stale runbooks, set supersedes: on duplicate ADRs). File backlog tickets (type: docs) for any gap you find — a learning that should exist for a known recurring issue, a runbook that should exist for a manual procedure. Open a PR for the safe edits. End with a summary.",
  },
  {
    id: 'ci-improver',
    title: 'CI improver',
    description: 'Observe CI runs since last run; file tickets + PR safe fixes for failures and flakes.',
    icon: 'Workflow',
    opensPr: true,
    prompt:
      "Act as a CI-improver agent for this repository. Observe recent CI runs (workflow / pipeline runs) since this agent last ran. Use the TerMinal MCP tools to track state: read the saved checkpoint via get_agent_state (key: 'last_run_id') and default to the newest 30 runs if no checkpoint exists. For each failed or flaky run (same step / job failing intermittently across runs in the window): pull the failing job's log, identify the root cause (test failure, build error, dep install error, timeout, infra issue, flake), and route the finding durably — never chat-only. File a backlog ticket per distinct failure pattern (type: testing for test failures, type: ci for build/infra, type: bug for runtime issues, type: dependency for dep/install issues) with the failing workflow/pipeline + job + step, the error excerpt, and a self-contained agent-runnable fix prompt. For SAFE, well-scoped fixes (pin a flapping dep, bump a known-too-tight timeout, add retry to a documented-flaky step, fix a hard-coded path) apply them with tests still green and open a PR. For flakes you can identify but not safely fix (timing-dependent tests, infra flake), file a ticket only and tag horizon: next. After processing, save the newest observed run id via set_agent_state (key: 'last_run_id') so the next run only inspects newer runs — this is the watermark that keeps each invocation cheap. End with a summary of failures classified, tickets filed (by id), and PR URL if one was opened.",
  },
  {
    id: 'summary',
    title: 'Daily summary',
    description: 'Roll up today\'s repo activity into a concise digest under reports/.',
    icon: 'Newspaper',
    opensPr: false,
    prompt:
      "Act as a daily-summary agent for this repository. Produce a concise digest of TODAY's activity: merged commits + closed PRs, opened tickets, closed tickets, code-review verdicts, check artifacts, agent runs. Pull from git log, gh/glab, backlog/, .reviews/, .checks/. Write it to reports/YYYY-MM-DD-daily-summary.md (create reports/ if missing). Keep it scannable — one section per category, short bullets, links to underlying artifacts. Don't edit code. Don't open a PR (the report is committed directly to main? — actually no, follow the project's branching rule; if main is protected, drop the file uncommitted and report the path). End with the path to the digest.",
  },
  {
    id: 'beacon',
    title: 'Process Beacon feedback',
    description: 'Drain end-user feedback from the Beacon widget into backlog tickets.',
    icon: 'RadioTower',
    opensPr: false,
    prompt:
      "Act as the Beacon-feedback agent for THIS repository. Beacon (github.com/trevormil/beacon) is the embeddable feedback widget shipped on the project's app; this agent drains the widget queue into backlog tickets so /factory can pick them up. Resolve the Beacon connection in this order: env vars BEACON_ENDPOINT + BEACON_PROJECT + BEACON_SECRET → ~/.config/beacon/config.json (global default) → .beacon/config.json in the repo root. If none resolve, exit with a one-line note telling the user to run `bunx @trevormil/beacon@latest admin create-project --slug <repo-slug> --origins <urls> -e <endpoint>` and save the printed secret to one of those locations. With config resolved, fetch new feedback via `bunx --bun @trevormil/beacon@latest poll --project $BEACON_PROJECT --secret $BEACON_SECRET --endpoint $BEACON_ENDPOINT --status new --limit 50`. For EACH item: read message/url/userAgent/email; file ONE backlog ticket via the project's /ticket skill with an accurate title summarizing the feedback, a type (bug for things-broken, feature for missing-functionality, ux for friction, dx for tooling, performance for slowness), priority (critical/high/medium/low based on severity heuristics), and a description that includes the raw message, the captured URL, the user agent, and (when provided) the user's email for follow-up. If several items rhyme into the same underlying ticket, file ONE merged ticket grouping their IDs in the description. Mark each processed feedback item via `bunx @trevormil/beacon@latest mark <id> --project ... --secret ... --endpoint ...` after the ticket lands. Do NOT edit production code — leave the build to /factory. End with a list of ticket IDs filed and any items left unprocessed (e.g. couldn't classify).",
  },
  // ── FORCE agents ─────────────────────────────────────────────────────────
  // These bypass the main-branch gate via TERMINAL_FORCE_MAIN=1. Reserved
  // for production emergencies. Marked `force: true` so the runner injects
  // the env var, prepends the FORCE preamble to the prompt, and the UI
  // shows a red FORCE chip.
  {
    id: 'emergency-fix',
    title: 'Emergency fix',
    description: 'Production hotfix: smallest patch, commit + push direct to main, file follow-up ticket.',
    icon: 'AlertOctagon',
    opensPr: false,
    force: true,
    prompt:
      "Act as an emergency-fix agent for THIS repository. A production-impacting bug is breaking real users RIGHT NOW. Identify the SMALLEST POSSIBLE PATCH that stops the bleeding — not the proper fix, not a refactor, not the cleanup. Sequence: (1) reproduce the failure briefly to confirm scope; (2) write the minimum surgical change; (3) run the existing test suite (or the most relevant subset) and confirm it stays green; (4) commit on main with a `fix:` Conventional Commits subject mentioning what was breaking; (5) push directly to main (`git push origin main`) — you are authorized; (6) file a backlog ticket (type: bug, priority: high, source: emergency-fix) describing the real root cause and a proper fix prompt for /factory to handle later. Never expand scope. Never touch unrelated code. If the smallest patch isn't obvious within ~5 minutes of investigation, abort and file a critical ticket instead — paged humans are cheaper than a broken hotfix. End with the SHA you pushed, the brief explanation, and the follow-up ticket id.",
  },
  {
    id: 'unblock-ci',
    title: 'Unblock CI',
    description: 'Main CI is red. Diagnose; revert, pin, or skip the hosed bit; push direct to main.',
    icon: 'ShieldAlert',
    opensPr: false,
    force: true,
    prompt:
      "Act as an unblock-CI agent for THIS repository. The default-branch CI run is RED and blocking the whole team. Your job: get main green so other PRs can merge. Sequence: (1) pull the latest main and the failing CI run's logs (use TerMinal MCP CI tools or `gh run view` / `glab ci view`); (2) classify the failure — is it (a) a regression from the last merge, (b) a flapping test, (c) a dep / install break, or (d) infra? (3) apply the narrowest fix that turns main green: prefer `git revert <bad-sha>` for a regression; for a true flake, mark the test with the project's skip/retry convention; for a dep break, pin the working version; for infra, file a ticket and exit. (4) Run the suite locally to confirm green; (5) commit on main and push directly (`git push origin main`); (6) file a follow-up ticket (type: testing or ci or dependency, priority: high) explaining what was broken and what the proper fix is. Never roll forward an unrelated change. If the failure is genuinely outside your fix budget, file a ticket and exit — do not paper over a real bug. End with the action taken (reverted SHA / pinned version / skipped test path), the new main SHA, and the follow-up ticket id.",
  },
  {
    id: 'revert-main',
    title: 'Revert last main commit',
    description: 'Narrow force-op: git revert the most recent main commit and push.',
    icon: 'Undo2',
    opensPr: false,
    force: true,
    prompt:
      "Act as a revert-main agent for THIS repository. The most recent commit on main is bad and must be undone. Sequence: (1) confirm you're on the latest main and identify HEAD's SHA + commit message; (2) run `git revert --no-edit HEAD` to produce a revert commit; (3) run the existing test suite to confirm the revert lands cleanly; (4) push directly to main (`git push origin main`) — you are authorized; (5) file a backlog ticket (type: bug, priority: high, source: revert-main) titled `Re-do reverted: <original subject>` with the reverted SHA + reason for the revert + a fix prompt so /factory can re-attempt the change properly. Refuse if HEAD is already a revert (would be a no-op or destructive). Refuse if HEAD is more than 24h old (the team has likely moved on and a straight revert may be wrong). End with the reverted SHA, the new main SHA, and the follow-up ticket id.",
  },
]

function readRepoAgents(repoRoot: string): Agent[] {
  const f = join(repoRoot, '.agents', 'agents.json')
  if (!existsSync(f)) return []
  try {
    const a = JSON.parse(readFileSync(f, 'utf8'))
    const list = Array.isArray(a) ? a : Array.isArray(a?.agents) ? a.agents : []
    return list.filter((x: Agent) => x && x.id && x.title && x.prompt)
  } catch {
    return []
  }
}

/** Built-in defaults, with the repo's .agents/agents.json overriding by id.
 *  Each agent is annotated with its `source` so the UI can distinguish a stock
 *  default, a default this repo has customized, and a repo-only agent. */
// Discover script-only agents from a directory: any `<id>.sh` paired with an
// optional sidecar `<id>.json` of metadata. No JSON entry in agents.json
// required — drop the .sh and the agent shows up.
function readScriptAgents(dir: string): Agent[] {
  if (!existsSync(dir)) return []
  const out: Agent[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const f of entries) {
    if (!f.endsWith('.sh')) continue
    const id = f.slice(0, -3)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue
    // Sidecar JSON (optional) provides metadata; otherwise we synthesize sane defaults.
    let meta: Partial<Agent> = {}
    const sidecar = join(dir, `${id}.json`)
    if (existsSync(sidecar)) {
      try {
        meta = JSON.parse(readFileSync(sidecar, 'utf8'))
      } catch {
        /* malformed sidecar — fall back to defaults */
      }
    }
    out.push({
      id,
      title: meta.title || id,
      description: meta.description,
      icon: meta.icon || 'Wrench',
      // The prompt is the canonical "what does this agent do" surface in the UI;
      // for script-only agents we point at the file rather than duplicate the bash.
      prompt: meta.prompt || `Script-based agent · body in ${dir.replace(homedir(), '~')}/${f}`,
      opensPr: meta.opensPr,
      engine: meta.engine,
      model: meta.model,
      inPlace: meta.inPlace,
      force: meta.force,
    })
  }
  return out
}

export function readAgents(repoRoot: string): Agent[] {
  type Layered = { agent: Agent; layers: Set<'default' | 'global' | 'repo'> }
  const byId = new Map<string, Layered>()
  const merge = (a: Agent, layer: 'default' | 'global' | 'repo') => {
    const existing = byId.get(a.id)
    if (existing) {
      existing.layers.add(layer)
      // later layer wins for individual fields (only override fields it sets)
      existing.agent = { ...existing.agent, ...a }
    } else {
      byId.set(a.id, { agent: { ...a }, layers: new Set([layer]) })
    }
  }
  // Layer order: defaults → global (json then scripts) → repo (json then scripts).
  // Script bodies are independent from the JSON metadata; the runtime branches
  // on file existence, but the agent list cares only about the merged metadata.
  for (const a of DEFAULT_AGENTS) merge(a, 'default')
  for (const a of readGlobalAgents()) merge(a, 'global')
  for (const a of readScriptAgents(join(homedir(), '.config', 'TerMinal', 'scripts'))) merge(a, 'global')
  if (repoRoot) for (const a of readRepoAgents(repoRoot)) merge(a, 'repo')
  if (repoRoot) for (const a of readScriptAgents(join(repoRoot, '.agents'))) merge(a, 'repo')

  const out: Agent[] = []
  for (const { agent, layers } of byId.values()) {
    let source: Agent['source']
    if (layers.has('repo')) source = layers.has('default') || layers.has('global') ? 'override' : 'repo'
    else if (layers.has('global')) source = layers.has('default') ? 'override' : 'global'
    else source = 'default'
    out.push({ ...agent, source, hasScript: !!locateScript(repoRoot, agent.id) })
  }
  return out
}

/** Upsert an agent into <repo>/.agents/agents.json (creates it). Overriding a
 *  built-in default = writing an entry with the same id. */
export function saveAgent(
  repoRoot: string,
  agent: Partial<Agent> & { id: string; title: string; prompt: string },
): { ok: true } | { error: string } {
  if (!repoRoot) return { error: 'not a git repo' }
  const id = (agent.id || '').trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { error: 'id must be kebab-case (a-z, 0-9, -)' }
  if (!agent.title?.trim()) return { error: 'title is required' }
  if (!agent.prompt?.trim()) return { error: 'prompt is required' }
  const entry: Agent = {
    id,
    title: agent.title.trim(),
    prompt: agent.prompt.trim(),
    description: agent.description?.trim() || undefined,
    icon: agent.icon || undefined,
    engine: agent.engine,
    model: agent.model?.trim() || undefined,
    opensPr: agent.opensPr,
    inPlace: agent.inPlace,
    force: agent.force,
  }
  const dir = join(repoRoot, '.agents')
  const f = join(dir, 'agents.json')
  const list = readRepoAgents(repoRoot).filter((a) => a.id !== id)
  list.push(entry)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(f, JSON.stringify(list, null, 2) + '\n')
    return { ok: true }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Remove an agent override from .agents/agents.json — a customized default
 *  reverts to the built-in; a repo-only agent is deleted. */
export function resetAgent(repoRoot: string, id: string): { ok: true } | { error: string } {
  const f = join(repoRoot, '.agents', 'agents.json')
  if (!existsSync(f)) return { ok: true }
  try {
    const list = readRepoAgents(repoRoot).filter((a) => a.id !== id)
    writeFileSync(f, JSON.stringify(list, null, 2) + '\n')
    return { ok: true }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// every git repo gets the default agents
export function hasAgents(repoRoot: string): boolean {
  return !!repoRoot
}

const runs = new Map<string, AgentRun>()
const procs = new Map<string, ChildProcess>()
// Plan-gate parking: run id → resume/cancel hooks + the gate's HITL item id.
// A gated run has NO live child process; resumeGate() (HITL approve / Runs
// tab) continues it, cancelRun() finalizes it. In-memory only — a gated run
// does not survive an app restart (it boots back as 'interrupted', same as
// every in-process run).
const pendingGates = new Map<
  string,
  { resume: () => void; cancel: () => void; hitlId: string }
>()

// EVERY surface that resolves the gate's HITL item (IPC, Telegram /resolve,
// inline keyboard) resumes the parked run — registered here so hitl.ts stays
// agents-free. resumeGate is a no-op for runs that are not parked, so other
// run-linked agent HITLs resolve harmlessly.
onHitlResolve((item) => {
  if (item.runId && item.runSource === 'agent') resumeGate(item.runId)
})
let emit: (channel: string, payload: unknown) => void = () => {}
export function onAgentEvent(fn: (channel: string, payload: unknown) => void) {
  emit = fn
}

// --- persistence: one <id>.json (metadata) + <id>.log (output) per run --------
const RUNS_DIR = join(homedir(), '.config', 'TerMinal', 'agent-runs')
const KEEP_RUNS = 100
const metaPath = (id: string) => join(RUNS_DIR, `${id}.json`)
const logPath = (id: string) => join(RUNS_DIR, `${id}.log`)

function persistMeta(run: AgentRun) {
  try {
    mkdirSync(RUNS_DIR, { recursive: true })
    const { output: _o, ...meta } = run
    writeFileSync(metaPath(run.id), JSON.stringify(meta))
  } catch {
    /* best effort */
  }
}
function appendLog(id: string, chunk: string) {
  try {
    appendFileSync(logPath(id), chunk)
  } catch {
    /* best effort */
  }
}
export function readAgentRunLog(id: string, fallback = ''): string {
  return readRunLogFile(id, { runsDir: RUNS_DIR, fallback })
}

// Load past runs from disk into memory at startup. Runs still marked 'running'
// were orphaned by an app quit → mark 'interrupted'. Prune to the newest N.
let loaded = false
export function loadPersistedRuns() {
  if (loaded) return
  loaded = true
  let files: string[] = []
  try {
    files = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return
  }
  const metas: AgentRun[] = []
  for (const f of files) {
    try {
      const m = JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8')) as AgentRun
      if (m.status === 'running') {
        m.status = 'interrupted'
        // The in-memory gate died with the old process — a recovered run must
        // not advertise a resumable approve action it can't honor.
        m.gateWaiting = false
      }
      let output = ''
      try {
        const buf = readFileSync(logPath(m.id), 'utf8')
        output = buf.length > OUTPUT_CAP ? buf.slice(-OUTPUT_CAP) : buf
      } catch {
        /* no log */
      }
      metas.push({ ...m, output })
    } catch {
      /* skip corrupt */
    }
  }
  metas.sort((a, b) => a.startedAt - b.startedAt)
  // prune oldest beyond KEEP_RUNS (delete files too)
  while (metas.length > KEEP_RUNS) {
    const old = metas.shift()!
    try {
      rmSync(metaPath(old.id), { force: true })
      rmSync(logPath(old.id), { force: true })
    } catch {
      /* ignore */
    }
  }
  for (const m of metas) {
    if (runs.has(m.id)) continue // never clobber a live (in-memory) run
    runs.set(m.id, m)
    if (m.status === 'interrupted') persistMeta(m) // persist the corrected status
  }
}

function defaultBase(repoRoot: string): string {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
  } catch {
    /* no origin HEAD */
  }
  for (const b of ['main', 'master']) {
    try {
      git(['rev-parse', '--verify', b])
      return b
    } catch {
      /* not present */
    }
  }
  return 'HEAD'
}

export function listRuns(): AgentRun[] {
  loadPersistedRuns()
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)
}
export function getRun(id: string): AgentRun | null {
  return runs.get(id) ?? null
}

// Build the engine command. codex needs -C; claude uses cwd. Both run through a
// login shell so $PATH has brew/local bins, and with stdin = /dev/null (else
// they block reading "additional input from stdin" on an empty pipe).
// Locate an executable script for this agent. Per-repo wins over global so a
// repo can override a global agent's body. The runner branches: if a script
// exists, exec it with env vars; else fall back to the legacy claude/codex
// prompt-wrap built by buildCmd().
const TERMINAL_BIN_DIR = join(homedir(), '.config', 'TerMinal', 'bin')
const GLOBAL_SCRIPTS_DIR = join(homedir(), '.config', 'TerMinal', 'scripts')
export function locateScript(repoRoot: string, agentId: string): string | null {
  const perRepo = join(repoRoot, '.agents', `${agentId}.sh`)
  if (existsSync(perRepo)) return perRepo
  const global = join(GLOBAL_SCRIPTS_DIR, `${agentId}.sh`)
  if (existsSync(global)) return global
  return null
}

// State sidecar — mirrors terminal-cli's path layout exactly:
//   ~/.config/TerMinal/agent-state/<repo-basename>/<agentId>.json
// We expose read + reset to the renderer so the Agents tab can surface
// "last scanned X ago" without users `cat`-ing the JSON.
const AGENT_STATE_DIR = join(homedir(), '.config', 'TerMinal', 'agent-state')
function agentStateFile(repoRoot: string, agentId: string): string {
  return join(AGENT_STATE_DIR, basename(repoRoot) || 'unknown', `${agentId}.json`)
}
export type AgentState = {
  lastScannedSha?: string
  lastScannedRef?: string
  lastRunAt?: number
  lastRunId?: string
  [key: string]: unknown
}
export function readAgentState(
  repoRoot: string,
  agentId: string,
): { path: string; exists: boolean; state: AgentState } {
  const path = agentStateFile(repoRoot, agentId)
  if (!existsSync(path)) return { path, exists: false, state: {} }
  try {
    return { path, exists: true, state: JSON.parse(readFileSync(path, 'utf8')) as AgentState }
  } catch {
    return { path, exists: true, state: {} }
  }
}
export function resetAgentState(repoRoot: string, agentId: string): { ok: true } | { error: string } {
  const path = agentStateFile(repoRoot, agentId)
  if (!existsSync(path)) return { ok: true }
  try {
    unlinkSync(path)
    return { ok: true }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

function buildCmd(engine: Engine, worktree: string, prompt: string, model?: string): string {
  return buildEngineCmd(enginePath(engine), engine, worktree, prompt, model)
}

// Pipeline definitions + composition are pure (see ./pipelines, unit-tested).
// All stages share the worktree + branch, so a later stage sees what an earlier
// one committed. buildSteps just resolves the persona prompt off disk first.
function buildSteps(repoRoot: string, base: Step, personaId?: string, pipelineId?: string) {
  const p = personaId ? getPersona(repoRoot, personaId) : null
  return {
    steps: composeSteps(base, p?.prompt ?? null, pipelineId),
    persona: p?.title,
    pipeline: pipelineLabel(pipelineId),
  }
}

type RunSpec = {
  id: string
  title: string
  steps: Step[]
  engine: Engine
  persona?: string
  pipeline?: string
  /** PR-tab agents work ON an existing MR head instead of a fresh branch. */
  prRef?: { iid: number; sourceBranch: string }
  /** Run in the repo itself (no worktree) — for quick, additive ops like ticket filing. */
  inPlace?: boolean
  /** FORCE-MODE: spawn the child with TERMINAL_FORCE_MAIN=1 and prepend FORCE_PREAMBLE. */
  force?: boolean
  /** Optional per-engine model alias passed to the CLI as `--model <name>`. */
  model?: string
}

function runSpec(repoRoot: string, spec: RunSpec): AgentRun | { error: string } {
  if (!repoRoot) return { error: 'not a git repo' }
  if (!spec.steps.length) return { error: 'no steps' }
  // Concurrent-run guard: never let two runs of the same agent on the same
  // repo overlap. If one is already running, surface HITL + refuse the new
  // run rather than silently allowing duplicates to thrash on the same worktree.
  for (const r of runs.values()) {
    if (r.status === 'running' && r.agentId === spec.id && r.repoRoot === repoRoot) {
      const msg = `${spec.title} is already running (run ${r.id.slice(0, 8)}) — refusing to start a duplicate`
      fileHitl({
        source: 'agent',
        title: `Duplicate agent run blocked · ${spec.title}`,
        action: 'another run is in progress; cancel it or wait for it to finish',
        detail: `existing run ${r.id} · started ${new Date(r.startedAt).toLocaleString()}`,
        repo: basename(repoRoot),
        repoRoot,
      })
      return { error: msg }
    }
  }
  const ts = Date.now()
  // ts + random tag → unique worktree path + branch even if two runs of the
  // same agent start in the same millisecond (parallel fan-out / fast clicks).
  const tag = `${ts}-${Math.random().toString(36).slice(2, 6)}`
  let worktree: string
  let branch: string
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (spec.inPlace) {
    // Run directly in the repo (no worktree) — e.g. quick ticket filing that must
    // land in the real backlog/, visible immediately, not on an isolated branch.
    worktree = repoRoot
    branch = '(working tree)'
  } else {
    worktree = join(resolvedWorktreesDir(), basename(repoRoot) || 'repo', `${spec.id}-${tag}`)
    try {
      if (spec.prRef) {
        // Fetch the MR head and check it out detached; the agent pushes back to
        // the source branch. Reference origin/<branch> rather than the shared
        // FETCH_HEAD so concurrent PR agents don't clobber each other.
        git(['fetch', 'origin', spec.prRef.sourceBranch])
        let ref = `origin/${spec.prRef.sourceBranch}`
        try {
          git(['rev-parse', '--verify', '--quiet', ref])
        } catch {
          ref = 'FETCH_HEAD' // remote-tracking ref not configured — best effort
        }
        git(['worktree', 'add', '--detach', worktree, ref])
        branch = spec.prRef.sourceBranch
      } else {
        branch = `agent/${spec.id}-${tag}`
        git(['worktree', 'add', worktree, '-b', branch, defaultBase(repoRoot)])
      }
    } catch (e) {
      return { error: `worktree: ${(e as Error).message}` }
    }
  }
  const repoLabel = repoForCwd(repoRoot)?.path || basename(repoRoot)
  const baseLine = spec.prRef
    ? `▸ on ${forgeFor(repoRoot).label} ${forgeFor(repoRoot).sym}${spec.prRef.iid} · branch ${branch}`
    : `▸ branch ${branch} (off ${defaultBase(repoRoot)})`
  const forceLine = spec.force ? '▸ ⚠ FORCE MODE — TERMINAL_FORCE_MAIN=1 (main-push allowed)\n' : ''
  const header =
    `▸ ${spec.title} · ${spec.engine}${spec.persona ? ` · as ${spec.persona}` : ''}` +
    `${spec.pipeline ? ` · ${spec.pipeline}` : ''}\n${baseLine}\n▸ worktree ${worktree}\n${forceLine}\n`
  // Resolve every step's engine+model ONCE at spawn (snapshot semantics: a
  // role-policy change mid-run never reshuffles an in-flight run). Untagged
  // steps resolve byte-identically to the pre-routing behavior.
  const routedSteps: StepRouting[] = spec.steps.map((s) =>
    resolveStepRouting({
      step: s,
      specEngine: spec.engine,
      specModel: spec.model,
      roles: readSettings().roles,
      engineDefault: engineDefaultModel,
    }),
  )
  const multiEngine = spec.steps.some((s) => s.role)
  const run: AgentRun = {
    id: randomUUID(),
    agentId: spec.id,
    agentTitle: spec.title,
    engine: spec.engine,
    persona: spec.persona,
    pipeline: spec.pipeline,
    status: 'running',
    startedAt: ts,
    repoRoot,
    worktree,
    branch,
    output: header,
    force: spec.force,
    ...(multiEngine ? { stepEngines: routedSteps.map((r) => r.engine) } : {}),
  }
  runs.set(run.id, run)
  persistMeta(run)
  appendLog(run.id, run.output)
  emit('agent:status', run)
  emitActivity(
    { kind: 'agent-run', title: `Agent started · ${spec.title}`, detail: `${spec.engine} · ${repoLabel}`, repo: repoLabel, repoRoot },
    { notify: false },
  )

  const append = (chunk: string) => {
    run.output += chunk
    if (run.output.length > OUTPUT_CAP) run.output = run.output.slice(-OUTPUT_CAP)
    appendLog(run.id, chunk)
    emit('agent:output', { runId: run.id, chunk })
  }

  let settled = false
  // Per-run wall-clock watchdog (ticket #15): armed below for non-inPlace runs.
  // `reaped` lets the exit handler distinguish a hard-cap SIGTERM from a crash.
  let watchdogTimers: ReturnType<typeof setTimeout>[] = []
  let reaped = false
  const clearWatchdog = () => {
    watchdogTimers.forEach(clearTimeout)
    watchdogTimers = []
  }
  const finalize = (status: Exclude<AgentRunStatus, 'running'>, exitCode?: number) => {
    if (settled) return
    settled = true
    clearWatchdog()
    run.status = status
    run.endedAt = Date.now()
    run.exitCode = exitCode
    // A terminal run is never gate-parked — clear the flag (and any orphaned
    // gate entry) so the Runs tab can't offer a no-op approve on a dead run.
    run.gateWaiting = false
    pendingGates.delete(run.id)
    procs.delete(run.id)
    append(formatAgentRunCompletion({ status, exitCode, startedAt: run.startedAt, endedAt: run.endedAt }))
    persistMeta(run)
    emit('agent:status', run)
    // Usage/spend recording happens PER STEP in runStep's exit handler (each
    // step is its own CLI invocation with its own engine + usage tail), not
    // here — a multi-engine task run would mis-attribute spend if the whole
    // run were keyed on one engine.
    emitActivity({
      // infra/run failures surface as 'error' (notify) so they don't hide in the
      // agent-run stream; normal completions stay 'agent-run'.
      kind: status === 'failed' || status === 'interrupted' ? 'error' : 'agent-run',
      title: `Agent ${status} · ${spec.title}`,
      detail: `${spec.engine} · ${branch}`,
      repo: repoLabel,
      repoRoot,
    })
  }

  // Engine that runs the code stage (separation-of-duties reference point).
  const codeStageIdx = spec.steps.findIndex((s) => s.role === 'code')
  const codeStageEngine = codeStageIdx >= 0 ? routedSteps[codeStageIdx].engine : undefined
  // Steps whose approveBefore gate has been HITL-approved this run.
  const approvedSteps = new Set<number>()

  let stepIdx = 0

  // Park the run at a plan gate: no child process, watchdog still armed (the
  // soft cap will nag a forgotten gate; the hard cap interrupts it cleanly).
  const parkAtGate = (step: Step) => {
    run.gateWaiting = true
    persistMeta(run)
    append(
      `\n[plan gate] awaiting approval before the ${step.label} stage — resolve the HITL item to continue, or cancel the run\n`,
    )
    emit('agent:status', run)
    const hitlId = fileHitl({
      source: 'agent',
      title: `Plan approval · ${spec.title}`,
      action: `review ${join(worktree, '.terminal', 'plan.md')} and resolve this item to start the ${step.label} stage`,
      detail: `task run ${run.id.slice(0, 8)} · resolving starts ${step.label} on ${routedSteps[stepIdx].engine}`,
      repo: basename(repoRoot),
      repoRoot,
      runId: run.id,
      runSource: 'agent',
    }).id
    const gateStepIdx = stepIdx
    // Both hooks delete the gate FIRST, then resolve the HITL item — so the
    // onHitlResolve listener's resumeGate() re-entry finds no gate and no-ops.
    pendingGates.set(run.id, {
      hitlId,
      resume: () => {
        pendingGates.delete(run.id)
        resolveHitl(hitlId) // Runs-tab approval must not leave a stale inbox item
        approvedSteps.add(gateStepIdx)
        run.gateWaiting = false
        persistMeta(run)
        append(`\n[plan gate] approved — starting ${step.label}\n`)
        emit('agent:status', run)
        runStep()
      },
      cancel: () => {
        pendingGates.delete(run.id)
        resolveHitl(hitlId) // moot once the run is canceled
        run.gateWaiting = false
        finalize('canceled')
      },
    })
  }

  const runStep = () => {
    // Stage-boundary gates: skip stages whose run conditions fail (separation
    // of duties / budget recheck / heavy-diff condition) — visibly in the run
    // log, never silently.
    while (stepIdx < spec.steps.length) {
      const s = spec.steps[stepIdx]
      const verdict = stageSkipReason(s, {
        stepEngine: routedSteps[stepIdx].engine,
        codeEngine: codeStageEngine,
        numstat: () => {
          try {
            return execFileSync(
              'git',
              ['-C', worktree, 'diff', '--numstat', `${defaultBase(repoRoot)}...HEAD`],
              { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
            )
          } catch {
            return null
          }
        },
        budgetGate:
          s.role === 'verify'
            ? () => {
                try {
                  const { gateSpawn } = require('./budgets') as typeof import('./budgets')
                  return gateSpawn('task')
                } catch {
                  return { decision: 'allow', reason: '' }
                }
              }
            : undefined,
      })
      if ('skip' in verdict) {
        append(`\n━━ step ${stepIdx + 1}/${spec.steps.length} · ${s.label} — skipped: ${verdict.skip} ━━\n`)
        stepIdx++
        continue
      }
      if (verdict.note) append(`\n[${s.label}] ${verdict.note}\n`)
      break
    }
    if (stepIdx >= spec.steps.length) return finalize('done', 0)
    const step = spec.steps[stepIdx]
    const routed = routedSteps[stepIdx]
    // Plan gate: park for HITL approval before this step spends money.
    if (step.approveBefore && !approvedSteps.has(stepIdx)) return parkAtGate(step)
    if (spec.steps.length > 1) {
      // Role-tagged steps surface their engine in the marker so the Runs tab's
      // live tail shows which model family is driving each stage.
      const engineTag = step.role ? ` · ${routed.engine}` : ''
      append(`\n━━ step ${stepIdx + 1}/${spec.steps.length} · ${step.label}${engineTag} ━━\n\n`)
    }
    // Script-first: if .agents/<id>.sh (or global ~/.config/TerMinal/scripts/<id>.sh)
    // exists, exec it directly with env vars instead of building a claude/codex
    // command from the prompt. Inside the script the operator can mix
    // deterministic shell with `claude -p` / `codex exec` however they want.
    const scriptPath = locateScript(repoRoot, spec.id)
    // Engine + model were resolved per step at spawn time (routedSteps): for
    // untagged steps this is exactly the old chain (explicit spec override >
    // per-engine Settings default > nothing); role-tagged steps route via
    // Settings.roles. The same value flows into both TERMINAL_MODEL (visible
    // to scripts) and the buildCmd fallback for prompt-style agents — so a
    // script's `--model "${TERMINAL_MODEL:-sonnet}"` pattern sees the user's
    // Settings default.
    const effectiveModel = routed.model
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Inject TerMinal's bin dir so scripts can call `terminal-cli ...`.
      PATH: `${TERMINAL_BIN_DIR}:${process.env.PATH || ''}`,
      TERMINAL_REPO: repoRoot,
      TERMINAL_RUN_ID: run.id,
      TERMINAL_RUN_SOURCE: 'agent',
      TERMINAL_AGENT_ID: spec.id,
      TERMINAL_BRANCH: branch,
      TERMINAL_WORKTREE: worktree,
      TERMINAL_ENGINE: routed.engine,
      ...(effectiveModel ? { TERMINAL_MODEL: effectiveModel } : {}),
      // FORCE-MODE: passes the block-main-merge hook's env-var carve-out.
      // Only set when the agent has `force: true`; never inherited from the
      // parent process (a normal launch of TerMinal never has this var set).
      ...(spec.force ? { TERMINAL_FORCE_MAIN: '1' } : {}),
    }
    // For prompt-style (non-script) agents, prepend (1) the FORCE preamble for
    // force-mode so the spawned model knows it has main-push authority, and
    // (2) a short "prior gotchas" block from docs/learnings/ so accumulated
    // learnings push INTO the agent at spawn (#24). Script-first agents read
    // the env var + their own context directly, so they get neither.
    let promptForStep = step.prompt
    if (!scriptPath) {
      const lead = (spec.force ? FORCE_PREAMBLE : '') + learningsPreambleFor(repoRoot)
      promptForStep = lead + promptForStep
    }
    const cmd = scriptPath
      ? shq(scriptPath)
      : buildCmd(routed.engine, worktree, promptForStep, effectiveModel || undefined)
    // Wrap the spawn in `script -q /dev/null` so claude/codex think they're on
    // a TTY and stream output as it's generated. Without this, `claude -p`
    // buffers everything until exit and the run log shows nothing mid-run
    // (the same fix shipped to bin/terminal-cron). Pipes still carry the
    // streamed bytes back to Node for live render via agents:output IPC.
    const p = spawn('script', ['-q', '/dev/null', LOGIN_SHELL, '-l', '-c', cmd], {
      cwd: worktree,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    procs.set(run.id, p)
    // cursor + prompt-style claude emit NDJSON (--output-format stream-json);
    // decode it back to plain text + progress breadcrumbs, one decoder per
    // spawned process. A new step = a new process = a fresh stream, so the
    // decoder is per-step — keyed on the STEP's resolved engine (a cursor code
    // stage followed by a codex review stage must not share a decoder, or the
    // live log garbles). Script-first agents (scriptPath) emit their own
    // plain text — never decode those, or non-JSON lines would be swallowed.
    // codex streams human-readable text through the PTY and needs no decoder.
    const decoderKind = pickStreamDecoder(routed.engine, !!scriptPath)
    const decode =
      decoderKind === 'cursor'
        ? createCursorStreamDecoder()
        : decoderKind === 'claude'
          ? createClaudeStreamDecoder()
          : null
    // Per-step output capture for the spend ledger: the decoded text for the
    // claude/codex tail parsers, plus the RAW stream for cursor — cursor's
    // usage lives in the terminal `result` NDJSON event, which the display
    // decoder deliberately drops.
    const stepStartedAt = Date.now()
    let stepText = ''
    let stepRaw = ''
    const cap = (s: string) => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s)
    p.stdout?.on('data', (d: Buffer) => {
      const raw = d.toString()
      stepRaw = cap(stepRaw + raw)
      const text = decode ? decode(raw) : raw
      if (text) {
        stepText = cap(stepText + text)
        append(text)
      }
    })
    p.stderr?.on('data', (d: Buffer) => {
      const raw = d.toString()
      stepText = cap(stepText + raw)
      append(raw)
    })
    // Record this step's usage in the AIRun ledger, keyed on the STEP's
    // resolved engine — a multi-engine run records one entry per stage so
    // spend attribution stays honest. Best-effort — silent on miss.
    const recordStepLedger = (code: number | null) => {
      try {
        // Lazy-require to keep agents.ts decoupled from the observability layer.
        const { recordRunnerInvocation } = require('./ai-collectors') as typeof import('./ai-collectors')
        recordRunnerInvocation({
          source:
            routed.engine === 'codex'
              ? 'codex-exec'
              : routed.engine === 'cursor'
                ? 'cursor-agent'
                : 'claude-p',
          output: routed.engine === 'cursor' ? stepRaw : stepText,
          repoRoot,
          runId: run.id,
          agentId: spec.id,
          startedAt: stepStartedAt,
          endedAt: Date.now(),
          exitCode: code ?? -1,
          modelHint: effectiveModel || undefined,
        })
      } catch {
        /* observability is non-critical; never block run completion */
      }
    }
    p.on('error', (err) => {
      append(`\n[spawn error] ${err.message}\n`)
      finalize('failed')
    })
    p.on('exit', (code) => {
      recordStepLedger(code)
      if (run.status === 'canceled') return finalize('canceled', code ?? undefined)
      if (reaped) return finalize('interrupted', code ?? undefined) // hard-cap SIGTERM, not a crash
      if (code !== 0) return finalize('failed', code ?? undefined)
      stepIdx++
      if (stepIdx < spec.steps.length) runStep()
      else finalize('done', 0)
    })
  }

  // Arm the wall-clock watchdog for the whole run (ticket #15). inPlace runs are
  // quick additive ops (ticket filing) — never capped. Caps come from Settings;
  // default is warn-only (soft 3h, hard off). Timers fire relative to run start
  // and are cleared in finalize(), so a healthy run never trips them.
  if (!spec.inPlace) {
    const { maxRunMs, maxRunHardMs } = readSettings()
    const mins = (ms: number) => Math.round(ms / 60000)
    for (const t of planWatchdogTimers(maxRunMs, maxRunHardMs)) {
      watchdogTimers.push(
        setTimeout(() => {
          if (settled) return
          if (t.action === 'warn') {
            append(`\n[runtime cap] still running after ${mins(t.atMs)}m (soft cap) — left running; inspect or cancel.\n`)
            emitActivity({
              kind: 'error',
              title: `Agent runtime soft cap · ${spec.title}`,
              detail: `${spec.engine} · ${branch} · >${mins(t.atMs)}m`,
              repo: repoLabel,
              repoRoot,
            })
            fileHitl({
              source: 'agent',
              title: `Long-running agent · ${spec.title}`,
              action: 'inspect the run; cancel it if it is stuck, or raise maxRunMs if this is expected',
              detail: `run ${run.id.slice(0, 8)} on ${branch} exceeded the ${mins(t.atMs)}m soft cap and is still running`,
              repo: basename(repoRoot),
              repoRoot,
            })
          } else {
            emitActivity({
              kind: 'error',
              title: `Agent reaped at hard cap · ${spec.title}`,
              detail: `${spec.engine} · ${branch} · >${mins(t.atMs)}m`,
              repo: repoLabel,
              repoRoot,
            })
            // A run parked at a plan gate has no child process to SIGTERM —
            // interrupt it directly instead of arming `reaped` for a process
            // that will never exit, and retire its approval HITL item.
            const gate = pendingGates.get(run.id)
            if (gate) {
              pendingGates.delete(run.id)
              resolveHitl(gate.hitlId)
              append(`\n[runtime cap] hard cap of ${mins(t.atMs)}m exceeded while awaiting plan approval — interrupting\n`)
              finalize('interrupted')
              return
            }
            reaped = true
            append(`\n[runtime cap] hard cap of ${mins(t.atMs)}m exceeded — sending SIGTERM (worktree + commits preserved)\n`)
            procs.get(run.id)?.kill('SIGTERM')
          }
        }, Math.min(t.atMs, 2_147_483_647)), // clamp: a >24.8d delay overflows setTimeout and fires immediately
      )
    }
  }

  runStep()
  return run
}

export function runAgent(
  repoRoot: string,
  agentId: string,
  engine?: Engine,
  personaId?: string,
  pipelineId?: string,
  model?: string,
): AgentRun | { error: string } {
  const agent = readAgents(repoRoot).find((a) => a.id === agentId)
  if (!agent) return { error: 'unknown agent' }
  const { steps, persona, pipeline } = buildSteps(
    repoRoot,
    { label: agent.title, prompt: agent.prompt },
    personaId,
    pipelineId,
  )
  return runSpec(repoRoot, {
    id: agent.id,
    title: agent.title,
    steps,
    engine: engine || agent.engine || 'codex',
    persona,
    pipeline,
    inPlace: agent.inPlace,
    force: agent.force,
    model: model ?? agent.model,
  })
}

/** Probe an engine binary through the same login shell the runner spawns
 *  with — so PATH additions from ~/.zshrc count, exactly as they will at
 *  spawn time. */
function engineAvailable(engine: Engine): boolean {
  try {
    execFileSync(LOGIN_SHELL, ['-l', '-c', `command -v ${shq(enginePath(engine))}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** Task-first entry: a freeform prompt becomes a role-routed pipeline run —
 *  plan(opus) → code(cursor) → review(codex) → verify(opus, heavy only) — in
 *  ONE worktree, visible in the Runs tab like any other run. No agent, no
 *  engine picking, no terminal session: the Settings.roles table decides who
 *  runs each stage. Concurrency: the runSpec duplicate guard (agentId 'task'
 *  + repo) refuses a second simultaneous task in the same repo. */
export function runTask(repoRoot: string, text: string): AgentRun | { error: string } {
  const t = text.trim()
  if (!t) return { error: 'empty task' }
  const s = readSettings()
  const steps = composeTaskSteps(t, s.taskFlow)
  // Preflight: every engine the role table routes to must exist BEFORE we
  // create a worktree or spend anything — a missing cursor-agent should fail
  // the task in the composer, not three stages in.
  const engines = [
    ...new Set(
      steps.map(
        (st) =>
          resolveStepRouting({
            step: st,
            specEngine: s.defaultEngine,
            roles: s.roles,
            engineDefault: engineDefaultModel,
          }).engine,
      ),
    ),
  ]
  for (const e of engines) {
    if (!engineAvailable(e)) {
      return {
        error: `the ${e} engine (${engineBinaryName(e)}) is not on PATH — install it or change Settings → Role routing`,
      }
    }
  }
  // Budget gate at task start (re-checked at the verify boundary — a long
  // task can cross the daily cap mid-run).
  try {
    const { gateSpawn } = require('./budgets') as typeof import('./budgets')
    const g = gateSpawn('task')
    if (g.decision === 'refuse') {
      return { error: `budget gate refused: ${g.reason}. Set /budget override or raise the cap.` }
    }
  } catch {
    /* budget module unavailable — allow */
  }
  const norm = t.replace(/\s+/g, ' ')
  const title = norm.length > 64 ? `${norm.slice(0, 63)}…` : norm
  return runSpec(repoRoot, {
    id: 'task',
    title,
    steps,
    // Display + untagged-step fallback only — every task step carries a role,
    // so routing comes from Settings.roles (snapshot at spawn).
    engine: roleRouting('code').engine,
    pipeline: TASK_PIPELINE_LABEL,
  })
}

/** Spawn a claude/codex run that designs a new agent from a natural-language
 *  description and saves it into the active scope (the active repo's
 *  .agents/agents.json, or the global registry). Runs inPlace — no fresh
 *  worktree, no PR — because designing an agent is a quick read+write op. */
export function runDesignerSpawn(
  repoRoot: string,
  text: string,
  engine: Engine,
  scope: 'repo' | 'global',
  model?: string,
): AgentRun | { error: string } {
  const t = text.trim()
  if (!t) return { error: 'empty request' }
  const targetDir =
    scope === 'global'
      ? join(homedir(), '.config', 'TerMinal', 'scripts')
      : join(repoRoot, '.agents')
  const scopeLabel =
    scope === 'global'
      ? "TerMinal's GLOBAL script registry (~/.config/TerMinal/scripts/)"
      : `this repo's .agents/ directory`
  const prompt = `You are designing a new TerMinal agent as an EXECUTABLE BASH SCRIPT plus a small sidecar metadata JSON, per the scripts unification (see .agents/scripts.md).

Target: ${scopeLabel}
Two files to write (mkdir -p the parent dir if needed):
  ${targetDir}/<id>.sh    # the executable body — chmod 755 after writing
  ${targetDir}/<id>.json  # sidecar metadata, validated by TerMinal

Pick a kebab-case <id> from the user's description.

The sidecar JSON shape (every field optional except id + title):
  {
    "id":          "kebab-case",
    "title":       "short user-facing label (e.g. 'Audit security')",
    "description": "one-line summary",
    "icon":        "lucide-react icon name — Bot, BookText, ScanSearch, ListChecks, TestTube2, ShieldAlert, Gauge, PackageCheck, Eraser, Wrench, Activity, Zap, etc.",
    "opensPr":     true | false,
    "engine":      "claude" | "codex" | "cursor"  (hint; runtime can override),
    "model":       "haiku" | "sonnet" | "opus" | "gpt-5" | "gpt-5-codex" | "o4-mini" | "composer-2.5"  (hint; optional),
    "inPlace":     true | false  (true ONLY if the agent manages worktrees itself — rare)
  }

The script body MUST follow this shape:
  - First line: #!/usr/bin/env bash
  - Use 'set -uo pipefail' (NOT -e — you want to inspect exit codes).
  - Read these env vars the runner provides:
      TERMINAL_REPO      — the repo root
      TERMINAL_RUN_ID    — uuid of this run
      TERMINAL_AGENT_ID  — id of this agent (used as the state key)
      TERMINAL_BRANCH    — worktree branch (or "main" if inPlace)
      TERMINAL_WORKTREE  — worktree path (== TERMINAL_REPO if inPlace)
      TERMINAL_ENGINE    — hint from sidecar / schedule override (default fallback when calling claude/codex)
      TERMINAL_MODEL     — hint from sidecar / schedule override
  - For LLM calls inside the script:
      claude -p "<prompt>" --dangerously-skip-permissions --model "\${TERMINAL_MODEL:-sonnet}"
      codex exec -s danger-full-access -C "\${TERMINAL_WORKTREE}" --model "\${TERMINAL_MODEL:-gpt-5}" "<prompt>"
      cursor-agent -p "<prompt>" --force --workspace "\${TERMINAL_WORKTREE}" --model "\${TERMINAL_MODEL:-composer-2.5}"
  - For TerMinal helpers, use these (on PATH via ~/.config/TerMinal/bin/terminal-cli):
      terminal-cli ticket "<title>" "<body>"   # file a backlog ticket on TERMINAL_REPO
      terminal-cli hitl "<title>" "<action>"   # file a global HITL item + Telegram ping
      terminal-cli activity <kind> "<title>" "<detail>"   # emit one activity-feed event
      terminal-cli notify "<message>"          # raw Telegram message
      terminal-cli state get-sha               # last main/master sha this agent scanned ("" if first run)
      terminal-cli state mark-main             # fetch + record origin/main tip as lastScannedSha
      terminal-cli state get|set <key> [value] # arbitrary per-(repo, agent) key/value persistence
  - INCREMENTAL-SCAN PATTERN (use when the agent re-runs on a cadence and only cares about new commits):
      last=\\$(terminal-cli state get-sha)
      range="\${last:-HEAD~50}..HEAD"
      changes=\\$(git -C "\$TERMINAL_REPO" log --oneline "\$range" -- src/)
      [ -z "\$changes" ] && { echo "no new commits"; exit 0; }
      ... do the work ...
      terminal-cli state mark-main     # record where we scanned through

THE BODY MUST FOLLOW THE PROJECT'S WORKFLOW:
  - The ticket + MR workflow uniformly. The MERGE TO MAIN IS HUMAN-ONLY — never \`gh pr merge\` / \`--auto\` / \`--merge\`.
  - File backlog tickets via \`terminal-cli ticket\` for findings the script cannot fix in-pass.
  - Open a PR only when there are concrete changes. If the diff is ONLY docs/markdown/tickets/reports, apply the \`auto-mergeable\` label per .agents/forge.md.
  - Explicit success criteria (what makes the run "done"). \`exit 0\` on success; non-zero on failure.
  - HITL only for true blockers (decisions, credentials, hard blockers) via \`terminal-cli hitl\`.

CONVENTIONS TO READ BEFORE WRITING THE SCRIPT:
  1. CLAUDE.md (root) — project conventions and global rules.
  2. .agents/scripts.md — the design + helper reference.
  3. .agents/forge.md — auto-mergeable label + forge command mapping.
  4. Existing example: .agents/health.sh — the cheap-precheck-then-LLM pattern.
  5. backlog/EXAMPLE.md or .claude/skills/ticket/EXAMPLE.md — ticket schema (incl. depends_on).
  6. Existing scripts in the target dir — don't duplicate ids; pick a distinct kebab-case id.

User's description:
> ${t}

PROCESS:
  1. Read the conventions above (enough to write a faithful script).
  2. Pick the kebab-case id + title + icon + opensPr based on the description.
  3. Decide whether this agent benefits from a deterministic precheck (a "cheap-then-escalate" pattern saves tokens). If yes, write the precheck FIRST in the script.
  4. Author the bash body. Keep it small + readable; prefer terminal-cli over hand-rolled JSON manipulation.
  5. Write \`${targetDir}/<id>.sh\` with the script body. \`chmod 755\` it.
  6. Write \`${targetDir}/<id>.json\` with the sidecar metadata.
  7. Confirm by printing the absolute paths of both files and the sidecar JSON contents.

DO NOT open a PR, do not modify any existing agents, do not invent extra files.`
  return runSpec(repoRoot, {
    id: `design-${scope}`,
    title: `Design agent · ${t.slice(0, 48)}`,
    steps: [{ label: 'design agent', prompt }],
    engine,
    inPlace: true,
    model,
  })
}

export { saveGlobalAgent }

// Convert an existing agent (prompt-style, in agents.json) into the new
// script-first shape: writes <id>.sh (chmod 755) + <id>.json sidecar next to
// the matching directory. Non-destructive — agents.json keeps the entry, the
// runtime just branches to the .sh from now on. The user can clean
// agents.json later, or never.
export function convertAgentToScript(
  repoRoot: string,
  agentId: string,
): { ok: true; scriptPath: string; sidecarPath: string } | { error: string } {
  const agent = readAgents(repoRoot).find((a) => a.id === agentId)
  if (!agent) return { error: 'unknown agent' }
  // Default agents (shipped with the app) and globals get materialized in the
  // global scripts dir; repo-source agents in this repo's .agents/.
  const dir =
    agent.source === 'repo' || agent.source === 'override'
      ? join(repoRoot, '.agents')
      : join(homedir(), '.config', 'TerMinal', 'scripts')
  const scriptPath = join(dir, `${agentId}.sh`)
  const sidecarPath = join(dir, `${agentId}.json`)
  if (existsSync(scriptPath)) {
    return { error: `script already exists at ${scriptPath}` }
  }
  const engine = agent.engine || 'claude'
  const promptLit = JSON.stringify(agent.prompt).replace(/\\\\/g, '\\') // keep prompt readable
  // The auto-generated body is a thin shim. Anyone can replace the body later
  // to add prechecks, conditional escalation, helpers, etc.
  const cmd =
    engine === 'claude'
      ? `claude -p ${promptLit} --dangerously-skip-permissions \${TERMINAL_MODEL:+--model "$TERMINAL_MODEL"}`
      : engine === 'cursor'
        ? `cursor-agent -p ${promptLit} --force --workspace "$TERMINAL_WORKTREE" \${TERMINAL_MODEL:+--model "$TERMINAL_MODEL"}`
        : `codex exec -s danger-full-access -C "$TERMINAL_WORKTREE" \${TERMINAL_MODEL:+--model "$TERMINAL_MODEL"} ${promptLit}`
  const script = `#!/usr/bin/env bash
# Auto-generated from agents.json by TerMinal's "Convert to script" action.
# Edit freely. The runner picks up this .sh over the agents.json prompt entry.
# Env vars provided: TERMINAL_REPO, TERMINAL_RUN_ID, TERMINAL_AGENT_ID,
# TERMINAL_BRANCH, TERMINAL_WORKTREE, TERMINAL_ENGINE, TERMINAL_MODEL.
# Helpers on PATH: terminal-cli ticket / hitl / activity / notify / state.

set -uo pipefail

exec ${cmd}
`
  const sidecar = {
    id: agent.id,
    title: agent.title,
    description: agent.description,
    icon: agent.icon,
    opensPr: agent.opensPr,
    engine: agent.engine,
    model: agent.model,
    inPlace: agent.inPlace,
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(scriptPath, script)
    chmodSync(scriptPath, 0o755)
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n')
    return { ok: true, scriptPath, sidecarPath }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Spawn a claude/codex run that designs a new schedule entry from a natural-
 *  language description. Reads the active agent list + existing schedules,
 *  appends a new entry to ~/.config/TerMinal/schedules.json. After the run
 *  completes the renderer reconciles + relaunches the LaunchAgent. */
export function runScheduleDesignerSpawn(
  repoRoot: string,
  text: string,
  engine: Engine,
): AgentRun | { error: string } {
  const t = text.trim()
  if (!t) return { error: 'empty request' }
  const schedulesFile = join(homedir(), '.config', 'TerMinal', 'schedules.json')
  const agents = readAgents(repoRoot)
  const agentSummary = agents.length
    ? agents
        .map(
          (a) =>
            `  - id: ${a.id} · title: ${a.title}${a.description ? ` · ${a.description}` : ''} · default-engine: ${a.engine || 'claude'} · opensPr: ${!!a.opensPr}`,
        )
        .join('\n')
    : '  (none — the user should create an agent first via the Agents tab)'
  const prompt = `You are designing a new TerMinal scheduled run based on the user's natural-language description.

Available agents (use one of these IDS verbatim — do NOT invent a new one):

${agentSummary}

Target file: ${schedulesFile}
  - If it does not exist, treat as an empty JSON array.
  - If it exists, parse the JSON array, append the new entry, write back with 2-space indent.

Schedule entry schema:
{
  "id": "<uuid v4>",
  "repoRoot": "${repoRoot}",
  "repoLabel": "<basename of repoRoot, or the GitHub/GitLab owner/repo if obvious>",
  "agentId": "<one of the ids above>",
  "agentTitle": "<the matching agent's title>",
  "engine": "claude" | "codex",
  "prompt": "<copy the matching agent's prompt verbatim>",
  "spec": <a ScheduleSpec — see below>,
  "enabled": true,
  "createdAt": <epoch ms — use \`date +%s%3N\` or current ms>,
  "lastStatus": "never"
}

ScheduleSpec options:
  { "kind": "interval", "everyMinutes": <number> }                              # every N minutes
  { "kind": "calendar", "minute": 0, "hour": 9 }                                # every day at 9:00
  { "kind": "calendar", "minute": 30, "hour": 14, "weekdays": [1,3,5] }         # Mon/Wed/Fri 2:30pm
  { "kind": "cron",     "expr": "30 9 * * 1-5" }                                # raw 5-field cron

User's description:
> ${t}

PROCESS:
  1. Parse the user's description to extract (a) which agent and (b) the cadence.
  2. Match the agent by id from the list above. If no clear match, pick the closest reasonable one and NOTE that in your final summary so the user can adjust.
  3. Generate a UUID v4 (uuidgen on macOS, or a /dev/urandom hex if not).
  4. Read the existing ${schedulesFile} JSON array (or start with []).
  5. Append the new entry. Write back with 2-space indent.
  6. Print the new entry as JSON so the user can verify; mention the inferred cadence + agent in plain English ("Every Monday at 9am, run docs.").

DO NOT open a PR. DO NOT modify the repo. Only write to ${schedulesFile}.

After this completes the app reconciles schedules automatically — your new entry becomes a real LaunchAgent the next time it loads.`
  return runSpec(repoRoot, {
    id: 'design-schedule',
    title: `Design schedule · ${t.slice(0, 48)}`,
    steps: [{ label: 'design schedule', prompt }],
    engine,
    inPlace: true,
  })
}

/** Turn a backlog ticket into an implementation run that opens a PR. */
export function runTicketAgent(
  repoRoot: string,
  ticket: { id: number; title: string; body: string },
  engine: Engine,
  personaId?: string,
  pipelineId?: string,
  model?: string,
): AgentRun | { error: string } {
  const base = `Implement backlog ticket #${ticket.id}: ${ticket.title}\n\n${ticket.body}\n\nWork in this worktree on its branch. Implement the ticket end to end — keep changes surgical and add/adjust tests. Commit your work and open a PR that references ticket #${ticket.id}. If fully delivered set the ticket status to closed (else in-progress) and link the PR in its prs: field. End with a short summary of what changed and the PR URL.`
  const { steps, persona, pipeline } = buildSteps(repoRoot, { label: `implement #${ticket.id}`, prompt: base }, personaId, pipelineId)
  return runSpec(repoRoot, { id: `ticket-${ticket.id}`, title: `Implement #${ticket.id}`, steps, engine, persona, pipeline, model })
}

/** Spawn an agent that files ONE backlog ticket from a freeform request. Runs
 *  in-place (no worktree) so the ticket lands in the real backlog/ immediately. */
export function runTicketSpawn(
  repoRoot: string,
  text: string,
  engine: Engine,
  model?: string,
): AgentRun | { error: string } {
  const t = text.trim()
  if (!t) return { error: 'empty request' }
  const prompt = `File exactly ONE new backlog ticket for the request below, using this project's ticket conventions: allocate the next id (use .claude/skills/ticket/bin/next-ticket-id if present, else the next NNNN above the highest in backlog/), write backlog/NNNN-slug.md with valid YAML frontmatter (id, title, status: open, priority, type, horizon: now) matching backlog/EXAMPLE.md, put any detail in the body after the closing ---, and commit it. Do NOT implement anything or open a PR — just file the ticket. Request: ${t}`
  return runSpec(repoRoot, {
    id: 'ticket-spawn',
    title: `File ticket · ${t.slice(0, 48)}`,
    steps: [{ label: 'file ticket', prompt }],
    engine,
    inPlace: true,
    model,
  })
}

/** Start the /factory orchestrator as an in-place run — drives the backlog to
 *  merge-ready PRs (stacked-mr passes, gated by review), never merging to main. */
export function runFactorySpawn(repoRoot: string, engine: Engine): AgentRun | { error: string } {
  if (!repoRoot) return { error: 'not a git repo' }
  const prompt = `Run the /factory orchestrator for THIS repository, following the project's /factory skill exactly. Continuously turn the backlog into REVIEWED, merge-ready PRs: reconcile with /merge-sync, then run /stacked-mr passes (build a stack TDD-first → batch-review to the bar → handle verdicts), repeating until the in-scope backlog is dry. NEVER merge to main/master — the human merges. Park any TRUE human-need (decision, approval, creds, hard blocker) to the global HITL inbox with .claude/bin/hitl. Emit an activity event at each checkpoint. Do not invent scope. End with the stack summary for the human to merge.`
  return runSpec(repoRoot, {
    id: 'factory',
    title: 'Factory',
    steps: [{ label: 'factory loop', prompt }],
    engine,
    inPlace: true,
  })
}

export type PrAgentKind = 'review' | 'iterate'

/** Spin an agent out ON an open MR: checks out the MR head, reviews/iterates,
 *  and pushes back to the source branch to update it. */
export function runPrAgent(
  repoRoot: string,
  pr: { iid: number; sourceBranch: string; title?: string; webUrl?: string },
  kind: PrAgentKind,
  engine: Engine,
  personaId?: string,
  pipelineId?: string,
  model?: string,
): AgentRun | { error: string } {
  if (!pr?.sourceBranch) return { error: 'PR/MR has no source branch' }
  const f = forgeFor(repoRoot)
  const tag = `${f.label} ${f.sym}${pr.iid}` // e.g. "PR #12" / "MR !12"
  const noteCmd =
    f.kind === 'github' ? `gh pr comment ${pr.iid} -b …` : `glab mr note ${pr.iid} -m …`
  const ref = pr.webUrl || `${f.sym}${pr.iid}`
  const ctx = `This worktree is checked out at the head of ${tag} (${ref}${pr.title ? ` — "${pr.title}"` : ''}) on branch "${pr.sourceBranch}". After committing, push back to the ${f.label} with \`git push origin HEAD:${pr.sourceBranch}\`.`
  const base: Step =
    kind === 'review'
      ? {
          label: `review ${f.sym}${pr.iid}`,
          prompt: `Do a thorough senior code review of ${tag}. ${ctx} Inspect \`git diff\` against the target branch and \`git log\`. Evaluate correctness, security, architecture, conformance, quality, and dependencies. Post your review on the ${f.label} (\`${noteCmd}\`). Where you find clear, safe fixes, apply them with tests, commit, and push. End with a concise verdict and the list of findings.`,
        }
      : {
          label: `iterate ${f.sym}${pr.iid}`,
          prompt: `Iterate on ${tag} until it is merge-ready. ${ctx} Address open review findings and TODOs, make the test suite and build pass, and tighten edge cases — keep changes surgical. Commit and push your work. End with the final status (tests/build green?) and a short summary of what changed.`,
        }
  const { steps, persona, pipeline } = buildSteps(repoRoot, base, personaId, pipelineId)
  return runSpec(repoRoot, {
    id: `pr-${kind}-${pr.iid}`,
    title: `${kind === 'review' ? 'Review' : 'Iterate'} ${f.sym}${pr.iid}`,
    steps,
    engine,
    persona,
    pipeline,
    prRef: { iid: pr.iid, sourceBranch: pr.sourceBranch },
    model,
  })
}

export function cancelRun(runId: string): boolean {
  const run = runs.get(runId)
  const p = procs.get(runId)
  const gate = pendingGates.get(runId)
  if (run && run.status === 'running') {
    run.status = 'canceled'
    persistMeta(run)
  }
  if (gate) {
    // Parked at a plan gate — no child process; finalize directly.
    gate.cancel()
    return true
  }
  p?.kill('SIGTERM')
  return !!p
}

/** Continue a run parked at a plan-approval gate (HITL resolve / Runs tab). */
export function resumeGate(runId: string): boolean {
  const gate = pendingGates.get(runId)
  if (!gate) return false
  gate.resume()
  return true
}

/** Remove a finished run's worktree (the branch/commits/PR remain). */
export function removeWorktree(runId: string): boolean {
  const run = runs.get(runId)
  if (!run || run.status === 'running') return false
  if (run.worktree === run.repoRoot) return false // in-place run — never remove the repo
  try {
    execFileSync('git', ['-C', run.repoRoot, 'worktree', 'remove', run.worktree, '--force'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

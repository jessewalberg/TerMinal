// AIRun ledger — per-run cost/token records. Separate from cron-runs/ (which
// is operational: status, log, exit code). Joined by runId when both exist.
// Sources: 'claude-code' (interactive Claude sessions, derived from
// ~/.claude/projects transcripts), 'codex-cli' (interactive Codex sessions),
// 'claude-p' (cron / in-process claude -p invocations), 'codex-exec' (cron /
// in-process codex exec invocations), 'cursor-agent' (cron / in-process
// cursor-agent stream-json invocations).
//
// Billable vs. subscription is implicit, not a flag: cost = costOf(model,...),
// and subscription-CLI models (Composer, etc.) aren't in ai-pricing's table, so
// their cost rows are $0 while tokens are still tracked. cursor-agent joins
// claude-code / codex-cli on that same non-billable footing.
//
// Storage:
//   ~/.config/TerMinal/ai-runs/<id>.json     per-run record
//   ~/.config/TerMinal/ai-stats/<YYYY-MM-DD>.json   daily roll-ups (cached)
//
// JSONL/JSON not SQLite — greppable, no migrations.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { costOf, lookupPrice } from './ai-pricing'

const DIR = join(homedir(), '.config', 'TerMinal', 'ai-runs')
const STATS_DIR = join(homedir(), '.config', 'TerMinal', 'ai-stats')

export type AIRunSource = 'claude-code' | 'codex-cli' | 'claude-p' | 'codex-exec' | 'cursor-agent'

export type AIRun = {
  id: string
  source: AIRunSource
  startedAt: number
  endedAt?: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd: number
  repoRoot: string
  /** Claude/Codex transcript id when applicable */
  sessionId?: string
  /** TerMinal cron/agent run id when applicable */
  runId?: string
  agentId?: string
  durationMs?: number
  exitCode?: number
  outcome?: 'pr-opened' | 'ticket-filed' | 'merged' | 'none'
}

function ensureDir(d: string): void {
  try {
    mkdirSync(d, { recursive: true })
  } catch {
    /* best effort */
  }
}

/** Write/update an AIRun record. Idempotent on `id`. */
export function writeAIRun(run: AIRun): void {
  ensureDir(DIR)
  const path = join(DIR, `${run.id}.json`)
  try {
    writeFileSync(path, JSON.stringify(run, null, 2))
  } catch {
    /* best effort */
  }
}

/** Create + persist a new AIRun. Cost is computed from model + tokens if not
 *  supplied. Returns the persisted record. */
export function recordAIRun(input: Omit<AIRun, 'id' | 'costUsd'> & Partial<Pick<AIRun, 'id' | 'costUsd'>>): AIRun {
  const id = input.id || randomUUID()
  const costUsd =
    input.costUsd ??
    costOf(input.model, {
      input: input.inputTokens,
      output: input.outputTokens,
      cacheRead: input.cacheReadTokens,
      cacheWrite: input.cacheWriteTokens,
    })
  const run: AIRun = { ...input, id, costUsd }
  writeAIRun(run)
  return run
}

/** Read every AIRun on disk (capped). Newest first. */
export function listAIRuns(limit = 500): AIRun[] {
  if (!existsSync(DIR)) return []
  const out: AIRun[] = []
  let files: string[] = []
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as AIRun
      out.push(r)
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, limit)
}

// ---- aggregate views ------------------------------------------------------

export type SpendSummary = {
  totalUsd: number
  totalRuns: number
  byModel: Record<string, { runs: number; usd: number; inputTokens: number; outputTokens: number }>
  bySource: Record<AIRunSource, { runs: number; usd: number }>
  byAgent: Record<string, { runs: number; usd: number }>
  byRepo: Record<string, { runs: number; usd: number }>
}

const emptySummary = (): SpendSummary => ({
  totalUsd: 0,
  totalRuns: 0,
  byModel: {},
  bySource: {} as SpendSummary['bySource'],
  byAgent: {},
  byRepo: {},
})

/** Sum AIRuns in a time window. From/to are inclusive ms epochs. */
export function summarize(runs: AIRun[], fromMs?: number, toMs?: number): SpendSummary {
  const summary = emptySummary()
  for (const r of runs) {
    if (fromMs && r.startedAt < fromMs) continue
    if (toMs && r.startedAt > toMs) continue
    summary.totalUsd += r.costUsd
    summary.totalRuns++
    const m = (summary.byModel[r.model] ??= { runs: 0, usd: 0, inputTokens: 0, outputTokens: 0 })
    m.runs++
    m.usd += r.costUsd
    m.inputTokens += r.inputTokens
    m.outputTokens += r.outputTokens
    const s = (summary.bySource[r.source] ??= { runs: 0, usd: 0 })
    s.runs++
    s.usd += r.costUsd
    if (r.agentId) {
      const a = (summary.byAgent[r.agentId] ??= { runs: 0, usd: 0 })
      a.runs++
      a.usd += r.costUsd
    }
    if (r.repoRoot) {
      const key = r.repoRoot.split('/').pop() || r.repoRoot
      const re = (summary.byRepo[key] ??= { runs: 0, usd: 0 })
      re.runs++
      re.usd += r.costUsd
    }
  }
  return summary
}

const dayStart = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const todayStart = (): number => dayStart(Date.now())
const weekAgo = (): number => Date.now() - 7 * 86_400_000
const monthAgo = (): number => Date.now() - 30 * 86_400_000

export type Range = 'today' | 'week' | 'month' | 'all'

export function summaryFor(range: Range): SpendSummary {
  const runs = listAIRuns(2000)
  const from =
    range === 'today' ? todayStart() : range === 'week' ? weekAgo() : range === 'month' ? monthAgo() : 0
  return summarize(runs, from)
}

/** Per-agent ROI: runs + cost + outcomes counts in a range. */
export type AgentROI = {
  agentId: string
  runs: number
  usd: number
  outcomes: { prOpened: number; ticketFiled: number; merged: number; none: number }
}

export function agentROI(range: Range): AgentROI[] {
  const runs = listAIRuns(5000)
  const from =
    range === 'today' ? todayStart() : range === 'week' ? weekAgo() : range === 'month' ? monthAgo() : 0
  const map = new Map<string, AgentROI>()
  for (const r of runs) {
    if (r.startedAt < from) continue
    if (!r.agentId) continue
    const cur = map.get(r.agentId) ?? {
      agentId: r.agentId,
      runs: 0,
      usd: 0,
      outcomes: { prOpened: 0, ticketFiled: 0, merged: 0, none: 0 },
    }
    cur.runs++
    cur.usd += r.costUsd
    if (r.outcome === 'pr-opened') cur.outcomes.prOpened++
    else if (r.outcome === 'ticket-filed') cur.outcomes.ticketFiled++
    else if (r.outcome === 'merged') cur.outcomes.merged++
    else cur.outcomes.none++
    map.set(r.agentId, cur)
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd)
}

/** Per-day cost rollup for charting (last N days). Newest day first. */
export type DailyPoint = { date: string; usd: number; runs: number; byModel: Record<string, number> }

export function dailySpend(days = 7): DailyPoint[] {
  const runs = listAIRuns(5000)
  const out: DailyPoint[] = []
  const todayMs = todayStart()
  for (let i = 0; i < days; i++) {
    const start = todayMs - i * 86_400_000
    const end = start + 86_400_000
    const dayRuns = runs.filter((r) => r.startedAt >= start && r.startedAt < end)
    const byModel: Record<string, number> = {}
    let usd = 0
    for (const r of dayRuns) {
      usd += r.costUsd
      byModel[r.model] = (byModel[r.model] || 0) + r.costUsd
    }
    out.push({ date: new Date(start).toISOString().slice(0, 10), usd, runs: dayRuns.length, byModel })
  }
  return out
}

/** Helper: convert an AIRun source + model + tokens into a fresh AIRun shape.
 *  Used by parsers in callers. */
export function makeAIRun(opts: {
  source: AIRunSource
  startedAt: number
  endedAt?: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  repoRoot: string
  sessionId?: string
  runId?: string
  agentId?: string
  durationMs?: number
  exitCode?: number
  outcome?: AIRun['outcome']
}): AIRun {
  return {
    id: randomUUID(),
    ...opts,
    costUsd: costOf(opts.model, {
      input: opts.inputTokens,
      output: opts.outputTokens,
      cacheRead: opts.cacheReadTokens,
      cacheWrite: opts.cacheWriteTokens,
    }),
  }
}

// Re-export pricing helpers so callers don't need two imports.
export { lookupPrice, costOf }

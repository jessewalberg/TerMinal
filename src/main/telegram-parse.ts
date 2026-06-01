import { PIPELINE_IDS } from './pipelines'
import type { Engine } from './agents' // type-only — erased, no electron pulled in

// Pure parsing for the two-way Telegram control surface. Kept free of electron
// and disk so it's unit-testable; telegram.ts wires these to the real actions.

export type Command = { cmd: string; args: string[] }

/** Split a message into a lowercased command + its raw args. */
export function parseCommand(text: string): Command {
  const parts = text.trim().split(/\s+/)
  return { cmd: (parts[0] || '').toLowerCase(), args: parts.slice(1) }
}

export type RunArgs = {
  agentId: string
  engine: Engine
  pipeline: string
  repoToken?: string
  personaCandidates: string[]
}

/** Classify `/run` args positionally-by-keyword: engine (codex|claude),
 *  @repo, a pipeline id, else a persona candidate. agentId is the first arg. */
export function classifyRunArgs(args: string[]): RunArgs {
  let engine: Engine = 'codex'
  let pipeline = 'single'
  let repoToken: string | undefined
  const personaCandidates: string[] = []
  for (const tok of args.slice(1)) {
    const t = tok.toLowerCase()
    if (t === 'codex' || t === 'claude') engine = t
    else if (t.startsWith('@')) repoToken = tok
    else if (PIPELINE_IDS.has(t)) pipeline = t
    else personaCandidates.push(tok)
  }
  return { agentId: args[0] || '', engine, pipeline, repoToken, personaCandidates }
}

export type MrsFilter = 'all' | 'high' | 'medium' | 'unscored'

export type MrsArgs = {
  repoToken?: string
  riskFilter: MrsFilter
}

/** Classify `/mrs` and `/prs` args: optional @repo plus risk:high|medium or unscored. */
export function classifyMrsArgs(args: string[]): MrsArgs {
  let repoToken: string | undefined
  let riskFilter: MrsFilter = 'all'
  for (const tok of args) {
    const t = tok.toLowerCase()
    if (tok.startsWith('@')) repoToken = tok
    else if (t === 'risk:high') riskFilter = 'high'
    else if (t === 'risk:medium') riskFilter = 'medium'
    else if (t === 'unscored') riskFilter = 'unscored'
    else if (t === 'all') riskFilter = 'all'
  }
  return { repoToken, riskFilter }
}

/** Parse one `telegram-poll.sh` output line (`<iso>\t<text>`). Returns the
 *  command text iff it's a command newer than `enabledAt` (skip pre-enable
 *  backlog and multi-line continuation lines), else null. */
export function parsePollLine(line: string, enabledAt: number): string | null {
  const tab = line.indexOf('\t')
  if (tab < 0) return null // continuation of a multi-line message — commands are single-line
  const ts = Date.parse(line.slice(0, tab))
  if (!Number.isNaN(ts) && ts < enabledAt - 5_000) return null // pre-enable backlog
  const text = line.slice(tab + 1).trim()
  return text.startsWith('/') ? text : null
}

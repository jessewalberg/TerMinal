// Deterministic activity-kind classifier. Saves agents from having to pass
// the right `kind:` on every emit_activity call — the harness infers it from
// the title using regex patterns that handle ~90% of cases. Skill authors
// don't need to memorize the kind enum.

import type { ActivityKind } from './events'

const PATTERNS: { pattern: RegExp; kind: ActivityKind }[] = [
  // Session lifecycle
  { pattern: /^session\s+started?/i, kind: 'session-start' },
  { pattern: /^session\s+(end|closed?|wrapped)/i, kind: 'session-end' },
  // Tickets
  { pattern: /^ticket\s+(filed|created|opened)/i, kind: 'ticket-filed' },
  { pattern: /^ticket\s+(closed|resolved|done)/i, kind: 'ticket-closed' },
  // PRs / MRs
  // Allow optional iid like "PR !72" / "MR #14" between the prefix and verb.
  { pattern: /^(pr|mr)\s+(?:[!#]?\d+\s+)?(opened|created|filed)/i, kind: 'pr-opened' },
  { pattern: /^(pr|mr)\s+(?:[!#]?\d+\s+)?merged/i, kind: 'pr-merged' },
  { pattern: /^(pr|mr|review)\s+(?:[!#]?\d+\s+)?(verdict|reviewed|review)/i, kind: 'pr-verdict' },
  // Deploy / ship / publish — value lands here for the Workers/Astro/email fleet
  { pattern: /^(deploy(ed|ment|ing)?|shipped|publish(ed|ing)?|released)\b/i, kind: 'deploy' },
  // Tests
  { pattern: /^tests?\s+(pass(ed|ing)?|green)/i, kind: 'tests-pass' },
  { pattern: /^tests?\s+(fail(ed|ing)?|red)/i, kind: 'tests-fail' },
  // Checks / drift / scheduled
  { pattern: /^(check|drift|coverage|deps|deps-quality|dead-code|perf|health)\b/i, kind: 'check' },
  { pattern: /^scheduled\s+/i, kind: 'agent-run' },
  // Docs
  { pattern: /^(doc|docs|adr|changelog)\b/i, kind: 'doc' },
  // Blockers
  { pattern: /^hitl\b/i, kind: 'blocked' },
  { pattern: /\b(blocked|blocker|need(s)?\s+human|waiting\s+on\s+human)\b/i, kind: 'blocked' },
  // Failures
  { pattern: /\bfail(ed|ing)?\b|\berror\b|\b(exit\s+\d+|exit-code\s+\d+)\b/i, kind: 'error' },
  { pattern: /\b(crash|crashed|panic|exception)\b/i, kind: 'error' },
  // Completions
  { pattern: /^(task|run|agent)\s+(complete|done|finished)/i, kind: 'task-complete' },
  { pattern: /^agent\s+(started|running)/i, kind: 'agent-run' },
]

/** Infer the most-likely ActivityKind from a title. Returns the explicit kind
 *  when one matches, otherwise 'info'. Pure regex — no LLM. */
export function inferActivityKind(title: string, fallback: ActivityKind = 'info'): ActivityKind {
  if (!title) return fallback
  for (const { pattern, kind } of PATTERNS) {
    if (pattern.test(title)) return kind
  }
  return fallback
}

/** When an agent passes an explicit kind, honor it. Otherwise infer.
 *  Used by emit_activity MCP tool + terminal-cli activity. */
export function resolveActivityKind(passed: string | undefined, title: string): ActivityKind {
  const valid: ActivityKind[] = [
    'session-start',
    'session-end',
    'ticket-filed',
    'ticket-closed',
    'pr-opened',
    'pr-verdict',
    'pr-merged',
    'deploy',
    'tests-pass',
    'tests-fail',
    'check',
    'doc',
    'agent-run',
    'task-complete',
    'blocked',
    'error',
    'info',
  ]
  if (passed && valid.includes(passed as ActivityKind)) return passed as ActivityKind
  return inferActivityKind(title)
}

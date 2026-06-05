// Task-first per-step routing — PURE (no electron/disk imports; the impure
// inputs — Settings.roles, engineDefaultModel — are injected by the caller).
// This is the single resolution authority runStep flows every step through:
//
//   per-run explicit model > role policy > per-engine settings default
//   role engine (tagged steps) > run engine (untagged steps — today's path)
//
// A step with no role resolves byte-identically to the pre-routing behavior
// (engine = spec.engine, model = spec.model || engineDefaultModel(engine)),
// which is the regression guarantee for every existing run path.
import type { EngineId, RoleId, RoleCfg } from './settings'
import { roleRoutingFrom } from './settings'
import { classifyRiskHeuristic } from './pr-risk-classifier'
import type { Step } from './pipelines'

export type StepRouting = { engine: EngineId; model: string }

export function resolveStepRouting(args: {
  step: Pick<Step, 'role'>
  specEngine: EngineId
  /** The run's explicit model override (RunSpec.model) — wins over role policy. */
  specModel?: string
  roles?: Partial<Record<RoleId, RoleCfg>>
  /** engineDefaultModel, injected to keep this module pure. */
  engineDefault: (e: EngineId) => string
}): StepRouting {
  const role = args.step.role ? roleRoutingFrom(args.roles, args.step.role) : null
  const engine = role?.engine ?? args.specEngine
  const model = args.specModel || role?.model || args.engineDefault(engine) || ''
  return { engine, model }
}

// Separation of duties (global policy: reviewer ≠ implementer, different model
// family). Engine is the family proxy: claude→Anthropic, codex→OpenAI,
// cursor→Cursor's own routing. The runner skips a review/verify stage that
// resolved to the implementer's family rather than silently self-reviewing.
export function sameEngineFamily(a: EngineId, b: EngineId): boolean {
  return a === b
}

export type HeavyVerdict = {
  heavy: boolean
  reason: string
  files: string[]
  diffLines: number
}

export type StageGateCtx = {
  /** Engine resolved for THIS step. */
  stepEngine: EngineId
  /** Engine resolved for the run's code stage, when one exists. */
  codeEngine?: EngineId
  /** Lazily computed `git diff --numstat <base>...HEAD`; null = unavailable. */
  numstat: () => string | null
  /** Budget gate probe — consulted only at the verify boundary (a long run
   *  can cross the daily cap between task start and the verify stage). */
  budgetGate?: () => { decision: string; reason?: string }
}

export type StageGateVerdict = { skip: string } | { note?: string }

/** Stage-boundary gate, pure: should this step be skipped, and why? Checked
 *  cheapest-first: separation of duties (policy), then budget, then the
 *  heavy-diff condition (needs git). The runner appends the reason to the run
 *  log either way — a skipped stage must be visible, never silent. */
export function stageSkipReason(
  step: Pick<Step, 'role' | 'condition'>,
  ctx: StageGateCtx,
): StageGateVerdict {
  // Reviewer ≠ implementer (global policy): a review/verify stage that
  // resolved to the code stage's family would be self-review — skip it
  // rather than counterfeit the gate.
  if ((step.role === 'review' || step.role === 'verify') && ctx.codeEngine) {
    if (sameEngineFamily(ctx.stepEngine, ctx.codeEngine)) {
      return {
        skip: `separation of duties: ${ctx.codeEngine} implemented the code stage — same-family ${step.role} would be self-review`,
      }
    }
  }
  if (step.role === 'verify' && ctx.budgetGate) {
    const g = ctx.budgetGate()
    if (g.decision === 'refuse') return { skip: `budget gate: ${g.reason || 'cap reached'}` }
  }
  if (step.condition === 'heavy') {
    const numstat = ctx.numstat()
    if (numstat === null) {
      return { note: 'verify gate: diff unavailable — running verify (fail safe)' }
    }
    const verdict = isHeavyChange(numstat)
    if (!verdict.heavy) return { skip: `not heavy — ${verdict.reason}` }
    return { note: `verify gate: heavy change — ${verdict.reason}` }
  }
  return {}
}

/** Decide whether a worktree diff is HEAVY (verify-stage trigger). Input is
 *  the raw `git diff --numstat <base>...HEAD` output; classification reuses
 *  the PR risk heuristic (high-risk paths or a large diff ⇒ heavy) rather
 *  than a naive line count, so lockfile noise doesn't fire the verify stage
 *  and a small auth change does. */
export function isHeavyChange(numstat: string): HeavyVerdict {
  const files: string[] = []
  let diffLines = 0
  for (const line of numstat.split('\n')) {
    const m = line.split('\t')
    if (m.length < 3 || !m[2]) continue
    files.push(m[2])
    const add = parseInt(m[0], 10)
    const del = parseInt(m[1], 10)
    if (Number.isFinite(add)) diffLines += add
    if (Number.isFinite(del)) diffLines += del
  }
  if (!files.length) return { heavy: false, reason: 'no diff', files, diffLines }
  const risk = classifyRiskHeuristic({ files, diffLines })
  if (risk.tier === 'high') {
    return { heavy: true, reason: risk.evidence.join('; '), files, diffLines }
  }
  if (diffLines > 500) {
    return { heavy: true, reason: `large diff (${diffLines} lines)`, files, diffLines }
  }
  return { heavy: false, reason: `${risk.tier} risk · ${diffLines} lines`, files, diffLines }
}

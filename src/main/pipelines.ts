// Pure pipeline logic — no electron/disk imports, so it's unit-testable.
// A pipeline is a chain of stages run sequentially in ONE worktree: the first
// step is the task itself, later stages append review/iterate passes.
import type { RoleId } from './settings' // type-only — keeps this module pure

export type Step = {
  label: string
  prompt: string
  /** Task-first routing: which role's engine+model runs this step. Unset →
   *  the run's engine (today's behavior, byte-identical). */
  role?: RoleId
  /** 'heavy' = run only when the worktree diff classifies as heavy (the
   *  runner computes this at the stage boundary and skips otherwise). */
  condition?: 'heavy'
  /** Pause for HITL approval before spawning this step (plan gate). */
  approveBefore?: boolean
}

const REVIEW_STAGE: Step = {
  label: 'review',
  prompt:
    'Now act as a meticulous senior reviewer of the work just done on this branch. Inspect `git diff` against the base branch and `git log`. Evaluate correctness, security, architecture, and quality. Fix any real issues you find directly in this worktree — with tests — and commit. If a PR is open for this branch, update it. End with a concise review summary: what you found and what you changed.',
}
const ITERATE_STAGE: Step = {
  label: 'iterate',
  prompt:
    'Now iterate until this branch is merge-ready: resolve any remaining review findings and TODOs, make the test suite and build pass, and tighten edge cases — keep changes surgical. Commit your work and update the PR if one is open. End with the final status (tests/build green?) and a short summary.',
}

export type PipelineId = 'single' | 'review' | 'review-iterate'
export const PIPELINES: Record<
  PipelineId,
  { id: PipelineId; title: string; description: string; stages: Step[] }
> = {
  single: { id: 'single', title: 'Single run', description: 'Just the task — one pass.', stages: [] },
  review: {
    id: 'review',
    title: 'Review',
    description: 'Task → a reviewer pass that fixes issues it finds.',
    stages: [REVIEW_STAGE],
  },
  'review-iterate': {
    id: 'review-iterate',
    title: 'Review + Iterate',
    description: 'Task → review → iterate until merge-ready.',
    stages: [REVIEW_STAGE, ITERATE_STAGE],
  },
}

/** Valid pipeline ids — used by the Telegram parser to classify a token. */
export const PIPELINE_IDS = new Set<string>(Object.keys(PIPELINES))

export function listPipelines(): { id: PipelineId; title: string; description: string }[] {
  return Object.values(PIPELINES).map(({ id, title, description }) => ({ id, title, description }))
}

function resolvePipeline(pipelineId?: string) {
  return PIPELINES[(pipelineId as PipelineId) || 'single'] || PIPELINES.single
}

/** Compose the runnable steps: base task + pipeline stages, each prefixed with
 *  the persona framing (if any). */
export function composeSteps(base: Step, personaPrompt: string | null, pipelineId?: string): Step[] {
  return [base, ...resolvePipeline(pipelineId).stages].map((s) => ({
    label: s.label,
    prompt: personaPrompt ? `${personaPrompt}\n\n---\n\n${s.prompt}` : s.prompt,
  }))
}

/** Display label for a run's pipeline — undefined for the default single run. */
export function pipelineLabel(pipelineId?: string): string | undefined {
  const p = resolvePipeline(pipelineId)
  return p.id === 'single' ? undefined : p.title
}

// --- task-first pipeline ------------------------------------------------------
// A TASK is a freeform prompt run as a fixed role chain in ONE worktree:
// plan(opus) → code(cursor) → review(codex) → verify(opus, heavy only).
// Stage handoff is durable through the worktree: plan writes .terminal/plan.md
// and commits it; code reads it; review/verify read the branch diff.

const PLAN_FILE = '.terminal/plan.md'

const planStep = (task: string): Step => ({
  label: 'plan',
  role: 'plan',
  prompt:
    `You are the PLANNING stage of a multi-stage task pipeline. A separate coding stage runs after you in this same worktree.\n\n` +
    `TASK:\n${task}\n\n` +
    `Study the repository (docs, conventions, existing code and tests) and produce a concrete implementation plan. Write the plan to ${PLAN_FILE} (mkdir -p .terminal), then commit that file with message "chore(task): plan". The plan must contain: the goal restated, files to touch, the TDD sequence (which test first, expected failure), risks/edge cases, and what is explicitly out of scope.\n\n` +
    `Do NOT write or change any production code or tests in this stage — the plan file and its commit are your only output. End with a one-paragraph summary of the plan.`,
})

const codeStep = (): Step => ({
  label: 'code',
  role: 'code',
  prompt:
    `You are the CODING stage of a multi-stage task pipeline. The planning stage before you committed its plan to ${PLAN_FILE} in this worktree.\n\n` +
    `First: read ${PLAN_FILE}. If it does not exist or is empty, STOP and exit non-zero with the message "plan artifact missing" — do not improvise a plan; the pipeline must fail visibly.\n\n` +
    `Implement the plan test-first: write the failing test, make it pass, refactor, run the full suite. Commit in small conventional-commit units as you go. When the implementation is complete and green, push the branch and open a PR (gh or glab; do NOT merge it — never merge), then print the PR URL on a line by itself in the format:\nMR: <url>\n\n` +
    `If you cannot complete the task, say so on a line starting with:\nFAILED: <one-line reason>`,
})

const reviewStep = (): Step => ({
  label: 'review',
  role: 'review',
  prompt:
    'You are the REVIEW stage of a multi-stage task pipeline, running as a different model family than the implementer (separation of duties). Act as a meticulous senior reviewer of the work on this branch: inspect `git diff` against the base branch, `git log`, and the test suite. Evaluate correctness, security, architecture, and test quality. Fix real issues directly in this worktree — with tests — and commit. If a PR is open for this branch, update it with a review summary comment. End with a concise verdict: what you found, what you changed, and whether the branch is merge-ready.',
})

const verifyStep = (): Step => ({
  label: 'verify',
  role: 'verify',
  prompt:
    'You are the VERIFY stage of a multi-stage task pipeline — the final adversarial check on a HEAVY change. Re-run the full test suite and build. Then try to break the diff: probe edge cases, error paths, concurrency, and security-sensitive surfaces the review may have missed. Fix anything critical (with tests) and commit; for non-critical findings, list them clearly instead of churning the code. If a PR is open, post your verification verdict on it. End with: VERIFIED (safe to merge) or NEEDS-WORK (with the blocking findings).',
})

/** Compose the runnable steps for a task-first run. Pure: the caller passes
 *  the taskFlow knobs (read from Settings at the call site). */
export function composeTaskSteps(
  task: string,
  flow: { verify: 'heavy' | 'always' | 'never'; planGate: boolean },
): Step[] {
  const code = codeStep()
  if (flow.planGate) code.approveBefore = true
  const steps: Step[] = [planStep(task), code, reviewStep()]
  if (flow.verify !== 'never') {
    const v = verifyStep()
    if (flow.verify === 'heavy') v.condition = 'heavy'
    steps.push(v)
  }
  return steps
}

/** Display label for task runs in the Runs tab / run header. */
export const TASK_PIPELINE_LABEL = 'plan→code→review→verify'

import { test, expect, describe } from 'bun:test'
import { composeSteps, composeTaskSteps, pipelineLabel, listPipelines, PIPELINE_IDS } from './pipelines'

const base = { label: 'task', prompt: 'do the thing' }

describe('composeSteps', () => {
  test('single pipeline = just the base task', () => {
    const steps = composeSteps(base, null, 'single')
    expect(steps).toHaveLength(1)
    expect(steps[0]).toEqual(base)
  })

  test('unknown / undefined pipeline falls back to single', () => {
    expect(composeSteps(base, null, undefined)).toHaveLength(1)
    expect(composeSteps(base, null, 'bogus')).toHaveLength(1)
  })

  test('review adds one stage after the task', () => {
    const steps = composeSteps(base, null, 'review')
    expect(steps.map((s) => s.label)).toEqual(['task', 'review'])
    expect(steps[0].prompt).toBe('do the thing')
  })

  test('review-iterate adds review then iterate, in order', () => {
    expect(composeSteps(base, null, 'review-iterate').map((s) => s.label)).toEqual([
      'task',
      'review',
      'iterate',
    ])
  })

  test('persona prompt is prepended to every step', () => {
    const steps = composeSteps(base, 'YOU ARE A SECURITY EXPERT', 'review')
    for (const s of steps) {
      expect(s.prompt.startsWith('YOU ARE A SECURITY EXPERT')).toBe(true)
      expect(s.prompt).toContain('---')
    }
    expect(steps[0].prompt).toContain('do the thing') // base content survives
  })

  test('no persona = stage prompt unchanged (no separator injected)', () => {
    expect(composeSteps(base, null, 'review')[1].prompt).not.toContain('---')
  })
})

describe('pipelineLabel', () => {
  test('single → undefined (nothing shown)', () => {
    expect(pipelineLabel('single')).toBeUndefined()
    expect(pipelineLabel(undefined)).toBeUndefined()
  })

  test('review / review-iterate → display titles', () => {
    expect(pipelineLabel('review')).toBe('Review')
    expect(pipelineLabel('review-iterate')).toBe('Review + Iterate')
  })
})

describe('listPipelines / PIPELINE_IDS', () => {
  test('lists the three pipelines with non-empty title + description', () => {
    expect(listPipelines().map((p) => p.id)).toEqual(['single', 'review', 'review-iterate'])
    for (const p of listPipelines()) {
      expect(p.title.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
    }
  })

  test('PIPELINE_IDS matches the pipeline set', () => {
    expect([...PIPELINE_IDS].sort()).toEqual(['review', 'review-iterate', 'single'])
  })
})

describe('composeTaskSteps (task-first role pipeline)', () => {
  const task = 'add dark mode to the settings panel'

  test('heavy mode: plan→code→review→verify with roles tagged, verify conditional', () => {
    const steps = composeTaskSteps(task, { verify: 'heavy', planGate: false })
    expect(steps.map((s) => s.label)).toEqual(['plan', 'code', 'review', 'verify'])
    expect(steps.map((s) => s.role)).toEqual(['plan', 'code', 'review', 'verify'])
    expect(steps[3].condition).toBe('heavy')
    expect(steps.slice(0, 3).every((s) => s.condition === undefined)).toBe(true)
  })

  test('always mode: verify included unconditionally', () => {
    const steps = composeTaskSteps(task, { verify: 'always', planGate: false })
    expect(steps.map((s) => s.role)).toEqual(['plan', 'code', 'review', 'verify'])
    expect(steps[3].condition).toBeUndefined()
  })

  test('never mode: verify omitted at compose time', () => {
    const steps = composeTaskSteps(task, { verify: 'never', planGate: false })
    expect(steps.map((s) => s.role)).toEqual(['plan', 'code', 'review'])
  })

  test('planGate marks the code step approveBefore', () => {
    const gated = composeTaskSteps(task, { verify: 'heavy', planGate: true })
    expect(gated[1].approveBefore).toBe(true)
    const open = composeTaskSteps(task, { verify: 'heavy', planGate: false })
    expect(open[1].approveBefore).toBeUndefined()
  })

  test('plan step carries the task text and the plan-artifact contract', () => {
    const steps = composeTaskSteps(task, { verify: 'heavy', planGate: false })
    expect(steps[0].prompt).toContain(task)
    expect(steps[0].prompt).toContain('.terminal/plan.md')
    // plan stage must not implement
    expect(steps[0].prompt.toLowerCase()).toContain('do not write or change any production code')
  })

  test('code step requires the plan artifact and opens a PR (never merges)', () => {
    const steps = composeTaskSteps(task, { verify: 'heavy', planGate: false })
    expect(steps[1].prompt).toContain('.terminal/plan.md')
    expect(steps[1].prompt.toLowerCase()).toContain('fail')
    expect(steps[1].prompt).toContain('MR: <url>')
    expect(steps[1].prompt.toLowerCase()).toContain('never merge')
  })

  test('existing pipelines are untouched (no roles leak into composeSteps)', () => {
    const steps = composeSteps(base, null, 'review-iterate')
    expect(steps.every((s) => s.role === undefined && s.condition === undefined)).toBe(true)
  })
})

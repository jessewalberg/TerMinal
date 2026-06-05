import { test, expect, describe } from 'bun:test'
import { resolveStepRouting, sameEngineFamily, isHeavyChange } from './routing'
import { defaultSettings } from './settings'

const engineDefault = (e: string) => (e === 'claude' ? 'sonnet' : '')

describe('resolveStepRouting', () => {
  test('REGRESSION: role-unset step routes exactly like today (spec engine + spec model)', () => {
    // This is the byte-identical fast path every existing run takes:
    // effectiveModel = spec.model || engineDefaultModel(spec.engine) || ''
    expect(
      resolveStepRouting({ step: {}, specEngine: 'codex', specModel: 'gpt-5', engineDefault }),
    ).toEqual({ engine: 'codex', model: 'gpt-5' })
    expect(resolveStepRouting({ step: {}, specEngine: 'claude', engineDefault })).toEqual({
      engine: 'claude',
      model: 'sonnet', // settings per-engine default fills, as today
    })
    expect(resolveStepRouting({ step: {}, specEngine: 'cursor', engineDefault })).toEqual({
      engine: 'cursor',
      model: '',
    })
  })

  test('role-tagged step routes via the roles table', () => {
    const roles = defaultSettings().roles
    expect(
      resolveStepRouting({ step: { role: 'plan' }, specEngine: 'codex', roles, engineDefault }),
    ).toEqual({ engine: 'claude', model: 'opus' })
    expect(
      resolveStepRouting({ step: { role: 'code' }, specEngine: 'codex', roles, engineDefault }),
    ).toEqual({ engine: 'cursor', model: '' })
  })

  test('role with blank model falls to the ROLE engine settings default', () => {
    const roles = { ...defaultSettings().roles, review: { engine: 'claude' as const, model: '' } }
    expect(
      resolveStepRouting({ step: { role: 'review' }, specEngine: 'codex', roles, engineDefault }),
    ).toEqual({ engine: 'claude', model: 'sonnet' })
  })

  test('explicit per-run model override beats the role model (per-run > policy)', () => {
    const roles = defaultSettings().roles
    expect(
      resolveStepRouting({
        step: { role: 'plan' },
        specEngine: 'claude',
        specModel: 'haiku',
        roles,
        engineDefault,
      }).model,
    ).toBe('haiku')
  })

  test('absent roles table falls back to shipped defaults for tagged steps', () => {
    expect(
      resolveStepRouting({ step: { role: 'verify' }, specEngine: 'codex', engineDefault }),
    ).toEqual({ engine: 'claude', model: 'opus' })
  })
})

describe('sameEngineFamily (separation of duties)', () => {
  test('claude vs codex vs cursor are three distinct families', () => {
    expect(sameEngineFamily('claude', 'claude')).toBe(true)
    expect(sameEngineFamily('claude', 'codex')).toBe(false)
    expect(sameEngineFamily('codex', 'cursor')).toBe(false)
    expect(sameEngineFamily('cursor', 'cursor')).toBe(true)
  })
})

describe('isHeavyChange', () => {
  test('high-risk path (auth) is heavy even when tiny', () => {
    const r = isHeavyChange('3\t1\tsrc/auth/session.ts')
    expect(r.heavy).toBe(true)
    expect(r.reason).toMatch(/auth|high-risk/i)
  })

  test('small docs-only diff is not heavy', () => {
    expect(isHeavyChange('20\t4\tREADME.md\n8\t0\tdocs/usage.md').heavy).toBe(false)
  })

  test('large plain-code diff is heavy via the size floor', () => {
    const r = isHeavyChange('400\t250\tsrc/renderer/src/tabs/runs/index.tsx')
    expect(r.heavy).toBe(true)
    expect(r.reason).toMatch(/650|large|diff/i)
  })

  test('modest plain-code diff is not heavy', () => {
    expect(isHeavyChange('40\t10\tsrc/main/util.ts').heavy).toBe(false)
  })

  test('empty numstat (no diff) is not heavy', () => {
    expect(isHeavyChange('').heavy).toBe(false)
    expect(isHeavyChange('\n').heavy).toBe(false)
  })

  test('binary file lines ("-") are tolerated', () => {
    const r = isHeavyChange('-\t-\tassets/icon.png\n5\t2\tsrc/main/util.ts')
    expect(r.heavy).toBe(false)
  })
})

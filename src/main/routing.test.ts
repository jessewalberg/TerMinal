import { test, expect, describe } from 'bun:test'
import { resolveStepRouting, sameEngineFamily, isHeavyChange, stageSkipReason } from './routing'
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

describe('stageSkipReason (stage-boundary gates)', () => {
  const allow = () => ({ decision: 'allow', reason: '' })
  const refuse = () => ({ decision: 'refuse', reason: 'daily cap reached' })

  test('plain step: proceeds with no note', () => {
    expect(stageSkipReason({}, { stepEngine: 'codex', numstat: () => null })).toEqual({})
  })

  test('separation of duties: review/verify on the implementer family is skipped', () => {
    const r = stageSkipReason(
      { role: 'review' },
      { stepEngine: 'claude', codeEngine: 'claude', numstat: () => null },
    )
    expect('skip' in r && r.skip).toMatch(/separation of duties/i)
    const v = stageSkipReason(
      { role: 'verify' },
      { stepEngine: 'claude', codeEngine: 'claude', numstat: () => null },
    )
    expect('skip' in v && v.skip).toMatch(/separation of duties/i)
  })

  test('different families pass the separation check', () => {
    expect(
      stageSkipReason({ role: 'review' }, { stepEngine: 'codex', codeEngine: 'cursor', numstat: () => null }),
    ).toEqual({})
  })

  test('plan/code roles never trip the separation check', () => {
    expect(
      stageSkipReason({ role: 'code' }, { stepEngine: 'cursor', codeEngine: 'cursor', numstat: () => null }),
    ).toEqual({})
  })

  test('heavy condition: light diff skips, heavy diff proceeds with a note', () => {
    const light = stageSkipReason(
      { role: 'verify', condition: 'heavy' },
      { stepEngine: 'claude', codeEngine: 'cursor', numstat: () => '10\t2\tsrc/x.ts' },
    )
    expect('skip' in light && light.skip).toMatch(/not heavy/i)
    const heavy = stageSkipReason(
      { role: 'verify', condition: 'heavy' },
      { stepEngine: 'claude', codeEngine: 'cursor', numstat: () => '3\t0\tsrc/auth/login.ts' },
    )
    expect('note' in heavy && heavy.note).toMatch(/heavy/i)
  })

  test('heavy condition fails safe: unavailable diff runs verify with a note', () => {
    const r = stageSkipReason(
      { role: 'verify', condition: 'heavy' },
      { stepEngine: 'claude', codeEngine: 'cursor', numstat: () => null },
    )
    expect('note' in r && r.note).toMatch(/unavailable/i)
  })

  test('budget refuse skips a verify stage (re-check at the billable boundary)', () => {
    const r = stageSkipReason(
      { role: 'verify' },
      { stepEngine: 'claude', codeEngine: 'cursor', numstat: () => null, budgetGate: refuse },
    )
    expect('skip' in r && r.skip).toMatch(/budget/i)
    expect(
      stageSkipReason(
        { role: 'verify' },
        { stepEngine: 'claude', codeEngine: 'cursor', numstat: () => null, budgetGate: allow },
      ),
    ).toEqual({})
  })

  test('separation beats heavy: same-family verify skips before computing the diff', () => {
    let diffComputed = false
    const r = stageSkipReason(
      { role: 'verify', condition: 'heavy' },
      {
        stepEngine: 'claude',
        codeEngine: 'claude',
        numstat: () => {
          diffComputed = true
          return '3\t0\tsrc/auth/login.ts'
        },
      },
    )
    expect('skip' in r && r.skip).toMatch(/separation/i)
    expect(diffComputed).toBe(false)
  })
})

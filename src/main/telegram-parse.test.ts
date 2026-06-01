import { test, expect, describe } from 'bun:test'
import { parseCommand, classifyRunArgs, classifyMrsArgs, parsePollLine } from './telegram-parse'

describe('parseCommand', () => {
  test('lowercases the command, preserves arg case', () => {
    expect(parseCommand('/Run Docs Codex')).toEqual({ cmd: '/run', args: ['Docs', 'Codex'] })
  })

  test('collapses surrounding + inner whitespace', () => {
    expect(parseCommand('  /runs   ')).toEqual({ cmd: '/runs', args: [] })
  })
})

describe('classifyRunArgs', () => {
  test('first arg is the agent id', () => {
    expect(classifyRunArgs(['docs']).agentId).toBe('docs')
  })

  test('defaults: codex engine, single pipeline, no persona/repo', () => {
    const r = classifyRunArgs(['docs'])
    expect(r.engine).toBe('codex')
    expect(r.pipeline).toBe('single')
    expect(r.repoToken).toBeUndefined()
    expect(r.personaCandidates).toEqual([])
  })

  test('classifies engine / pipeline / @repo / persona in any order', () => {
    const r = classifyRunArgs(['security-sweep', 'review-iterate', '@agentforge', 'claude', 'security'])
    expect(r.agentId).toBe('security-sweep')
    expect(r.engine).toBe('claude')
    expect(r.pipeline).toBe('review-iterate')
    expect(r.repoToken).toBe('@agentforge')
    expect(r.personaCandidates).toEqual(['security'])
  })

  test('engine + pipeline matching is case-insensitive', () => {
    const r = classifyRunArgs(['docs', 'CLAUDE', 'REVIEW'])
    expect(r.engine).toBe('claude')
    expect(r.pipeline).toBe('review')
  })

  test('unrecognized tokens become persona candidates', () => {
    expect(classifyRunArgs(['docs', 'wizard', 'ninja']).personaCandidates).toEqual(['wizard', 'ninja'])
  })
})

describe('classifyMrsArgs', () => {
  test('parses @repo and risk filters in any order', () => {
    expect(classifyMrsArgs(['@vellum', 'risk:high'])).toEqual({
      repoToken: '@vellum',
      riskFilter: 'high',
    })
    expect(classifyMrsArgs(['risk:medium'])).toEqual({ repoToken: undefined, riskFilter: 'medium' })
    expect(classifyMrsArgs(['unscored', '@foo'])).toEqual({ repoToken: '@foo', riskFilter: 'unscored' })
  })

  test('ignores unsupported risk tokens (no risk:low filter)', () => {
    expect(classifyMrsArgs(['risk:low', '@foo'])).toEqual({ repoToken: '@foo', riskFilter: 'all' })
    expect(classifyMrsArgs(['risk:high', 'risk:medium'])).toEqual({ repoToken: undefined, riskFilter: 'medium' })
  })
})

describe('parsePollLine', () => {
  const T = '2026-05-28T20:00:00Z'
  const enabledBefore = Date.parse('2026-05-28T19:59:00Z')

  test('returns the command for a fresh command line', () => {
    expect(parsePollLine(`${T}\t/runs`, enabledBefore)).toBe('/runs')
  })

  test('trims the command text', () => {
    expect(parsePollLine(`${T}\t  /run docs  `, enabledBefore)).toBe('/run docs')
  })

  test('ignores non-command messages', () => {
    expect(parsePollLine(`${T}\thello there`, enabledBefore)).toBeNull()
  })

  test('ignores continuation lines (no tab)', () => {
    expect(parsePollLine('a wrapped line with no tab', enabledBefore)).toBeNull()
  })

  test('skips pre-enable backlog (message older than enabledAt)', () => {
    const enabledLater = Date.parse('2026-05-28T20:10:00Z')
    expect(parsePollLine(`${T}\t/runs`, enabledLater)).toBeNull()
  })

  test('allows a small clock-skew grace window', () => {
    const enabledJustAfter = Date.parse(T) + 3_000 // within the 5s grace
    expect(parsePollLine(`${T}\t/runs`, enabledJustAfter)).toBe('/runs')
  })
})

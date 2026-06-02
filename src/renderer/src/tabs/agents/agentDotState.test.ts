import { describe, expect, test } from 'bun:test'
import { agentDotState } from './agentDotState'

describe('agent rail status dot', () => {
  test('a running agent is the only pulsing-green dot', () => {
    const s = agentDotState({ busy: true, last: null })
    expect(s.className).toContain('var(--gt-green)')
    expect(s.className).toContain('gt-pulse')
    expect(s.title).toBe('run in progress')
  })

  test('busy wins even when a prior run exists', () => {
    const s = agentDotState({ busy: true, last: { status: 'done', relLabel: '5m ago' } })
    expect(s.className).toContain('gt-pulse')
  })

  // The headline bug: a finished-OK agent must NOT reuse the running green.
  test('a finished (done) agent is NOT green and does not pulse', () => {
    const s = agentDotState({ busy: false, last: { status: 'done', relLabel: '5m ago' } })
    expect(s.className).not.toContain('var(--gt-green)')
    expect(s.className).not.toContain('gt-pulse')
    expect(s.className).toContain('var(--gt-blue)')
    expect(s.title).toBe('last run: done · 5m ago')
  })

  test('a failed run is red', () => {
    expect(agentDotState({ busy: false, last: { status: 'failed', relLabel: '1m ago' } }).className).toContain(
      'var(--gt-red)',
    )
  })

  // interrupted/canceled previously collapsed to one neutral gray, disagreeing
  // with statusTone's badge colors. The dot now matches the badge.
  test('an interrupted run is yellow (matches its badge), not gray', () => {
    expect(
      agentDotState({ busy: false, last: { status: 'interrupted', relLabel: '2h ago' } }).className,
    ).toContain('var(--gt-yellow)')
  })

  test('a canceled run is muted gray', () => {
    expect(agentDotState({ busy: false, last: { status: 'canceled', relLabel: '3h ago' } }).className).toBe(
      'bg-zinc-500',
    )
  })

  test('an agent that never ran has no dot', () => {
    expect(agentDotState({ busy: false, last: null })).toEqual({ className: '', title: '' })
  })
})

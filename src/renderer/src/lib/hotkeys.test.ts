import { describe, expect, test } from 'bun:test'
import { resolveWorkspaceHotkey, cycleIndex } from './hotkeys'

const key = (over: Partial<Parameters<typeof resolveWorkspaceHotkey>[0]>) => ({
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  key: '1',
  ...over,
})

describe('resolveWorkspaceHotkey', () => {
  test('Cmd+digit selects that workspace (0-based) when in range', () => {
    expect(resolveWorkspaceHotkey(key({ key: '1' }), 3)).toEqual({ kind: 'select', index: 0 })
    expect(resolveWorkspaceHotkey(key({ key: '3' }), 3)).toEqual({ kind: 'select', index: 2 })
  })

  test('out-of-range digit → null', () => {
    expect(resolveWorkspaceHotkey(key({ key: '4' }), 3)).toBeNull()
  })

  test('Cmd+Shift+[ / ] cycle prev/next (handles shifted { } glyphs)', () => {
    expect(resolveWorkspaceHotkey(key({ shiftKey: true, key: '{' }), 3)).toEqual({ kind: 'prev' })
    expect(resolveWorkspaceHotkey(key({ shiftKey: true, key: '}' }), 3)).toEqual({ kind: 'next' })
  })

  test('requires Cmd; ignores Ctrl/Alt, non-digits, and 0', () => {
    expect(resolveWorkspaceHotkey(key({ metaKey: false }), 3)).toBeNull()
    expect(resolveWorkspaceHotkey(key({ ctrlKey: true }), 3)).toBeNull()
    expect(resolveWorkspaceHotkey(key({ altKey: true }), 3)).toBeNull()
    expect(resolveWorkspaceHotkey(key({ key: 'a' }), 3)).toBeNull()
    expect(resolveWorkspaceHotkey(key({ key: '0' }), 3)).toBeNull()
  })
})

describe('cycleIndex', () => {
  test('wraps both directions', () => {
    expect(cycleIndex(0, 3, 'next')).toBe(1)
    expect(cycleIndex(2, 3, 'next')).toBe(0)
    expect(cycleIndex(0, 3, 'prev')).toBe(2)
    expect(cycleIndex(1, 3, 'prev')).toBe(0)
  })

  test('empty → -1', () => {
    expect(cycleIndex(0, 0, 'next')).toBe(-1)
  })
})

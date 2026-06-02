// Pure keyboard-shortcut resolvers, kept out of the components so they're
// unit-testable without a DOM. Ticket #18 (Cmd+number quick-switch).

export type WorkspaceHotkey = { kind: 'select'; index: number } | { kind: 'prev' } | { kind: 'next' }

type KeyLike = { metaKey: boolean; shiftKey: boolean; altKey?: boolean; ctrlKey?: boolean; key: string }

/** Resolve a workspace-switch hotkey from a keydown, or null:
 *  - Cmd+1..9         → select that workspace (0-based index, in range only)
 *  - Cmd+Shift+[ or ] → cycle prev / next (shift turns the keys into { / })
 *  Cmd only — Ctrl/Alt combos are left for the OS / other handlers. */
export function resolveWorkspaceHotkey(e: KeyLike, count: number): WorkspaceHotkey | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null
  if (e.shiftKey) {
    if (e.key === '[' || e.key === '{') return { kind: 'prev' }
    if (e.key === ']' || e.key === '}') return { kind: 'next' }
    return null
  }
  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1
    return index < count ? { kind: 'select', index } : null
  }
  return null
}

/** True for the find chord (Cmd+F, no Ctrl). Used to open the terminal
 *  scrollback search overlay — ticket #19. */
export function isFindHotkey(e: { metaKey: boolean; ctrlKey?: boolean; key: string }): boolean {
  return e.metaKey && !e.ctrlKey && (e.key === 'f' || e.key === 'F')
}

/** Wrap an index forward/backward within [0, count). Returns -1 when empty. */
export function cycleIndex(current: number, count: number, dir: 'prev' | 'next'): number {
  if (count === 0) return -1
  const d = dir === 'next' ? 1 : -1
  return (((current + d) % count) + count) % count
}

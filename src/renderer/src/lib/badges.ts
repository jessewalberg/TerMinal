import type { BadgeTone } from '../components/ui'

// Status/priority/type/verdict → badge tone, mirroring the autopilot dashboard.
export const statusTone = (s: string): BadgeTone =>
  (({ open: 'yellow', 'in-progress': 'blue', closed: 'green', stuck: 'red', icebox: 'mute' }) as Record<
    string,
    BadgeTone
  >)[s] || 'mute'

export const priorityTone = (p: string): BadgeTone =>
  (({ critical: 'red', high: 'yellow', medium: 'blue', low: 'mute' }) as Record<string, BadgeTone>)[
    p
  ] || 'mute'

export const typeTone = (t: string): BadgeTone =>
  (({
    bug: 'red',
    security: 'red',
    feature: 'accent',
    docs: 'mute',
    dx: 'blue',
    testing: 'blue',
    ux: 'yellow',
    performance: 'yellow',
  }) as Record<string, BadgeTone>)[t] || 'mute'

export const verdictTone = (v: string): BadgeTone =>
  v === 'approve' ? 'green' : v === 'request-changes' || v === 'blocked' ? 'red' : 'mute'

export const testTone = (s: string): BadgeTone => (s === 'pass' ? 'green' : s === 'fail' ? 'red' : 'mute')

// GitLab CI pipeline/job statuses → badge tone.
export const ciTone = (s: string): BadgeTone => {
  const x = (s || '').toLowerCase()
  if (x === 'success') return 'green'
  if (x === 'failed') return 'red'
  if (x === 'running' || x === 'pending') return 'yellow'
  if (x === 'manual') return 'blue'
  return 'mute' // created, canceled, skipped, scheduled, …
}

export const sevTone = (s: string): BadgeTone => {
  const x = (s || '').toLowerCase()
  return x === 'critical' || x === 'high' ? 'red' : x === 'medium' ? 'yellow' : 'blue'
}

export const stateTone = (s: string): BadgeTone =>
  s === 'merged' ? 'green' : s === 'closed' ? 'red' : 'yellow'

export const sessionStatusTone = (s: string): BadgeTone =>
  s === 'active' ? 'green' : s === 'abandoned' ? 'red' : 'mute'

export const horizonTone = (h: string): BadgeTone =>
  h === 'now' ? 'accent' : h === 'next' ? 'blue' : 'mute'

// Tone per activity kind. Map (not ternary chain) so the richer kind set stays
// readable; unknown kinds fall through to 'mute'.
const ACTIVITY_TONES: Record<string, BadgeTone> = {
  'task-complete': 'green',
  'tests-pass': 'green',
  'pr-merged': 'green',
  deploy: 'green',
  'ticket-closed': 'green',
  'ticket-filed': 'accent',
  'pr-verdict': 'blue',
  'pr-opened': 'blue',
  'agent-run': 'blue',
  blocked: 'yellow',
  'tests-fail': 'red',
  error: 'red',
  check: 'mute',
  doc: 'mute',
  'session-start': 'mute',
  'session-end': 'mute',
  info: 'mute',
}
export const activityTone = (k: string): BadgeTone => ACTIVITY_TONES[k] ?? 'mute'

import { Notification } from 'electron'
import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  watch,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { telegramNotifyEnabled, readSettings } from './settings'
import { sendUrl } from './telegram-api'

// Telegram notify: native Bot API when a token+chat are configured; otherwise
// fall back to the project-template /notify script if it's present.
const TG_SCRIPT = join(homedir(), '.claude', 'bin', 'telegram-notify.sh')
function tgKind(ev: ActivityEvent): 'done' | 'blocked' | 'info' {
  if (ev.kind === 'error' || ev.kind === 'tests-fail' || ev.kind === 'blocked') return 'blocked'
  if (ev.kind === 'task-complete' || ev.kind === 'tests-pass' || ev.kind === 'pr-merged') return 'done'
  if (ev.kind === 'agent-run')
    return /failed|interrupted/i.test(ev.title) ? 'blocked' : /done/i.test(ev.title) ? 'done' : 'info'
  return 'info'
}
const KIND_EMOJI: Record<'done' | 'blocked' | 'info', string> = { done: '✅', blocked: '⛔', info: 'ℹ️' }

// Compose the inline-keyboard for an event. HITL filings get [Resolve] and,
// when a runId is known, [View run] (callback → tail log). Other events get
// no buttons — chat plays back as plain notifications.
function buttonsFor(ev: ActivityEvent): unknown[][] | null {
  if (ev.kind !== 'blocked' || !ev.hitlId) return null
  const row: { text: string; callback_data: string }[] = [
    { text: '✅ Resolve', callback_data: `hitl:resolve:${ev.hitlId}` },
  ]
  if (ev.runId) row.push({ text: '🪵 Tail run', callback_data: `run:tail:${ev.runId}` })
  return [row]
}

function sendTelegram(ev: ActivityEvent) {
  if (!telegramNotifyEnabled()) return // opt-in, off by default
  const { telegram } = readSettings()
  const msg = ev.detail ? `${ev.title} — ${ev.detail}` : ev.title
  if (telegram.botToken && telegram.chatId) {
    const buttons = buttonsFor(ev)
    const body: Record<string, unknown> = {
      chat_id: telegram.chatId,
      text: `${KIND_EMOJI[tgKind(ev)]} ${msg}`,
    }
    if (buttons) body.reply_markup = { inline_keyboard: buttons }
    fetch(sendUrl(telegram.botToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {}) // best effort
    return
  }
  if (!existsSync(TG_SCRIPT)) return // no native config + no script → skip silently
  try {
    spawn(TG_SCRIPT, [`--kind=${tgKind(ev)}`, msg], { stdio: 'ignore' }).unref()
  } catch {
    /* best effort */
  }
}

// Activity feed + system notifications. Events are stored GLOBALLY (one log
// across every repo/session) but each is tagged with repo + session, so the
// Activity tab can show the global firehose or filter to one repo/session.
const LOG = join(homedir(), '.config', 'TerMinal', 'activity.jsonl')
const MAX_KEEP = 2000 // cap the on-disk log

// Canonical activity kinds — workflow checkpoints emitted by the app AND by the
// skills (project-template/.claude/bin/activity + bin/gt-notify emit these by
// name). Keep in sync with src/renderer/src/lib/types.ts and the tab's ICON/tone
// maps. Unknown kinds still render (Info icon + mute tone fallbacks).
export type ActivityKind =
  | 'session-start'
  | 'session-end'
  | 'ticket-filed'
  | 'ticket-closed'
  | 'pr-opened'
  | 'pr-verdict'
  | 'pr-merged'
  | 'deploy'
  | 'tests-pass'
  | 'tests-fail'
  | 'check'
  | 'doc'
  | 'agent-run'
  | 'task-complete'
  | 'blocked'
  | 'error'
  | 'info'

export type ActivityEvent = {
  id: string
  ts: number
  kind: ActivityKind
  title: string
  detail?: string
  repo?: string
  repoRoot?: string
  sessionId?: string
  // join keys for cycle-time linkage: connect a ticket's events across its life
  // (ticket-filed → pr-opened{ticket,pr} → pr-verdict{pr} → pr-merged{pr}).
  ref?: { ticket?: number; pr?: number }
  // Pointer back to the originating cron / in-process run, so clicking the
  // event in the Activity tab can jump to that run's log in the Runs tab.
  runId?: string
  runSource?: 'cron' | 'agent'
  // Set when the event is a HITL filing — drives the inline Telegram buttons
  // ([Resolve] / [View run]) so the user can act from the chat without
  // having to text /hitl + /resolve.
  hitlId?: string
}

// which kinds raise a macOS/Telegram notification (vs. log-only feed context).
// High-signal checkpoints ping; routine/contextual ones are log-only.
const NOTIFY: Record<ActivityKind, boolean> = {
  'session-start': false,
  'session-end': false,
  'ticket-filed': true,
  'ticket-closed': false,
  'pr-opened': false,
  'pr-verdict': true,
  'pr-merged': true,
  deploy: false, // ship events are feed context; per-repo /deploy skills opt in to pinging if they want
  'tests-pass': false,
  'tests-fail': true,
  check: false,
  doc: false,
  'agent-run': true,
  'task-complete': true,
  blocked: true,
  error: true,
  info: false,
}

let broadcast: (ev: ActivityEvent) => void = () => {}
export function onActivity(fn: (ev: ActivityEvent) => void) {
  broadcast = fn
}

// macOS + Telegram notification for one event.
function fireNotification(ev: ActivityEvent): void {
  if (Notification.isSupported()) {
    try {
      new Notification({ title: ev.title, body: ev.detail || '' }).show()
    } catch {
      /* notifications unavailable */
    }
  }
  sendTelegram(ev)
}

// Ids the app emitted in-process (and already notified for) — so the file tail
// doesn't double-notify them. Bounded; old ids age out.
const emittedIds = new Set<string>()
function rememberEmitted(id: string): void {
  emittedIds.add(id)
  if (emittedIds.size > 1000) {
    for (const id of emittedIds) {
      emittedIds.delete(id)
      if (emittedIds.size <= 800) break
    }
  }
}

// Auto-infer kind from title when the caller passed 'info' (or anything
// non-specific) and the title matches a clearer pattern. Saves agents from
// having to specify the right enum every time.
function maybeInferKind(passed: ActivityKind, title: string): ActivityKind {
  // Only run inference when the caller didn't pick a specific kind.
  if (passed !== 'info') return passed
  try {
    const { inferActivityKind } = require('./event-classifier') as typeof import('./event-classifier')
    return inferActivityKind(title, 'info')
  } catch {
    return passed
  }
}

export function emitActivity(
  e: Omit<ActivityEvent, 'id' | 'ts'>,
  opts?: { notify?: boolean },
): ActivityEvent {
  const inferredKind = maybeInferKind(e.kind, e.title)
  const ev: ActivityEvent = { ...e, kind: inferredKind, id: randomUUID(), ts: Date.now() }
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, JSON.stringify(ev) + '\n')
  } catch {
    /* best effort */
  }
  rememberEmitted(ev.id)
  if (opts?.notify ?? NOTIFY[ev.kind]) fireNotification(ev)
  // NOTE: don't broadcast here — the file tail (below) picks up this append and
  // broadcasts it, so terminal-written and skill-written events flow through one
  // path (no double feed entries). The tail also NOTIFIES external (skill/cron)
  // events — deduped against emittedIds so app emits don't ping twice.
  return ev
}

// Tail the log so events appended by ANYTHING (project-template skills, scripts)
// surface live in the Activity tab — not just events the app emits in-process.
let tailSize = 0
let tailing = false
export function startActivityTail() {
  if (tailing) return
  tailing = true
  try {
    tailSize = existsSync(LOG) ? statSync(LOG).size : 0
  } catch {
    tailSize = 0
  }
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    // watch the dir (the file may be created/rotated) and drain on changes
    watch(dirname(LOG), (_evt, fn) => {
      if (!fn || fn === basename(LOG)) drainTail()
    })
  } catch {
    /* watch unavailable — feed still loads via activity:list */
  }
}

function drainTail() {
  let size = 0
  try {
    size = statSync(LOG).size
  } catch {
    return
  }
  if (size < tailSize) tailSize = 0 // truncated/cleared → restart
  if (size <= tailSize) return
  const len = size - tailSize
  try {
    const fd = openSync(LOG, 'r')
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, tailSize)
    closeSync(fd)
    tailSize = size
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as ActivityEvent
        broadcast(ev)
        // Notify for EXTERNAL high-signal events (skills, cron, gt-notify) that the
        // app didn't emit in-process — so skill-raised HITL/blocked/errors actually
        // ping. Deduped against emittedIds so app emits don't double-notify.
        if (!emittedIds.has(ev.id) && NOTIFY[ev.kind]) fireNotification(ev)
      } catch {
        /* partial/garbled line — skip */
      }
    }
  } catch {
    /* read race — next change will catch up */
  }
}

/** Newest-first, capped. */
export function readActivity(limit = 500): ActivityEvent[] {
  if (!existsSync(LOG)) return []
  try {
    const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    // opportunistically compact a runaway log
    if (lines.length > MAX_KEEP) {
      try {
        writeFileSync(LOG, lines.slice(-MAX_KEEP).join('\n') + '\n')
      } catch {
        /* ignore */
      }
    }
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as ActivityEvent
        } catch {
          return null
        }
      })
      .filter((e): e is ActivityEvent => !!e)
      .reverse()
  } catch {
    return []
  }
}

export function clearActivity() {
  try {
    if (existsSync(LOG)) writeFileSync(LOG, '')
  } catch {
    /* ignore */
  }
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { emitActivity } from './events'
import { readSettings } from './settings'
import { sendUrl } from './telegram-api'

// GLOBAL human-in-the-loop inbox — one cross-repo queue of TRUE human-needs
// (decisions, destructive/cost approvals, creds, a failed cron job, anything an
// agent can't resolve itself). NOT per-repo backlog tickets, and NOT review
// request-changes (those are iterative workflow, handled by the factory). Filing
// one surfaces a `blocked` activity event → macOS + Telegram notification.
const FILE = join(homedir(), '.config', 'TerMinal', 'hitl.json')

export type HitlSource =
  | 'manual'
  | 'cron-fail'
  | 'agent'
  | 'factory'
  | 'skill'
  | 'wedged-detector'
  | 'review-pattern'
export type HitlItem = {
  id: string
  title: string
  detail?: string
  action?: string // what the human needs to do
  repo?: string
  repoRoot?: string
  source: HitlSource
  status: 'open' | 'resolved'
  createdAt: number
  resolvedAt?: number
  // Optional pointer back to the run that produced this HITL. Lets the HITL
  // tab show a "View run" button that jumps to the Runs tab + selects the
  // source run so the operator can read the log that prompted the block.
  runId?: string
  runSource?: 'cron' | 'agent' | 'workflow'
  // Path to the auto-filed backlog ticket that pairs with this HITL (cron
  // failures file both — HITL is the "look at me" channel, the ticket is
  // the durable triage record). Lets the HITL tab link straight to the
  // ticket in the Tickets tab.
  ticketPath?: string
  // Pointer back to the Claude session that produced this HITL (wedged-detector).
  sessionId?: string
  // Stable bucket id for review-pattern HITLs so re-mining doesn't dup.
  patternKey?: string
}

export function readHitl(): HitlItem[] {
  if (!existsSync(FILE)) return []
  try {
    const a = JSON.parse(readFileSync(FILE, 'utf8'))
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

function write(list: HitlItem[]): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(list, null, 2))
  } catch {
    /* best effort */
  }
}

export function openCount(): number {
  return readHitl().filter((h) => h.status === 'open').length
}

// HITL is by definition "I need attention" — always ping Telegram on file,
// regardless of the activity-feed `telegram.notify` toggle (which gates the
// general feed). Only requires bot token + chat to be configured. Falls back
// to the legacy ~/.claude/bin/telegram-notify.sh script if no native config.
const LEGACY_TG_SCRIPT = join(homedir(), '.claude', 'bin', 'telegram-notify.sh')
function alwaysPingTelegram(item: HitlItem): void {
  try {
    const { telegram } = readSettings()
    const msg = `⛔ HITL · ${item.title}${item.action ? ` — ${item.action}` : ''}`
    if (telegram.botToken && telegram.chatId) {
      // Inline [Resolve] (always) + [Tail run] (when we know the run id) so
      // the chat ping is one-tap actionable instead of "now go open the app
      // and click Resolve."
      const row: { text: string; callback_data: string }[] = [
        { text: '✅ Resolve', callback_data: `hitl:resolve:${item.id}` },
      ]
      if (item.runId) row.push({ text: '🪵 Tail run', callback_data: `run:tail:${item.runId}` })
      fetch(sendUrl(telegram.botToken), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text: msg,
          reply_markup: { inline_keyboard: [row] },
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {})
      return
    }
    if (!existsSync(LEGACY_TG_SCRIPT)) return
    spawn(LEGACY_TG_SCRIPT, [`--kind=blocked`, msg], { stdio: 'ignore' }).unref()
  } catch {
    /* best effort — never fail a HITL filing because of a notify glitch */
  }
}

/** File a HITL item (newest first) and fire the blocked notification. */
/** Cheap title fingerprint for dedup — collapse case + whitespace, drop the
 *  short transient bits (run/sha ids). */
function hitlFingerprint(title: string, repo?: string): string {
  return (
    (title || '')
      .toLowerCase()
      .replace(/\b[0-9a-f]{6,}\b/g, '') // sha-ish blobs
      .replace(/\b\d{4,}\b/g, '') // long numbers (PRs, runs)
      .replace(/\s+/g, ' ')
      .trim() +
    '|' +
    (repo || '')
  )
}

const DEDUP_WINDOW_MS = 60 * 60 * 1000 // 1 hour

export function fileHitl(input: Omit<HitlItem, 'id' | 'status' | 'createdAt'>): HitlItem {
  // Dedup window — if an open HITL with the same fingerprint already exists
  // (filed within the last hour), return that one instead of double-filing.
  // Avoids cron-retry storms that flood the inbox.
  const existing = readHitl()
  const fp = hitlFingerprint(input.title, input.repo)
  const since = Date.now() - DEDUP_WINDOW_MS
  const dup = existing.find(
    (h) =>
      h.status === 'open' &&
      h.createdAt >= since &&
      hitlFingerprint(h.title, h.repo) === fp,
  )
  if (dup) {
    // Re-ping the activity feed so the operator sees the recurrence count,
    // but don't double-file. Surface "still blocked, N occurrences".
    emitActivity(
      {
        kind: 'blocked',
        title: `HITL recur · ${input.title}`,
        detail: 'duplicate filing collapsed (within 1h window)',
        repo: input.repo,
        repoRoot: input.repoRoot,
        hitlId: dup.id,
        runId: input.runId,
        runSource: input.runSource,
      },
      { notify: false }, // don't re-fire the macOS notification
    )
    return dup
  }
  const item: HitlItem = { ...input, id: randomUUID(), status: 'open', createdAt: Date.now() }
  write([item, ...readHitl()])
  emitActivity(
    {
      kind: 'blocked',
      title: `HITL · ${item.title}`,
      detail: item.action || item.detail,
      repo: item.repo,
      repoRoot: item.repoRoot,
      // Drive the [Resolve] / [Tail run] inline-button rendering in
      // events.ts buttonsFor — without these, the TG ping is plain text.
      hitlId: item.id,
      runId: item.runId,
      runSource: item.runSource,
    },
    { notify: true },
  )
  // Belt-and-suspenders: HITL ALWAYS pings Telegram when configured, even if
  // the general activity-feed notify toggle is off.
  alwaysPingTelegram(item)
  return item
}

export function resolveHitl(id: string, resolved = true): boolean {
  const list = readHitl()
  const i = list.findIndex((h) => h.id === id)
  if (i < 0) return false
  list[i] = { ...list[i], status: resolved ? 'resolved' : 'open', resolvedAt: resolved ? Date.now() : undefined }
  write(list)
  return true
}

export function removeHitl(id: string): boolean {
  const before = readHitl()
  const after = before.filter((h) => h.id !== id)
  write(after)
  return after.length !== before.length
}

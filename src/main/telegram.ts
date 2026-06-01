import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { app } from 'electron'
import { telegramControlEnabled, readSettings, resolvedTemplateRepo } from './settings'
import {
  pickTemplateSource,
  sourceCheckoutRoot,
  templateDirCandidates,
  cloneTemplateToTmp,
} from './template'
import { readAgents, runAgent, listRuns, cancelRun, readAgentState, resetAgentState } from './agents'
import { readPersonas } from './personas'
import { parseCommand, classifyRunArgs, parsePollLine } from './telegram-parse'
import { sendUrl, getUpdatesUrl, parseUpdates, answerCallbackUrl, type TgInlineKeyboard } from './telegram-api'
import { listTickets, createTicket, updateTicket, getTicket } from './backlog'
import { readHitl, resolveHitl } from './hitl'
import { readSchedules } from './schedules'
import { listDisabled, setDisabled, setAllDisabled } from './agents-disabled'
import { listMrs, getMr } from './mrs'
import { readCronRuns } from './cron-runs'
import { readActivity } from './events'

// Two-way AFK control over Telegram: the user texts the bot from their phone to
// launch/cancel/inspect agent runs. The single authorized chat_id is the auth
// boundary — the bot acts on no one else. Native Bot API when a token+chat are
// configured; otherwise the legacy project-template scripts are used.
const POLL = join(homedir(), '.claude', 'bin', 'telegram-poll.sh') // legacy fallback
const NOTIFY = join(homedir(), '.claude', 'bin', 'telegram-notify.sh') // legacy fallback
const OFFSET_FILE = join(homedir(), '.config', 'TerMinal', 'telegram-offset')
const STATUS_EMOJI: Record<string, string> = {
  running: '⏳',
  done: '✅',
  failed: '⛔',
  canceled: '⏹',
  interrupted: '⚠️',
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

function checkoutRoots(): string[] {
  return [
    process.env.GT_TERMINAL_REPO || '',
    process.cwd(),
    app.getAppPath(),
    join(moduleDir, '..', '..'),
  ].filter(Boolean)
}

const nativeConfigured = () => {
  const t = readSettings().telegram
  return !!(t.botToken && t.chatId)
}
const readOffset = (): number => {
  try {
    return Number(readFileSync(OFFSET_FILE, 'utf8')) || 0
  } catch {
    return 0
  }
}
const writeOffset = (n: number) => {
  try {
    mkdirSync(dirname(OFFSET_FILE), { recursive: true })
    writeFileSync(OFFSET_FILE, String(n))
  } catch {
    /* best effort */
  }
}

type RepoCtx = { label: string; repoRoot: string }
let getRepos: () => RepoCtx[] = () => []
let getActive: () => RepoCtx | null = () => null

// /cd <repo> sticks across commands so the user can text /tickets and have it
// resolve without re-passing @repo every time. Single authorized chat_id means
// "per-chat" === "the user's selection." Module-level is fine.
let stickyRepo: RepoCtx | null = null

/** Wire in how to enumerate target repos (from the terminal's open sessions). */
export function configureTelegramControl(opts: { repos: () => RepoCtx[]; active: () => RepoCtx | null }) {
  getRepos = opts.repos
  getActive = opts.active
}

// Repos KNOWN to the harness but not necessarily open right now. We combine
// open sessions with whatever appears in schedules.json (every scheduled job
// has a repoRoot) and recent cron-run records. Lets the user text /tickets
// @vellum-project even when they don't have a session open on it.
function knownRepos(): RepoCtx[] {
  const map = new Map<string, RepoCtx>()
  for (const r of getRepos()) map.set(r.repoRoot, r)
  for (const s of readSchedules(Date.now())) {
    if (s.repoRoot && !map.has(s.repoRoot)) {
      map.set(s.repoRoot, { repoRoot: s.repoRoot, label: s.repoLabel || basename(s.repoRoot) })
    }
  }
  // CronRun stores worktree, not repoRoot — derive the repo path from the
  // worktree path (~/.config/TerMinal/cron-worktrees/<basename>/<branch>/).
  // We can't get the source root from that, so cron-only-known repos appear
  // as labels but won't resolve for filesystem ops. Skip them silently when
  // we can't backfill.
  for (const r of readCronRuns(undefined, 200)) {
    const label = r.repoLabel || ''
    if (!label) continue
    const matchedOpen = getRepos().find((x) => x.label === label || basename(x.repoRoot) === label)
    if (matchedOpen && !map.has(matchedOpen.repoRoot)) map.set(matchedOpen.repoRoot, matchedOpen)
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** Send a message — native Bot API when configured, else the legacy script.
 *  When `buttons` is supplied AND the native API is in use, attaches an
 *  inline keyboard (taps surface as callback_query updates which the poll
 *  loop routes via dispatchCallback). */
function reply(text: string, buttons?: TgInlineKeyboard) {
  const t = readSettings().telegram
  if (t.botToken && t.chatId) {
    const body: Record<string, unknown> = { chat_id: t.chatId, text }
    if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons }
    fetch(sendUrl(t.botToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {})
    return
  }
  if (existsSync(NOTIFY)) execFile(NOTIFY, [text], () => {})
}

/** Ack the callback query so the user's button stops spinning. Pass an optional
 *  short `text` for a transient toast (max 200 chars per the Bot API). */
function ack(queryId: string, text?: string) {
  const t = readSettings().telegram
  if (!t.botToken || !queryId) return
  fetch(answerCallbackUrl(t.botToken), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: queryId, ...(text ? { text } : {}) }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

let enabledAt = 0 // legacy-script path: ignore lines older than enable time
/** Called when the control toggle flips (and at startup if already on). Drains
 *  the backlog so we don't replay pre-enable messages, and acks when asked. */
export async function markTelegramControlEnabled(on: boolean, announce = true) {
  if (!on) {
    if (announce) reply('Remote control off.')
    return
  }
  if (nativeConfigured()) {
    // drain: advance the offset past anything already queued so old commands
    // sent while control was off are not executed on enable.
    const t = readSettings().telegram
    try {
      const res = await fetch(getUpdatesUrl(t.botToken, readOffset()), { signal: AbortSignal.timeout(15000) })
      if (res.ok) {
        const { nextOffset } = parseUpdates(await res.json(), t.chatId)
        if (nextOffset) writeOffset(nextOffset)
      }
    } catch {
      /* network — next poll catches up */
    }
    if (announce) reply('🤖 Remote control on. Send /help.')
    return
  }
  // legacy script fallback
  enabledAt = Date.now()
  if (existsSync(POLL)) execFile(POLL, () => announce && reply('🤖 Remote control on. Send /help.'))
  else if (announce) reply('Remote control on, but no Telegram bot is configured.')
}

let lastRunIds: string[] = [] // for /cancel <n> indexed off the last /runs

function resolveRepo(token?: string): RepoCtx | null {
  const repos = knownRepos()
  if (token) {
    const t = token.replace(/^@/, '').toLowerCase()
    return repos.find((r) => r.label.toLowerCase().includes(t)) || null
  }
  return stickyRepo || getActive() || repos[0] || null
}

const short = (root: string) => root.split('/').pop() || root

function cmdHelp() {
  reply(
    [
      '🤖 TerMinal — AFK control',
      '',
      'REPOS',
      '/repos · /cd <repo>',
      '',
      'RUNS · AGENTS',
      '/runs · /run <agent> [codex|claude] [persona] [pipeline] [@repo] · /cancel <n>',
      '/agents [@repo] · /state <agent> [@repo] · /reset-state <agent> [@repo]',
      '',
      'TICKETS',
      '/tickets [@repo] · /ticket <slug> · /ticket new <title>',
      '/close <slug>',
      '',
      'SCHEDULES',
      '/schedules · /pause <id|all> · /resume <id|all> · /runnow <id>',
      '',
      'HITL',
      '/hitl · /resolve <n> · /reopen <n>',
      '',
      'MRS · ACTIVITY · HARNESS',
      '/mrs [@repo] · /mr <iid> · /activity [N] · /harness · /status',
      '',
      'BACKGROUND',
      '/bg [@repo] [claude|codex] [model] <prompt>',
      '/bg list · /bg cancel <n|id>',
      '',
      'BUDGETS',
      '/budget · /budget set <usd> · /budget set <agent> <usd>',
      '/budget override <Nh|Nm|clear>',
      '',
      'INFRASTRUCTURE',
      '/sessions · /tail <id|n> · /rebuild · /about',
      '/install <agent> [@repo]   copy from project-template',
    ].join('\n'),
  )
}

function cmdRepos() {
  const repos = knownRepos()
  if (!repos.length) return reply('No repos known yet — open a session or create a schedule.')
  const active = stickyRepo || getActive()
  const open = new Set(getRepos().map((r) => r.repoRoot))
  reply(
    'Repos:\n' +
      repos
        .map(
          (r) =>
            `• ${r.label}${active && r.repoRoot === active.repoRoot ? ' (active)' : ''}` +
            `${open.has(r.repoRoot) ? '' : ' [closed]'}`,
        )
        .join('\n'),
  )
}

function cmdCd(args: string[]) {
  if (!args[0]) {
    if (!stickyRepo) return reply('No sticky repo. Usage: /cd <repo-name>')
    stickyRepo = null
    return reply('Cleared sticky repo.')
  }
  const r = resolveRepo(args[0])
  if (!r) return reply(`No repo matches "${args[0]}". /repos to list.`)
  stickyRepo = r
  reply(`📂 sticky repo → ${r.label}`)
}

function cmdAgents(repoToken?: string) {
  const repo = resolveRepo(repoToken)
  if (!repo) return reply('No repo — /repos to see options or open a session.')
  reply(`Agents · ${repo.label}:\n` + readAgents(repo.repoRoot).map((a) => `• ${a.id} — ${a.title}`).join('\n'))
}

function cmdRuns() {
  const runs = listRuns().slice(0, 8)
  if (!runs.length) return reply('No runs yet.')
  lastRunIds = runs.map((r) => r.id)
  reply(
    'Runs:\n' +
      runs
        .map((r, i) => `${i + 1}. ${STATUS_EMOJI[r.status] || ''} ${r.agentTitle} · ${short(r.repoRoot)} (${r.status})`)
        .join('\n'),
  )
}

function cmdStatus() {
  const running = listRuns().filter((r) => r.status === 'running')
  const repos = getRepos()
  reply(
    [
      `📊 ${running.length} running · ${repos.length} open repo(s)`,
      ...running.map((r) => `⏳ ${r.agentTitle} · ${short(r.repoRoot)}`),
    ].join('\n'),
  )
}

function cmdRun(args: string[]) {
  if (!args.length) return reply('Usage: /run <agent> [codex|claude] [persona] [pipeline] [@repo]')
  const { agentId, engine, pipeline, repoToken, personaCandidates } = classifyRunArgs(args)
  let persona = ''
  const repo = resolveRepo(repoToken)
  if (!repo) return reply('No repo — /repos to see options or open a session.')
  if (!readAgents(repo.repoRoot).some((a) => a.id === agentId))
    return reply(`Unknown agent "${agentId}". /agents to list.`)
  if (personaCandidates.length) {
    const ids = new Set(readPersonas(repo.repoRoot).map((p) => p.id))
    const match = personaCandidates.find((p) => ids.has(p))
    if (!match) return reply(`Unknown persona "${personaCandidates.join(' ')}". Valid: ${[...ids].join(', ')}`)
    persona = match
  }
  const r = runAgent(repo.repoRoot, agentId, engine, persona, pipeline)
  if ('error' in r) return reply(`⛔ ${r.error}`)
  reply(
    `✅ Spun out ${r.agentTitle} · ${engine}${persona ? ` · ${persona}` : ''}` +
      `${pipeline !== 'single' ? ` · ${pipeline}` : ''} on ${repo.label}.`,
  )
}

// --- tickets ---------------------------------------------------------------

let lastTicketSlugs: string[] = []

function cmdTickets(repoToken?: string) {
  const repo = resolveRepo(repoToken)
  if (!repo) return reply('No repo — /repos to list.')
  const list = listTickets(repo.repoRoot).filter((t) => t.status !== 'closed').slice(0, 12)
  if (!list.length) return reply(`No open tickets · ${repo.label}.`)
  lastTicketSlugs = list.map((t) => t.slug)
  reply(
    `Tickets · ${repo.label}:\n` +
      list
        .map(
          (t, i) =>
            `${i + 1}. #${t.id} ${t.title}` +
            ` · ${t.status}${t.priority ? ` · ${t.priority}` : ''}`,
        )
        .join('\n'),
  )
}

function cmdTicket(args: string[]) {
  if (!args.length) return reply('Usage: /ticket <slug> · /ticket new <title>')
  // /ticket new <title…>
  if (args[0].toLowerCase() === 'new') {
    const title = args.slice(1).join(' ').trim()
    if (!title) return reply('Usage: /ticket new <title>')
    const repo = resolveRepo()
    if (!repo) return reply('No repo — /repos to list.')
    const t = createTicket(repo.repoRoot, {
      title,
      status: 'open',
      priority: 'medium',
      type: 'feature',
      body: '',
    })
    return reply(`✅ Filed #${t.id} · ${t.title} (${t.slug}) on ${repo.label}`)
  }
  // /ticket <slug> | <n from /tickets>
  const repo = resolveRepo()
  if (!repo) return reply('No repo — /repos to list.')
  let slug = args[0]
  const n = parseInt(slug, 10)
  if (n && lastTicketSlugs[n - 1]) slug = lastTicketSlugs[n - 1]
  const t = getTicket(repo.repoRoot, slug)
  if (!t) return reply(`No ticket "${slug}" on ${repo.label}.`)
  reply(
    [
      `#${t.id} · ${t.title}`,
      `status: ${t.status} · priority: ${t.priority} · type: ${t.type}`,
      t.body ? `\n${t.body.slice(0, 600)}${t.body.length > 600 ? '\n…' : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function cmdClose(args: string[]) {
  if (!args[0]) return reply('Usage: /close <slug|n>')
  const repo = resolveRepo()
  if (!repo) return reply('No repo — /repos to list.')
  let slug = args[0]
  const n = parseInt(slug, 10)
  if (n && lastTicketSlugs[n - 1]) slug = lastTicketSlugs[n - 1]
  const ok = updateTicket(repo.repoRoot, slug, { status: 'closed' })
  if (!ok) return reply(`No ticket "${slug}".`)
  const t = getTicket(repo.repoRoot, slug)
  reply(`☑️ Closed${t ? ` #${t.id} · ${t.title}` : ` ${slug}`}`)
}

// --- schedules -------------------------------------------------------------

function cmdSchedules() {
  const list = readSchedules(Date.now()).slice(0, 14)
  if (!list.length) return reply('No schedules.')
  const disabled = new Set(listDisabled())
  reply(
    'Schedules:\n' +
      list
        .map(
          (s, i) =>
            `${i + 1}. ${s.agentTitle} · ${s.repoLabel}` +
            `${disabled.has(s.id) ? ' [paused]' : ''}` +
            `${s.lastStatus && s.lastStatus !== 'never' ? ` · ${s.lastStatus}` : ''}`,
        )
        .join('\n') +
      `\n\n/pause <id|n|all> · /resume <id|n|all> · /runnow <id|n>`,
  )
}

let lastScheduleIds: string[] = []

function scheduleIdFromToken(tok: string): string | null {
  // Accept either the full schedule id, an "n" index from the last /schedules,
  // or a partial-id prefix.
  const all = readSchedules(Date.now())
  lastScheduleIds = all.map((s) => s.id)
  const n = parseInt(tok, 10)
  if (n && all[n - 1]) return all[n - 1].id
  const exact = all.find((s) => s.id === tok)
  if (exact) return exact.id
  const prefix = all.find((s) => s.id.startsWith(tok))
  return prefix ? prefix.id : null
}

function cmdPause(args: string[], pause: boolean) {
  if (!args[0]) return reply(`Usage: /${pause ? 'pause' : 'resume'} <id|n|all>`)
  const all = readSchedules(Date.now())
  if (args[0].toLowerCase() === 'all') {
    setAllDisabled(all.map((s) => s.id), pause)
    return reply(`${pause ? '⏸' : '▶️'} ${pause ? 'paused' : 'resumed'} ${all.length} schedule(s).`)
  }
  const id = scheduleIdFromToken(args[0])
  if (!id) return reply('Unknown schedule — /schedules to list.')
  setDisabled(id, pause)
  const s = all.find((x) => x.id === id)
  reply(`${pause ? '⏸' : '▶️'} ${pause ? 'paused' : 'resumed'} · ${s?.agentTitle || id}`)
}

function cmdRunNow(args: string[]) {
  if (!args[0]) return reply('Usage: /runnow <id|n>')
  const id = scheduleIdFromToken(args[0])
  if (!id) return reply('Unknown schedule — /schedules to list.')
  const s = readSchedules(Date.now()).find((x) => x.id === id)
  if (!s) return reply('Schedule disappeared mid-call.')
  // Cron schedule's "run now" is just an in-process spawn of the same agent
  // against the same repoRoot. Bypasses the launchd cadence; runs immediately.
  const r = runAgent(s.repoRoot, s.agentId, s.engine)
  if ('error' in r) return reply(`⛔ ${r.error}`)
  reply(`▶️ Triggered ${s.agentTitle} · ${s.repoLabel}`)
}

// --- HITL ------------------------------------------------------------------

let lastHitlIds: string[] = []

function cmdHitl() {
  const open = readHitl().filter((h) => h.status === 'open').slice(0, 10)
  if (!open.length) return reply('🟢 No open HITL items.')
  lastHitlIds = open.map((h) => h.id)
  reply(
    'HITL · open:\n' +
      open
        .map(
          (h, i) =>
            `${i + 1}. ${h.title}` +
            (h.repo ? ` · ${h.repo}` : '') +
            (h.action ? `\n   → ${h.action}` : ''),
        )
        .join('\n'),
  )
}

function cmdResolveHitl(args: string[], resolved: boolean) {
  const n = parseInt(args[0] || '', 10)
  if (!n || n < 1) return reply(`Usage: /${resolved ? 'resolve' : 'reopen'} <n> (from /hitl)`)
  const id = lastHitlIds[n - 1]
  if (!id) return reply('No such #n — send /hitl first.')
  resolveHitl(id, resolved)
  reply(`${resolved ? '☑️ Resolved' : '↺ Reopened'} HITL #${n}.`)
}

// --- MRs -------------------------------------------------------------------

async function cmdMrs(repoToken?: string) {
  const repo = resolveRepo(repoToken)
  if (!repo) return reply('No repo — /repos to list.')
  const r = await listMrs(repo.repoRoot)
  if (r.error) return reply(`⛔ ${r.error}`)
  const open = r.mrs.filter((m) => m.state === 'opened').slice(0, 12)
  if (!open.length) return reply(`No open MRs · ${repo.label}.`)
  reply(
    `MRs · ${repo.label}:\n` +
      open.map((m) => `• !${m.iid} ${m.title}${m.draft ? ' [draft]' : ''}`).join('\n'),
  )
}

async function cmdMr(args: string[]) {
  const iid = parseInt(args[0] || '', 10)
  if (!iid) return reply('Usage: /mr <iid>')
  const repo = resolveRepo(args[1])
  if (!repo) return reply('No repo — /repos to list.')
  const d = await getMr(repo.repoRoot, iid)
  if (!d) return reply(`No MR !${iid} on ${repo.label}.`)
  reply(
    [
      `!${d.iid} · ${d.title}`,
      `state: ${d.state}${d.draft ? ' (draft)' : ''} · ${d.sourceBranch} → ${d.targetBranch || 'main'}`,
      d.webUrl,
    ].join('\n'),
  )
}

// --- agent state -----------------------------------------------------------

function cmdState(args: string[]) {
  const agentId = args[0]
  if (!agentId) return reply('Usage: /state <agent> [@repo]')
  const repo = resolveRepo(args[1])
  if (!repo) return reply('No repo — /repos to list.')
  const s = readAgentState(repo.repoRoot, agentId)
  if (!s.exists)
    return reply(`No state for ${agentId} · ${repo.label}. (First run hasn't written yet.)`)
  const at = typeof s.state.lastRunAt === 'number' ? new Date(s.state.lastRunAt).toLocaleString() : '?'
  reply(
    [
      `state · ${agentId} · ${repo.label}`,
      `last sha: ${(s.state.lastScannedSha as string)?.slice(0, 12) || '—'}` +
        `${s.state.lastScannedRef ? ` (${s.state.lastScannedRef})` : ''}`,
      `last at: ${at}`,
    ].join('\n'),
  )
}

function cmdResetState(args: string[]) {
  const agentId = args[0]
  if (!agentId) return reply('Usage: /reset-state <agent> [@repo]')
  const repo = resolveRepo(args[1])
  if (!repo) return reply('No repo — /repos to list.')
  const r = resetAgentState(repo.repoRoot, agentId)
  if ('error' in r) return reply(`⛔ ${r.error}`)
  reply(`🧹 Reset state · ${agentId} · ${repo.label}.`)
}

// --- runs: tail recent log lines -------------------------------------------

let lastRunIdsTail: string[] = [] // numeric-index → runId for /tail <n>

function tailRun(runIdOrToken: string) {
  // Accept full id, an "n" from the last /runs/listing, or a prefix.
  let runId = runIdOrToken
  const n = parseInt(runIdOrToken, 10)
  if (n && lastRunIds[n - 1]) runId = lastRunIds[n - 1]
  else if (n && lastRunIdsTail[n - 1]) runId = lastRunIdsTail[n - 1]
  // Try the cron-runs log file first (the canonical log for cron + the
  // path /tail can serve without holding state from in-process runs).
  const cronLog = join(homedir(), '.config', 'TerMinal', 'cron-runs', `${runId}.log`)
  let text = ''
  if (existsSync(cronLog)) {
    try {
      text = readFileSync(cronLog, 'utf8')
    } catch {
      /* fall through to in-process */
    }
  }
  if (!text) {
    const r = listRuns().find((x) => x.id === runId || x.id.startsWith(runId))
    if (r) text = r.output || '(no output yet)'
  }
  if (!text) return reply(`No log for ${runId.slice(0, 8)} (run not found)`)
  // Strip ANSI + keep last 30 lines so the message fits comfortably in a
  // Telegram bubble (4096-char limit; 30 lines = usually <2k chars).
  const lines = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').split('\n')
  const tail = lines.slice(-30).join('\n')
  reply(`🪵 tail · ${runId.slice(0, 8)}\n\n${tail}`)
}

function cmdTail(args: string[]) {
  if (!args[0]) return reply('Usage: /tail <runId|n>')
  tailRun(args[0])
}

// --- /sessions -------------------------------------------------------------

function cmdSessions() {
  const repos = getRepos()
  if (!repos.length) return reply('No open terminal sessions.')
  const active = getActive()
  reply(
    'Open sessions:\n' +
      repos
        .map(
          (r) =>
            `• ${r.label}${active && r.repoRoot === active.repoRoot ? ' (active)' : ''}`,
        )
        .join('\n'),
  )
}

// --- /about ----------------------------------------------------------------

function cmdAbout() {
  reply(
    [
      '🖥 TerMinal',
      `repos known: ${knownRepos().length} (${getRepos().length} open)`,
      `runs in-process: ${listRuns().length} total · ${listRuns().filter((r) => r.status === 'running').length} live`,
      `node ${process.version} · platform ${process.platform}`,
      `cwd: ${process.cwd()}`,
    ].join('\n'),
  )
}

// --- /rebuild --------------------------------------------------------------

let rebuildPid: number | null = null
function cmdRebuild() {
  if (rebuildPid) {
    try {
      process.kill(rebuildPid, 0)
      return reply('⚠️ Rebuild already running.')
    } catch {
      rebuildPid = null
    }
  }
  // Resolve the source checkout the same way the Settings panel does.
  const repoRoot = sourceCheckoutRoot(checkoutRoots(), join('bin', 'release'))
  if (!repoRoot) {
    return reply('⛔ bin/release not found — set GT_TERMINAL_REPO or run from the source checkout.')
  }
  reply('🔧 Rebuild kicked off — app will quit + relaunch when bin/release finishes.')
  // Detached child outlives the parent the script kills mid-flow. We don't
  // tail the log here — Telegram is chat, not a build console; the user can
  // /tail it from a re-launched app if they want to see it.
  try {
    const child = execFile(
      'bin/release',
      [],
      { cwd: repoRoot, env: process.env },
      () => {
        rebuildPid = null
      },
    )
    rebuildPid = child.pid || null
  } catch (e) {
    rebuildPid = null
    reply(`⛔ rebuild failed to start: ${(e as Error).message}`)
  }
}

// --- /install <agent> ------------------------------------------------------

function cmdInstall(args: string[]) {
  const agentId = args[0]
  if (!agentId) return reply('Usage: /install <agent> [@repo]')
  const repo = resolveRepo(args[1])
  if (!repo) return reply('No repo — /repos to list.')
  const src = pickTemplateSource({
    candidates: templateDirCandidates(resolvedTemplateRepo(), checkoutRoots()),
    marker: '.agents',
    templateRepo: resolvedTemplateRepo(),
    cloneToTmp: (r) => cloneTemplateToTmp(r, { tmpPrefix: 'gt-template-', marker: '.agents' }),
  })
  if ('error' in src) {
    return reply(`⛔ ${src.error}`)
  }
  try {
    const templateRoot = src.dir
    const srcSh = join(templateRoot, '.agents', `${agentId}.sh`)
    const srcJson = join(templateRoot, '.agents', `${agentId}.json`)
    if (!existsSync(srcSh)) return reply(`No ${agentId}.sh in project-template/.agents.`)
    const dstDir = join(repo.repoRoot, '.agents')
    mkdirSync(dstDir, { recursive: true })
    writeFileSync(join(dstDir, `${agentId}.sh`), readFileSync(srcSh, 'utf8'), { mode: 0o755 })
    if (existsSync(srcJson))
      writeFileSync(join(dstDir, `${agentId}.json`), readFileSync(srcJson, 'utf8'))
    reply(`📦 Installed ${agentId} into ${repo.label}/.agents/`)
  } catch (e) {
    reply(`⛔ install failed: ${(e as Error).message}`)
  } finally {
    src.cleanup?.()
  }
}

// --- /budget cap + override ------------------------------------------------

function cmdBudget(args: string[]) {
  const { readBudgets, setDailyCap, setAgentCap, setOverride } = require('./budgets') as typeof import('./budgets')
  const sub = args[0]?.toLowerCase()
  if (!sub) {
    const b = readBudgets()
    const { summaryFor } = require('./ai-runs') as typeof import('./ai-runs')
    const s = summaryFor('today')
    const lines = [
      `💰 Budget`,
      `today: $${s.totalUsd.toFixed(2)}${b.dailyTotalUsd > 0 ? ` / $${b.dailyTotalUsd.toFixed(2)} (${Math.round((s.totalUsd / b.dailyTotalUsd) * 100)}%)` : ' (no cap)'}`,
    ]
    if (Object.keys(b.perAgent).length) {
      lines.push('per-agent caps:')
      for (const [a, c] of Object.entries(b.perAgent)) {
        const spent = s.byAgent[a]?.usd || 0
        lines.push(`  ${a}: $${spent.toFixed(2)} / $${c.toFixed(2)}`)
      }
    }
    if (b.overrideUntil && b.overrideUntil > Date.now()) {
      const mins = Math.round((b.overrideUntil - Date.now()) / 60_000)
      lines.push(`override active for ${mins}m`)
    }
    return reply(lines.join('\n'))
  }
  if (sub === 'set') {
    const t1 = args[1]
    const t2 = args[2]
    // /budget set 25         — daily cap
    // /budget set docs 5     — per-agent cap
    const usd = parseFloat(t2 || t1 || '')
    if (!Number.isFinite(usd)) return reply('Usage: /budget set <usd>  ·  /budget set <agent> <usd>')
    if (t2) {
      setAgentCap(t1, usd)
      return reply(`✓ ${t1} cap set to $${usd.toFixed(2)}/day`)
    }
    setDailyCap(usd)
    return reply(`✓ daily cap set to $${usd.toFixed(2)}`)
  }
  if (sub === 'override') {
    // /budget override 2h  or  /budget override clear
    const dur = args[1] || '1h'
    if (dur === 'clear' || dur === '0') {
      setOverride(0)
      return reply('✓ override cleared')
    }
    const m = dur.match(/^(\d+)([hm])?$/)
    if (!m) return reply('Usage: /budget override <Nh|Nm|clear>')
    const n = parseInt(m[1], 10)
    const ms = (m[2] === 'm' ? n * 60_000 : n * 3_600_000)
    setOverride(ms)
    return reply(`✓ override active for ${dur}`)
  }
  reply('Usage: /budget · /budget set <usd> · /budget set <agent> <usd> · /budget override <Nh>')
}

// --- /bg fire and forget ---------------------------------------------------
//
// Spawns a detached agent in a worktree-scoped run. End-of-run watcher pings
// when the MR is ready. See src/main/bg-tasks.ts.

function cmdBg(args: string[]) {
  if (!args.length) {
    return reply(
      'Usage: /bg [<repo>] [claude|codex] [haiku|sonnet|opus|gpt-5] <prompt>\n' +
        '       /bg list · /bg cancel <n|id>',
    )
  }
  if (args[0] === 'list') return cmdBgList()
  if (args[0] === 'cancel') return cmdBgCancel(args.slice(1))

  // Parse repo / engine / model leading args
  let engine: 'claude' | 'codex' = 'claude'
  let model: string | undefined
  let repo: RepoCtx | null = null
  let promptStart = 0
  for (let i = 0; i < args.length; i++) {
    const tok = args[i].toLowerCase()
    if (tok === 'claude' || tok === 'codex') {
      engine = tok
      promptStart = i + 1
      continue
    }
    if (['haiku', 'sonnet', 'opus', 'gpt-5', 'gpt-5-codex', 'gpt-5-mini', 'o4-mini'].includes(tok)) {
      model = tok
      promptStart = i + 1
      continue
    }
    if (!repo) {
      const match = resolveRepo(tok)
      if (match) {
        repo = match
        promptStart = i + 1
        continue
      }
    }
    break
  }
  if (!repo) {
    // No repo specified — use current active or sticky
    repo = resolveRepo()
  }
  if (!repo) return reply('No repo — /repos to list.')
  const prompt = args.slice(promptStart).join(' ').trim()
  if (!prompt) return reply('Empty prompt.')

  // Lazy require to avoid pulling bg-tasks into telegram-parse tests.
  const { spawnBgTask } = require('./bg-tasks') as typeof import('./bg-tasks')
  const r = spawnBgTask({ repoRoot: repo.repoRoot, prompt, engine, model })
  if ('error' in r) return reply(`⛔ ${r.error}`)
  reply(
    `🌙 fired · ${repo.label} · ${engine}${model ? `/${model}` : ''}\n${r.label}\n\nI'll ping when the MR is ready.`,
  )
}

let lastBgIds: string[] = []
function cmdBgList() {
  const { listBgTasks } = require('./bg-tasks') as typeof import('./bg-tasks')
  const tasks = listBgTasks().slice(0, 10)
  if (!tasks.length) return reply('No background tasks.')
  lastBgIds = tasks.map((t) => t.id)
  const STATUS_EMOJI: Record<string, string> = {
    running: '⏳',
    done: '✅',
    failed: '⛔',
    canceled: '⏹',
    queued: '⌛',
  }
  reply(
    'Background tasks:\n' +
      tasks
        .map(
          (t, i) =>
            `${i + 1}. ${STATUS_EMOJI[t.status] || ''} ${t.repo} · ${t.label}` +
            (t.mrUrl ? `\n   → ${t.mrUrl}` : ''),
        )
        .join('\n'),
  )
}

function cmdBgCancel(args: string[]) {
  const tok = args[0]
  if (!tok) return reply('Usage: /bg cancel <n|id>')
  const n = parseInt(tok, 10)
  const id = n && lastBgIds[n - 1] ? lastBgIds[n - 1] : tok
  const { cancelBgTask } = require('./bg-tasks') as typeof import('./bg-tasks')
  const r = cancelBgTask(id)
  reply(r.ok ? `⏹ canceled ${id.slice(0, 8)}` : `cannot cancel: ${r.error}`)
}

// --- harness + activity ----------------------------------------------------

function cmdHarness() {
  const cfgDir = join(homedir(), '.config', 'TerMinal')
  let cronRunFiles = 0
  const cronRunsDir = join(cfgDir, 'cron-runs')
  try {
    if (existsSync(cronRunsDir))
      cronRunFiles = readdirSync(cronRunsDir).filter((f) => f.endsWith('.json')).length
  } catch {
    /* ignore */
  }
  const cronRuns = readCronRuns(undefined, 1000)
  const running = cronRuns.filter((r) => r.status === 'running').length
  const failed24h = cronRuns.filter(
    (r) => r.status === 'failed' && r.startedAt >= Date.now() - 86_400_000,
  ).length
  const paused = listDisabled().length
  const inProc = listRuns().filter((r) => r.status === 'running').length
  reply(
    [
      '🩺 Harness',
      `running: ${running} cron · ${inProc} in-proc`,
      `failed (24h): ${failed24h}`,
      `paused schedules: ${paused}`,
      `cron records: ${cronRunFiles}`,
    ].join('\n'),
  )
}

function cmdActivity(args: string[]) {
  const n = Math.max(1, Math.min(20, parseInt(args[0] || '', 10) || 8))
  const evs = readActivity(n)
  if (!evs.length) return reply('No activity yet.')
  reply(
    `Recent activity (${evs.length}):\n` +
      evs
        .map((e) => {
          const ago = Math.floor((Date.now() - e.ts) / 60_000)
          const when = ago < 1 ? 'just now' : ago < 60 ? `${ago}m` : `${Math.floor(ago / 60)}h`
          return `• ${e.kind} · ${e.title}${e.repo ? ` · ${e.repo}` : ''} (${when})`
        })
        .join('\n'),
  )
}

function cmdCancel(args: string[]) {
  const n = parseInt(args[0] || '', 10)
  if (!n || n < 1) return reply('Usage: /cancel <n> (the number from /runs)')
  const id = lastRunIds[n - 1]
  if (!id) return reply('No such run # — send /runs first.')
  reply(cancelRun(id) ? `⏹ Canceled run #${n}.` : `Run #${n} is not running.`)
}

// Natural-language fallback. If the message doesn't start with '/', ask
// haiku (free via Max) to translate it into a structured command. The
// translation is constrained to the existing command set — the LLM picks
// the command; we re-dispatch it through the same handler. Saves users
// from memorizing slash syntax on mobile.
async function translateNaturalLanguage(text: string): Promise<string | null> {
  if (text.startsWith('/')) return null
  // Tight prompt — model picks ONE command + minimal args. Falls back to
  // null if it can't translate confidently.
  const SYSTEM = `You translate the user's natural-language request into a TerMinal slash command. Output EXACTLY one command line starting with /, or "NONE" if the request doesn't match.

Available commands (with example syntax):
  /bg [@repo] [claude|codex] [haiku|sonnet|opus] <prompt>
  /run <agentId> [@repo] [engine] [persona] [pipeline]
  /tickets [@repo]
  /ticket <slug|n>
  /ticket new <title>
  /close <slug|n>
  /schedules
  /pause <id|all>
  /resume <id|all>
  /runnow <id>
  /hitl
  /resolve <n>
  /mrs [@repo]
  /mr <iid>
  /runs
  /cancel <n>
  /tail <runId|n>
  /sessions
  /status
  /harness
  /activity [N]
  /budget
  /budget set <usd>
  /repos
  /cd <repo>

Examples:
  "fix the flaky test in vellum" → /bg @vellum-project fix the flaky test
  "show me what's blocked" → /hitl
  "kill run 3" → /cancel 3
  "what's running" → /runs
  "how much have I spent today" → /budget

Reply with ONE LINE — either the command or NONE. No preamble, no explanation.`
  try {
    const { cheapCall } = (await import('./cheap-llm')) as typeof import('./cheap-llm')
    const res = await cheapCall({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ],
      model: 'haiku',
      maxTokens: 80,
      temperature: 0,
      timeoutMs: 8000,
    })
    if (!res.ok || !res.text) return null
    const line = res.text.trim().split('\n')[0].trim()
    if (line === 'NONE' || !line.startsWith('/')) return null
    return line
  } catch {
    return null
  }
}

async function handle(text: string) {
  // Natural-language pre-dispatch — if user typed free-form, translate via
  // haiku into a slash command, then fall through to the normal switch.
  if (!text.startsWith('/')) {
    const translated = await translateNaturalLanguage(text)
    if (translated) {
      reply(`🔀 → ${translated}`)
      text = translated
    } else {
      reply(`I don't know how to do that. Try /help.`)
      return
    }
  }
  const { cmd, args } = parseCommand(text)
  switch (cmd) {
    case '/help':
    case '/start':
      return cmdHelp()
    case '/repos':
      return cmdRepos()
    case '/cd':
      return cmdCd(args)
    case '/agents':
      return cmdAgents(args[0])
    case '/runs':
      return cmdRuns()
    case '/run':
      return cmdRun(args)
    case '/cancel':
      return cmdCancel(args)
    case '/status':
      return cmdStatus()
    case '/tickets':
      return cmdTickets(args[0])
    case '/ticket':
      return cmdTicket(args)
    case '/close':
      return cmdClose(args)
    case '/schedules':
      return cmdSchedules()
    case '/pause':
      return cmdPause(args, true)
    case '/resume':
      return cmdPause(args, false)
    case '/runnow':
      return cmdRunNow(args)
    case '/hitl':
      return cmdHitl()
    case '/resolve':
      return cmdResolveHitl(args, true)
    case '/reopen':
      return cmdResolveHitl(args, false)
    case '/mrs':
    case '/prs':
      return cmdMrs(args[0])
    case '/mr':
    case '/pr':
      return cmdMr(args)
    case '/state':
      return cmdState(args)
    case '/reset-state':
      return cmdResetState(args)
    case '/harness':
      return cmdHarness()
    case '/activity':
      return cmdActivity(args)
    case '/sessions':
      return cmdSessions()
    case '/tail':
      return cmdTail(args)
    case '/rebuild':
      return cmdRebuild()
    case '/about':
    case '/whoami':
      return cmdAbout()
    case '/install':
      return cmdInstall(args)
    case '/bg':
      return cmdBg(args)
    case '/budget':
      return cmdBudget(args)
    default:
      return reply(`Unknown command ${cmd}. Send /help.`)
  }
}

// Inline-button callback dispatcher. Callback data is small (max 64 bytes per
// the Bot API), so we use a colon-delimited scheme:
//   hitl:resolve:<hitlId>
//   hitl:reopen:<hitlId>
//   run:tail:<runId>
//   sched:pause:<id> · sched:resume:<id> · sched:runnow:<id>
//   ticket:close:<slug>
// Anything unrecognized acks and replies with a one-liner.
async function dispatchCallback(data: string, queryId: string) {
  const [domain, action, ...rest] = data.split(':')
  const id = rest.join(':')
  try {
    if (domain === 'hitl' && action === 'resolve') {
      const ok = resolveHitl(id, true)
      ack(queryId, ok ? 'Resolved' : 'Not found')
      reply(ok ? `☑️ Resolved HITL ${id.slice(0, 8)}` : `Could not resolve ${id.slice(0, 8)}`)
      return
    }
    if (domain === 'hitl' && action === 'reopen') {
      const ok = resolveHitl(id, false)
      ack(queryId, ok ? 'Reopened' : 'Not found')
      reply(ok ? `↺ Reopened HITL ${id.slice(0, 8)}` : `Could not reopen ${id.slice(0, 8)}`)
      return
    }
    if (domain === 'run' && action === 'tail') {
      ack(queryId)
      tailRun(id)
      return
    }
    if (domain === 'run' && action === 'cancel') {
      const ok = cancelRun(id)
      ack(queryId, ok ? 'Canceled' : 'Not running')
      reply(ok ? `⏹ Canceled ${id.slice(0, 8)}` : `Run ${id.slice(0, 8)} not running`)
      return
    }
    if (domain === 'sched' && (action === 'pause' || action === 'resume')) {
      setDisabled(id, action === 'pause')
      const s = readSchedules(Date.now()).find((x) => x.id === id)
      ack(queryId, action === 'pause' ? 'Paused' : 'Resumed')
      reply(`${action === 'pause' ? '⏸ paused' : '▶️ resumed'} · ${s?.agentTitle || id.slice(0, 8)}`)
      return
    }
    if (domain === 'sched' && action === 'runnow') {
      const s = readSchedules(Date.now()).find((x) => x.id === id)
      if (!s) {
        ack(queryId, 'Unknown')
        return
      }
      const r = runAgent(s.repoRoot, s.agentId, s.engine)
      ack(queryId, 'error' in r ? r.error : 'Triggered')
      if ('error' in r) reply(`⛔ ${r.error}`)
      else reply(`▶️ Triggered ${s.agentTitle} · ${s.repoLabel}`)
      return
    }
    ack(queryId, 'Unknown action')
  } catch (e) {
    ack(queryId, 'error')
    reply(`⛔ callback error: ${(e as Error).message}`)
  }
}

let polling = false
/** One poll cycle — fetch new inbound messages + callback taps and dispatch.
 *  No-ops cheaply when control is off, so it's safe to call on a fixed timer. */
export async function pollTelegramOnce() {
  if (polling || !telegramControlEnabled()) return
  if (nativeConfigured()) {
    polling = true
    const t = readSettings().telegram
    try {
      const res = await fetch(getUpdatesUrl(t.botToken, readOffset()), { signal: AbortSignal.timeout(15000) })
      if (res.ok) {
        const { messages, callbacks, nextOffset } = parseUpdates(await res.json(), t.chatId)
        if (nextOffset) writeOffset(nextOffset)
        for (const m of messages) await handle(m.text)
        for (const c of callbacks) await dispatchCallback(c.data, c.queryId)
      }
    } catch {
      /* network — retry next tick */
    } finally {
      polling = false
    }
    return
  }
  // legacy script fallback
  if (!existsSync(POLL)) return
  polling = true
  execFile(POLL, { timeout: 15_000, encoding: 'utf8' }, (err, stdout) => {
    polling = false
    if (err || !stdout) return
    for (const line of stdout.split('\n')) {
      const cmd = parsePollLine(line, enabledAt)
      if (cmd) handle(cmd).catch(() => {})
    }
  })
}

/** Settings "Test" button: send a one-off confirmation, surfacing API errors. */
export async function testTelegram(): Promise<{ ok: boolean; error?: string }> {
  const t = readSettings().telegram
  if (!t.botToken || !t.chatId) return { ok: false, error: 'Set both the bot token and chat id first.' }
  try {
    const res = await fetch(sendUrl(t.botToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text: '✅ TerMinal connected.' }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Telegram API ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` }
    }
    const j = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
    if (j && j.ok === false) return { ok: false, error: j.description || 'Telegram rejected the message' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

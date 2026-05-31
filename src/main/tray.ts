// Menu-bar fleet status (NSStatusItem via Electron's Tray API). Surfaces
// HITL / cron-failure / budget state at a glance regardless of whether the
// main window is open. Polls existing data — no new backend.
//
// Visual state:
//   🟢 normal       — no HITL, no recent failures, spend < 50% of cap
//   🟡 warn         — some HITL, paused schedules, or > 50% spend
//   🔴 needs-action — open HITL items, recent cron failure, or > 90% spend

import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { readHitl } from './hitl'
import { readCronRuns } from './cron-runs'
import { listRuns as listAgentRuns } from './agents'
import { listDisabled } from './agents-disabled'
import { summaryFor } from './ai-runs'

let tray: Tray | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

type State = 'normal' | 'warn' | 'needs-action'

function emoji(state: State): string {
  return state === 'normal' ? '🟢' : state === 'warn' ? '🟡' : '🔴'
}

// We render the tray image from text — a colored circle is the simplest
// always-visible signal that respects light/dark menu bars without needing
// PNG assets. macOS Big Sur+ shows emoji in the menu bar fine.
function imageFor(state: State): Electron.NativeImage {
  // Template image of just a unicode dot — simpler than asset packs
  const img = nativeImage.createFromDataURL(
    `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18'><circle cx='9' cy='9' r='5' fill='${
      state === 'normal' ? '%2351c878' : state === 'warn' ? '%23eab308' : '%23ef4444'
    }'/></svg>`,
  )
  img.setTemplateImage(false) // colored circle, not a template
  return img
}

type Snapshot = {
  hitlOpen: number
  cronRunning: number
  cronFailed24h: number
  inProcRunning: number
  schedulesPaused: number
  spendTodayUsd: number
  state: State
}

function snapshot(): Snapshot {
  const hitlOpen = readHitl().filter((h) => h.status === 'open').length
  const cron = readCronRuns(undefined, 1000)
  const cronRunning = cron.filter((r) => r.status === 'running').length
  const dayAgo = Date.now() - 86_400_000
  const cronFailed24h = cron.filter((r) => r.status === 'failed' && r.startedAt >= dayAgo).length
  const inProcRunning = listAgentRuns().filter((r) => r.status === 'running').length
  const schedulesPaused = listDisabled().length
  const spend = summaryFor('today').totalUsd

  let state: State = 'normal'
  if (hitlOpen > 0 || cronFailed24h > 0 || spend > 20) state = 'needs-action'
  else if (schedulesPaused > 0 || spend > 10) state = 'warn'

  return { hitlOpen, cronRunning, cronFailed24h, inProcRunning, schedulesPaused, spendTodayUsd: spend, state }
}

function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 10) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2).replace(/\.?0+$/, '')}`
}

function tooltipFor(s: Snapshot): string {
  const parts: string[] = []
  if (s.hitlOpen > 0) parts.push(`${s.hitlOpen} HITL`)
  if (s.spendTodayUsd > 0) parts.push(fmtUsd(s.spendTodayUsd))
  if (s.cronRunning + s.inProcRunning > 0)
    parts.push(`${s.cronRunning + s.inProcRunning} running`)
  if (s.cronFailed24h > 0) parts.push(`${s.cronFailed24h} failed`)
  if (parts.length === 0) parts.push('idle')
  return `TerMinal · ${parts.join(' · ')}`
}

function focusMain() {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) {
    wins[0].show()
    wins[0].focus()
    app.focus({ steal: true })
  }
}

// Send a synthetic nav event to the renderer so opening the menu and choosing
// "View HITL" jumps to the right tab on focus.
function focusAndNav(tabId: string) {
  focusMain()
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  win.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('gt:nav', { detail: { tabId: ${JSON.stringify(
      tabId,
    )} } }))`,
  )
}

function buildMenu(s: Snapshot): Electron.Menu {
  const template: Electron.MenuItemConstructorOptions[] = []

  // Top status line (disabled label-only)
  template.push({ label: `TerMinal · ${emoji(s.state)} ${tooltipFor(s).replace('TerMinal · ', '')}`, enabled: false })
  template.push({ type: 'separator' })

  // HITL row — only shown when there's something
  if (s.hitlOpen > 0) {
    template.push({
      label: `${s.hitlOpen} HITL pending`,
      click: () => focusAndNav('hitl'),
    })
  }

  if (s.spendTodayUsd > 0) {
    template.push({
      label: `${fmtUsd(s.spendTodayUsd)} spent today`,
      click: () => focusAndNav('factory'),
    })
  }

  if (s.cronRunning + s.inProcRunning > 0) {
    template.push({
      label: `${s.cronRunning + s.inProcRunning} runs in flight`,
      click: () => focusAndNav('runs'),
    })
  }

  if (s.cronFailed24h > 0) {
    template.push({
      label: `${s.cronFailed24h} cron failure(s) in 24h`,
      click: () => focusAndNav('runs'),
    })
  }

  if (s.schedulesPaused > 0) {
    template.push({
      label: `${s.schedulesPaused} schedule(s) paused`,
      click: () => focusAndNav('schedules'),
    })
  }

  if (template.length > 2) {
    template.push({ type: 'separator' })
  }

  template.push({ label: 'Open TerMinal', click: () => focusMain() })
  template.push({ type: 'separator' })
  template.push({ label: 'Quit', click: () => app.quit() })

  return Menu.buildFromTemplate(template)
}

function rebuild() {
  if (!tray) return
  try {
    const s = snapshot()
    tray.setImage(imageFor(s.state))
    tray.setToolTip(tooltipFor(s))
    tray.setContextMenu(buildMenu(s))
    // Dock badge mirrors HITL count
    if (s.hitlOpen > 0) app.dock?.setBadge(String(s.hitlOpen))
    else app.dock?.setBadge('')
  } catch {
    /* best effort */
  }
}

export function startMenuBar(): void {
  if (tray) return
  try {
    tray = new Tray(imageFor('normal'))
    tray.setToolTip('TerMinal · starting…')
    rebuild()
    pollTimer = setInterval(rebuild, 5000)
  } catch (e) {
    console.warn('[gt] tray init failed:', e)
  }
}

export function stopMenuBar(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  tray?.destroy()
  tray = null
  app.dock?.setBadge('')
}

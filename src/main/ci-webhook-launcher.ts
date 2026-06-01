// Starts the harness dashboard webhook shim when TerMinal opens.
// The server is a standalone Bun process (dashboard/src/server.ts) — no Electron
// imports in the hot path — so curl/webhook tests work without the app bundle.

import { spawn as cpSpawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const moduleDir = dirname(fileURLToPath(import.meta.url))

function harnessConfigExists(): boolean {
  if (process.env.GT_HARNESS_DIR) {
    return existsSync(join(process.env.GT_HARNESS_DIR, 'prs', 'config.yml'))
  }
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.config', 'TerMinal', 'settings.json'), 'utf8'))
    const h = typeof s.harnessDir === 'string' ? s.harnessDir : ''
    return h ? existsSync(join(h, 'prs', 'config.yml')) : false
  } catch {
    return false
  }
}

let dashboardProc: ReturnType<typeof cpSpawn> | null = null

function dashboardServerPath(): string {
  const packaged = join(process.resourcesPath || '', 'dashboard-server.ts')
  if (process.resourcesPath && existsSync(packaged)) return packaged
  const dev = join(moduleDir, '../../dashboard/src/server.ts')
  if (existsSync(dev)) return dev
  return ''
}

/** Start :4848 webhook receiver when prs/config.yml exists. Idempotent. */
export function startCiWebhookDashboard(): { started: boolean; reason?: string } {
  if (dashboardProc) return { started: true }
  if (!harnessConfigExists()) return { started: false, reason: 'no prs/config.yml (harnessDir unset or missing config)' }

  const serverTs = dashboardServerPath()
  if (!serverTs) return { started: false, reason: 'dashboard server script not found' }

  const bun = process.env.BUN_BIN || 'bun'
  dashboardProc = cpSpawn(bun, [serverTs], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  dashboardProc.stdout?.on('data', (d) => process.stdout.write(`[dashboard] ${d}`))
  dashboardProc.stderr?.on('data', (d) => process.stderr.write(`[dashboard] ${d}`))
  dashboardProc.on('exit', () => {
    dashboardProc = null
  })
  return { started: true }
}

export function stopCiWebhookDashboard(): void {
  if (!dashboardProc?.pid) return
  try {
    dashboardProc.kill('SIGTERM')
  } catch {
    /* already dead */
  }
  dashboardProc = null
}

// Detached spawn of .agents/ci-watchdog.sh — mirrors the ticket #5 contract.
// No Electron imports; callable from the dashboard Bun server.

import { spawn as cpSpawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

export type WatchdogEnv = {
  repoRoot: string
  pipelineId: string
  mrIid: string
  branch: string
}

const TERMINAL_BIN = join(homedir(), '.config', 'TerMinal', 'bin')

export function ciWatchdogScript(repoRoot: string): string | null {
  const p = join(repoRoot, '.agents', 'ci-watchdog.sh')
  return existsSync(p) ? p : null
}

export function spawnCiWatchdog(env: WatchdogEnv): { ok: true; pid: number } | { ok: false; error: string } {
  const script = ciWatchdogScript(env.repoRoot)
  if (!script) return { ok: false, error: `no .agents/ci-watchdog.sh in ${env.repoRoot}` }

  const child = cpSpawn(script, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PATH: `${TERMINAL_BIN}:${process.env.PATH || ''}`,
      TERMINAL_REPO: env.repoRoot,
      TERMINAL_AGENT_ID: 'ci-watchdog',
      CI_PIPELINE_ID: env.pipelineId,
      CI_MR_IID: env.mrIid,
      CI_BRANCH: env.branch,
    },
  })
  child.unref()
  if (!child.pid) return { ok: false, error: 'spawn failed' }
  return { ok: true, pid: child.pid }
}

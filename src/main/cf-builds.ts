import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { readSettings } from './settings'

// events.ts pulls in electron — lazy-load it inside the poller so this module's
// pure helpers (workerNameFromWrangler/selectNewDeployments) stay unit-testable.

// Read-only Cloudflare Workers deployment poller. The fleet's real CD moved to
// Cloudflare (Workers Builds), so a merged PR isn't a shipped one — this turns
// a new Workers deployment into a `kind:'deploy'` activity event so the feed,
// tray, and Factory tab can see "actually shipped".
//
// OFF by default: does nothing until BOTH a Cloudflare API token + account id
// are set in Settings AND a watch list exists. First sight of a worker only
// seeds the seen-set (we never backfill its whole deploy history as "new").

const CFG = join(homedir(), '.config', 'TerMinal')
const WATCH_FILE = join(CFG, 'cf-builds.json') // opt-in: { "workers": [{ "name": "...", "repo": "..." }] }
const SEEN_FILE = join(CFG, 'cf-builds-seen.json') // { [workerName]: deploymentId[] }

/** Pure: the worker `name` from a wrangler config (jsonc or toml), or ''. */
export function workerNameFromWrangler(text: string): string {
  const m = text.match(/(?:^|[\n{,])\s*"?name"?\s*[:=]\s*"([^"]+)"/)
  return m ? m[1] : ''
}

/** Pure: deployments whose id isn't in the seen set, original order kept. */
export function selectNewDeployments<T extends { id: string }>(deployments: T[], seen: string[]): T[] {
  const s = new Set(seen)
  return deployments.filter((d) => !s.has(d.id))
}

export type CfDeployment = { id: string; createdOn?: string }
type Watch = { name: string; repo?: string }

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

function readWatch(): Watch[] {
  const cfg = readJson<{ workers?: Watch[] }>(WATCH_FILE, {})
  return (cfg.workers || []).filter((w) => w && typeof w.name === 'string' && w.name)
}

function writeSeen(seen: Record<string, string[]>): void {
  try {
    mkdirSync(dirname(SEEN_FILE), { recursive: true })
    writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2))
  } catch {
    /* best effort */
  }
}

/** Isolated network call — the only impure CF dependency. Returns [] on any error. */
async function fetchDeployments(accountId: string, name: string, token: string): Promise<CfDeployment[]> {
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/deployments`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return []
    const j: any = await r.json()
    const deps = j?.result?.deployments ?? j?.result ?? []
    return (Array.isArray(deps) ? deps : [])
      .map((d: any) => ({ id: String(d.id ?? d.deployment_id ?? ''), createdOn: d.created_on }))
      .filter((d: CfDeployment) => d.id)
  } catch {
    return []
  }
}

/** One poll pass. No-op unless token + accountId + a watch list are all present. */
export async function pollCfBuilds(): Promise<void> {
  const { apiToken, accountId } = readSettings().cloudflare
  if (!apiToken || !accountId) return
  const watch = readWatch()
  if (!watch.length) return

  const seen = readJson<Record<string, string[]>>(SEEN_FILE, {})
  const { emitActivity } = await import('./events')
  let changed = false

  for (const w of watch) {
    const deps = await fetchDeployments(accountId, w.name, apiToken)
    if (!deps.length) continue
    // First sight: seed without emitting so we don't flood the feed with history.
    if (!seen[w.name]) {
      seen[w.name] = deps.map((d) => d.id)
      changed = true
      continue
    }
    const fresh = selectNewDeployments(deps, seen[w.name])
    for (const d of fresh) {
      emitActivity({
        kind: 'deploy',
        title: `Deployed · ${w.name}`,
        detail: d.id.slice(0, 8),
        repo: w.repo || w.name,
      })
    }
    if (fresh.length) {
      seen[w.name] = [...seen[w.name], ...fresh.map((d) => d.id)].slice(-200)
      changed = true
    }
  }

  if (changed) writeSeen(seen)
}

/** Start the poll loop (called once at app-ready). Cheap no-op when unconfigured. */
export function startCfBuildsPoll(intervalMs = 5 * 60_000): NodeJS.Timeout {
  void pollCfBuilds()
  return setInterval(() => void pollCfBuilds(), intervalMs)
}

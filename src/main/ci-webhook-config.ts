// Per-repo CI webhook secrets + roots. Primary source: <harnessDir>/prs/config.yml
// (fleet harness). Fallback: ~/.config/TerMinal/ci-webhook-repos.json when
// harnessDir is unset.
//
// YAML shape (prs/config.yml):
//   repos:
//     TerMinal:
//       root: /abs/path/to/repo
//       ci_webhook_secret: <gitlab-webhook-secret-token>

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolvedHarnessDir } from './settings'

export type CiWebhookRepoConfig = {
  /** Repo slug used in /api/ci-webhook/:repo */
  slug: string
  /** Absolute path to the git checkout */
  root: string
  /** GitLab X-Gitlab-Token (or HMAC key) for this repo */
  ci_webhook_secret: string
}

const FALLBACK_FILE = join(homedir(), '.config', 'TerMinal', 'ci-webhook-repos.json')

/** Minimal YAML reader for the `repos:` block in prs/config.yml — no full YAML dep. */
export function parsePrsConfigYaml(raw: string): CiWebhookRepoConfig[] {
  const out: CiWebhookRepoConfig[] = []
  let inRepos = false
  let curSlug = ''
  let cur: Partial<CiWebhookRepoConfig> = {}

  const flush = () => {
    if (curSlug && cur.root && cur.ci_webhook_secret) {
      out.push({
        slug: curSlug,
        root: cur.root,
        ci_webhook_secret: cur.ci_webhook_secret,
      })
    }
    curSlug = ''
    cur = {}
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (/^repos:\s*$/.test(trimmed)) {
      inRepos = true
      continue
    }
    if (!inRepos) continue

    const repoMatch = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/)
    if (repoMatch) {
      flush()
      curSlug = repoMatch[1]
      continue
    }
    const kv = trimmed.match(/^([a-z_]+):\s*(.+)$/)
    if (kv && curSlug) {
      const val = kv[2].replace(/^["']|["']$/g, '')
      if (kv[1] === 'root') cur.root = val
      if (kv[1] === 'ci_webhook_secret') cur.ci_webhook_secret = val
    }
  }
  flush()
  return out
}

function readFallbackJson(): CiWebhookRepoConfig[] {
  if (!existsSync(FALLBACK_FILE)) return []
  try {
    const raw = JSON.parse(readFileSync(FALLBACK_FILE, 'utf8')) as {
      repos?: Record<string, { root?: string; ci_webhook_secret?: string }>
    }
    const repos = raw.repos || {}
    return Object.entries(repos)
      .filter(([, v]) => v?.root && v?.ci_webhook_secret)
      .map(([slug, v]) => ({
        slug,
        root: v!.root!,
        ci_webhook_secret: v!.ci_webhook_secret!,
      }))
  } catch {
    return []
  }
}

/** Load all configured repos, keyed by slug (case-sensitive). */
export function loadCiWebhookRepos(): Map<string, CiWebhookRepoConfig> {
  const map = new Map<string, CiWebhookRepoConfig>()
  const harness = resolvedHarnessDir()
  if (harness) {
    const yml = join(harness, 'prs', 'config.yml')
    if (existsSync(yml)) {
      for (const r of parsePrsConfigYaml(readFileSync(yml, 'utf8'))) {
        map.set(r.slug, r)
      }
    }
  }
  for (const r of readFallbackJson()) {
    if (!map.has(r.slug)) map.set(r.slug, r)
  }
  return map
}

export function repoRootFor(slug: string, repos = loadCiWebhookRepos()): string | null {
  return repos.get(slug)?.root ?? null
}

export function secretForRepo(slug: string, repos = loadCiWebhookRepos()): string | null {
  return repos.get(slug)?.ci_webhook_secret ?? null
}

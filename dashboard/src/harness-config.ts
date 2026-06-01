// Reads per-repo webhook config from <harnessDir>/prs/config.yml.
// Kept in dashboard/ (not src/main/) so the webhook shim stays a tiny,
// standalone Bun process — no Electron imports.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type RepoHarnessEntry = {
  /** Repo slug used in /api/ci-webhook/:repo (basename, case-insensitive). */
  slug: string
  /** Absolute path to the repo checkout. */
  root: string
  /** Shared secret for webhook signature verification. */
  ciWebhookSecret: string
}

export type HarnessConfig = {
  repos: RepoHarnessEntry[]
}

function settingsHarnessDir(): string {
  if (process.env.GT_HARNESS_DIR) return process.env.GT_HARNESS_DIR
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.config', 'TerMinal', 'settings.json'), 'utf8'))
    return typeof s.harnessDir === 'string' ? s.harnessDir : ''
  } catch {
    return ''
  }
}

/** Minimal YAML parser for the flat `repos:` map we own — no generic YAML dep. */
export function parseHarnessConfigYaml(raw: string): HarnessConfig {
  const repos: RepoHarnessEntry[] = []
  const lines = raw.split(/\r?\n/)
  let currentSlug: string | null = null
  let current: Partial<RepoHarnessEntry> = {}

  const flush = () => {
    if (!currentSlug) return
    if (current.root && current.ciWebhookSecret) {
      repos.push({
        slug: currentSlug,
        root: current.root,
        ciWebhookSecret: current.ciWebhookSecret,
      })
    }
    currentSlug = null
    current = {}
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const repoMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/)
    if (repoMatch && !trimmed.startsWith('repos:')) {
      flush()
      currentSlug = repoMatch[1]
      continue
    }
    const kv = trimmed.match(/^(\w+):\s*(.+)$/)
    if (!kv || !currentSlug) continue
    const val = kv[2].replace(/^["']|["']$/g, '')
    if (kv[1] === 'root') current.root = val
    if (kv[1] === 'ci_webhook_secret') current.ciWebhookSecret = val
  }
  flush()
  return { repos }
}

export function configPath(): string | null {
  const harness = settingsHarnessDir()
  if (!harness) return null
  const p = join(harness, 'prs', 'config.yml')
  return existsSync(p) ? p : null
}

export function loadHarnessConfig(): HarnessConfig {
  const p = configPath()
  if (!p) return { repos: [] }
  try {
    return parseHarnessConfigYaml(readFileSync(p, 'utf8'))
  } catch {
    return { repos: [] }
  }
}

export function repoRootFor(slug: string, cfg: HarnessConfig = loadHarnessConfig()): string | null {
  const target = slug.toLowerCase()
  for (const r of cfg.repos) {
    if (r.slug.toLowerCase() === target) return r.root
  }
  return null
}

export function webhookSecretFor(slug: string, cfg: HarnessConfig = loadHarnessConfig()): string | null {
  const target = slug.toLowerCase()
  for (const r of cfg.repos) {
    if (r.slug.toLowerCase() === target) return r.ciWebhookSecret
  }
  return null
}

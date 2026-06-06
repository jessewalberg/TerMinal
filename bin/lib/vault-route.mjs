// vault-route.mjs — repo↔vault routing for the consolidated ticket writers
// (vault Cross-Project ADR-0002). Zero-dep like backlog-core.mjs; installed
// alongside the deployed scripts by the bin/lib installer.
//
// Forward: resolveRoute(repoRoot, settings, env) -> { mode, vaultPath, slug }
// Reverse: dirsForSlug(slug, settings) -> existing checkout dirs (one-to-many)
// — the projection needs slug→dir and the forward resolver cannot be
// inverted safely (Schema naming exceptions + multi-checkout slugs).
import { existsSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

const DEFAULT_VAULT_PATH = '/Volumes/home-ext/projects/programming-vault'
const DEFAULT_PROJECTS_DIR = '/Volumes/home-ext/projects'

// Checkout-dir basename → vault slug (Schema "Naming Conventions").
// jessewalberg.com-hitl is deliberately ABSENT: it is its own vault project.
const SLUG_EXCEPTIONS = {
  'how-we-homeschool': 'howwehomeschool',
  'weekly-commits': '15five',
  'childcare-transparency': 'howverydareyou',
}

// Vault slug → candidate checkout-dir basenames (filtered by existence).
const DIR_CANDIDATES = {
  howwehomeschool: ['howwehomeschool', 'how-we-homeschool'],
  '15five': ['15five', 'weekly-commits'],
  howverydareyou: ['howverydareyou', 'childcare-transparency'],
  'jessewalberg.com': ['jessewalberg.com', 'jessewalberg.com-hitl'],
}

export function resolveRoute(repoRoot, settings = {}, env = {}) {
  let resolved = repoRoot
  try {
    resolved = realpathSync(repoRoot) // symlinked checkouts dedup to their target
  } catch {
    /* path may not exist (tests, detached worktrees) — use as given */
  }
  const base = basename(resolved)
  const slug = SLUG_EXCEPTIONS[base] ?? base

  const vaultPath =
    String(env.GT_VAULT_PATH ?? '').trim() ||
    String(settings.vaultPath ?? '').trim() ||
    DEFAULT_VAULT_PATH

  // Carve-out membership is owner-config ONLY (settings.vaultCarveOuts) —
  // never inferred from the GitHub org or disk shape (ADR-0002).
  const carveOuts = settings.vaultCarveOuts ?? {}
  const mode = (carveOuts.template ?? []).includes(slug)
    ? 'template'
    : (carveOuts.collaborator ?? []).includes(slug)
      ? 'collaborator'
      : 'vault'

  return { mode, vaultPath, slug }
}

export function dirsForSlug(slug, settings = {}) {
  const projectsDir =
    String(settings.projectsDir ?? '').trim() || DEFAULT_PROJECTS_DIR
  const candidates = DIR_CANDIDATES[slug] ?? [slug]
  return candidates
    .map((name) => join(projectsDir, name))
    .filter((path) => existsSync(path))
}

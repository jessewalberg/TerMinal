// Resolve a usable project-template directory for bootstrap, scaffold, and
// telegram /install. The packaged app doesn't bundle templates/project-template
// (electron-builder only ships out/ + package.json), so when no local checkout
// exposes the probe marker we fall back to cloning the configured template
// repo into a temp dir. The fs probe + git clone live here so resolution stays
// unit-testable; callers inject optional refresh hooks (scaffold's git pull).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type TemplateSource = { dir: string; cleanup?: () => void }
export type TemplatePick = TemplateSource | { error: string }

/** True for `scheme://` URLs (http(s), ssh, git, file). An scp-style remote like
 *  `git@host:org/repo` is NOT a scheme:// URL, so callers treat it as a clone
 *  target rather than a local directory. */
export function isTemplateUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

/** First repo root whose path contains `marker` (relative to root). */
export function sourceCheckoutRoot(candidates: string[], marker: string): string {
  for (const c of candidates.filter(Boolean)) {
    if (existsSync(join(c, marker))) return c
  }
  return ''
}

/** Local template dirs to probe: configured local path, then each root's submodule. */
export function templateDirCandidates(configured: string, roots: string[]): string[] {
  const dirs: string[] = []
  if (configured && !isTemplateUrl(configured)) dirs.push(configured)
  for (const r of roots.filter(Boolean)) {
    dirs.push(join(r, 'templates', 'project-template'))
  }
  return dirs
}

/** Shallow-clone the template repo; null when clone fails or `marker` is missing. */
export function cloneTemplateToTmp(
  repo: string,
  opts: { tmpPrefix: string; marker: string },
): TemplateSource | null {
  // Reject git-style option prefixes — a settings value like
  // `--config=core.sshCommand=…` would otherwise be parsed as clone flags.
  if (!repo || repo.startsWith('-')) return null
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), opts.tmpPrefix))
    execFileSync('git', ['clone', '--depth', '1', '--', repo, dir], {
      stdio: 'ignore',
      timeout: 60_000,
    })
    if (!existsSync(join(dir, opts.marker))) {
      rmSync(dir, { recursive: true, force: true })
      return null
    }
    const cloneDir = dir
    return { dir: cloneDir, cleanup: () => rmSync(cloneDir, { recursive: true, force: true }) }
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true })
    return null
  }
}

/** First local candidate dir that contains `marker` wins; otherwise clone the
 *  configured repo to a temp dir; otherwise return an error. */
export function pickTemplateSource(opts: {
  candidates: string[]
  marker: string
  hasMarker?: (dir: string, marker: string) => boolean
  templateRepo: string
  cloneToTmp: (repo: string) => TemplateSource | null
  onLocalPick?: (dir: string) => void
}): TemplatePick {
  const probe =
    opts.hasMarker ??
    ((dir, marker) => existsSync(join(dir, marker)))
  for (const dir of opts.candidates) {
    if (dir && probe(dir, opts.marker)) {
      opts.onLocalPick?.(dir)
      return { dir }
    }
  }
  const cloned = opts.templateRepo ? opts.cloneToTmp(opts.templateRepo) : null
  if (cloned) return cloned
  return {
    error:
      `project-template not found — no local checkout has ${opts.marker} and the clone fell through. Set Settings → template repo to a local project-template path or a reachable git URL.`,
  }
}

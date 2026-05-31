// Resolve a usable project-template directory for the workspace bootstrap.
// The packaged app doesn't bundle templates/project-template (electron-builder
// only ships out/ + package.json), so when no local checkout exposes
// bootstrap.sh we fall back to cloning the configured template repo into a temp
// dir — mirroring scaffold.ts's templateSource(). The fs probe + git clone are
// injected so this resolution stays pure and unit-testable without electron or
// network access.

export type TemplateSource = { dir: string; cleanup?: () => void }
export type TemplatePick = TemplateSource | { error: string }

/** True for `scheme://` URLs (http(s), ssh, git, file). An scp-style remote like
 *  `git@host:org/repo` is NOT a scheme:// URL, so callers treat it as a clone
 *  target rather than a local directory. */
export function isTemplateUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

/** First local candidate dir that contains bootstrap.sh wins; otherwise clone
 *  the configured repo to a temp dir; otherwise return an error. */
export function pickTemplateSource(opts: {
  candidates: string[]
  hasBootstrap: (dir: string) => boolean
  templateRepo: string
  cloneToTmp: (repo: string) => TemplateSource | null
}): TemplatePick {
  for (const dir of opts.candidates) {
    if (dir && opts.hasBootstrap(dir)) return { dir }
  }
  const cloned = opts.templateRepo ? opts.cloneToTmp(opts.templateRepo) : null
  if (cloned) return cloned
  return {
    error:
      'project-template not found — no local checkout has bootstrap.sh and the clone fell through. Set Settings → template repo to a local project-template path or a reachable git URL.',
  }
}

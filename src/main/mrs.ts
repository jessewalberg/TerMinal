import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoForCwd } from './repo'
import { emitActivity } from './events'
import * as forge from './forge'
import {
  resolveReviewDir,
  reviewForPrDir,
  reviewBodyForPrDir,
  newestArtifactShortSha,
  readJsonSafe,
  type Review,
} from './review'

// Forge-agnostic MR/PR layer: raw fetching is delegated to ./forge (gh|glab);
// this module adds the harness review/test enrichment + activity emit. The
// "Mr" names are kept (internal + IPC stable) regardless of GitHub vs GitLab.

export type { CiJob, CiInfo } from './forge'

export type Finding = {
  id?: string
  severity?: string
  title?: string
  text?: string
  body?: string
  file?: string
  line?: number
  status?: string
  agent_fix_prompt?: string
  category?: string
} & Record<string, unknown>

export type MrDetail = {
  iid: number
  title: string
  description: string
  state: string
  author: string
  webUrl: string
  sourceBranch: string
  targetBranch: string
  draft: boolean
  reviewMd: string
  reviewMeta: Review | null
  findings: Finding[]
  suggestions: Finding[]
  artifactShortSha: string
}

export type Mr = {
  iid: number
  title: string
  state: string
  author: string
  webUrl: string
  sourceBranch: string
  draft: boolean
  review: Review | null
  labels: string[]
}

// `error` distinguishes a genuinely-empty list from a CLI failure, so the UI
// can show an accurate empty state instead of a misleading "not authenticated".
export type MrListResult = { mrs: Mr[]; error?: string }

// Live MRs/PRs for the repo, each enriched with its harness review/test verdict.
export async function listMrs(repoRoot: string): Promise<MrListResult> {
  const { items, error } = await forge.listRaw(repoRoot)
  if (error) return { mrs: [], error }
  const repo = repoForCwd(repoRoot)
  const mrs = items.map((m): Mr => {
    const dir = repo ? resolveReviewDir(repoRoot, repo.host, repo.path, m.iid) : null
    return {
      iid: m.iid,
      title: m.title,
      state: m.state,
      author: m.author,
      webUrl: m.webUrl,
      sourceBranch: m.sourceBranch,
      draft: m.draft,
      review: dir ? reviewForPrDir(dir, m.headShort) : null,
      labels: m.labels,
    }
  })
  return { mrs }
}

export type MrSummary = {
  open: number
  approve: number
  changes: number
  needsReview: number
  riskHigh: number
  riskMedium: number
  riskUnscored: number
  label: string // forge vocabulary for the widget ('PR' | 'MR')
}
// Cached (60s) MR counts for the cockpit widget — the forge CLI is slow per poll.
// Keyed per-repo so several sessions on different repos don't evict each other.
const summaryCache = new Map<string, { ts: number; mrs: Mr[] }>()
export async function mrSummary(repoRoot: string): Promise<MrSummary> {
  const now = Date.now()
  let mrs: Mr[]
  const hit = summaryCache.get(repoRoot)
  if (hit && now - hit.ts < 60_000) {
    mrs = hit.mrs
  } else {
    mrs = (await listMrs(repoRoot)).mrs
    summaryCache.set(repoRoot, { ts: now, mrs })
  }
  const opened = mrs.filter((m) => m.state === 'opened')
  const approve = opened.filter((m) => m.review?.verdict === 'approve').length
  const changes = opened.filter(
    (m) => m.review?.verdict === 'request-changes' || m.review?.verdict === 'blocked',
  ).length
  const tier = (m: (typeof opened)[0]) => m.review?.riskTier || 'unscored'
  return {
    open: opened.length,
    approve,
    changes,
    needsReview: opened.length - approve - changes,
    riskHigh: opened.filter((m) => tier(m) === 'high').length,
    riskMedium: opened.filter((m) => tier(m) === 'medium').length,
    riskUnscored: opened.filter((m) => tier(m) === 'unscored').length,
    label: forge.forgeFor(repoRoot).label,
  }
}

// Full MR detail: forge view + the harness review body/findings/suggestions.
export async function getMr(repoRoot: string, iid: number): Promise<MrDetail | null> {
  const d = await forge.detailRaw(repoRoot, iid)
  if (!d) return null
  const repo = repoForCwd(repoRoot)
  let reviewMd = ''
  let reviewMeta: Review | null = null
  let findings: Finding[] = []
  let suggestions: Finding[] = []
  let artifactShortSha = ''
  const dir = repo ? resolveReviewDir(repoRoot, repo.host, repo.path, iid) : null
  if (dir) {
    reviewMeta = reviewForPrDir(dir, d.headShort)
    reviewMd = reviewBodyForPrDir(dir)
    artifactShortSha = newestArtifactShortSha(dir)
    // stored as bare arrays or { findings: [...] } / { suggestions: [...] }
    const fRaw = readJsonSafe<any>(join(dir, 'findings.json'), [])
    findings = Array.isArray(fRaw) ? fRaw : Array.isArray(fRaw?.findings) ? fRaw.findings : []
    const sRaw = readJsonSafe<any>(join(dir, 'suggestions.json'), [])
    suggestions = Array.isArray(sRaw) ? sRaw : Array.isArray(sRaw?.suggestions) ? sRaw.suggestions : []
  }
  return {
    iid: d.iid,
    title: d.title,
    description: d.description,
    state: d.state,
    author: d.author,
    webUrl: d.webUrl,
    sourceBranch: d.sourceBranch,
    targetBranch: d.targetBranch,
    draft: d.draft,
    reviewMd,
    reviewMeta,
    findings,
    suggestions,
    artifactShortSha,
  }
}

// Merge an MR/PR. Human-initiated only (a button the user clicks) — this is the
// human satisfying the merge gate, not an agent auto-merging. Surfaces the
// forge CLI's error (pipeline must pass, conflicts, approvals) verbatim.
export async function mergeMr(repoRoot: string, iid: number): Promise<{ ok: boolean; error?: string }> {
  const res = await forge.merge(repoRoot, iid)
  if (res.ok) {
    const label = repoForCwd(repoRoot)?.path || repoRoot.split('/').pop() || ''
    const sym = forge.forgeFor(repoRoot).sym
    emitActivity(
      { kind: 'pr-merged', title: `Merged ${sym}${iid}`, detail: label, repo: label, repoRoot, ref: { pr: iid } },
      { notify: true },
    )
  }
  return res
}

// The forge's own CI for an MR/PR head — the actual lint/test/build/deploy jobs,
// separate from the harness review verdict. Lazy-loaded (CI is slow).
export function getMrCi(repoRoot: string, iid: number): Promise<forge.CiInfo | null> {
  return forge.ci(repoRoot, iid)
}

// Full MR diff. Prefers the harness-cached <short>.diff.patch (fast, exact same
// review-base→head as the reviewed artifact); falls back to live forge diff.
export function getMrDiff(repoRoot: string, iid: number): Promise<string> {
  const repo = repoForCwd(repoRoot)
  if (repo) {
    const dir = resolveReviewDir(repoRoot, repo.host, repo.path, iid)
    const short = dir ? newestArtifactShortSha(dir) : ''
    if (dir && short) {
      const f = join(dir, `${short}.diff.patch`)
      if (existsSync(f)) return Promise.resolve(readFileSync(f, 'utf8'))
    }
  }
  return forge.diff(repoRoot, iid)
}

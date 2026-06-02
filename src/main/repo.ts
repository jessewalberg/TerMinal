import { execFileSync } from 'node:child_process'

export type RepoId = { host: string; path: string }

// repoRootOf / repoForCwd are called from ~50 IPC handlers and the 4s git
// widget, yet a cwd's git root + origin are effectively static for a session.
// Memoize per cwd with a short TTL so a burst of polls collapses to one git
// spawn, while a rare change (new worktree, remote edit) is still picked up.
const REPO_TTL_MS = 15_000
function memoTtl<T>(cache: Map<string, { v: T; exp: number }>, key: string, compute: () => T): T {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.exp > now) return hit.v
  const v = compute()
  cache.set(key, { v, exp: now + REPO_TTL_MS })
  return v
}

export function parseRemote(url: string): RepoId | null {
  const u = url.trim().replace(/\.git$/, '')
  let m = u.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/)
  if (m) return { host: m[1], path: m[2] }
  m = u.match(/^(?:ssh:\/\/)?[\w.-]+@([^:/]+)[:/](.+)$/) // scp-like or ssh://
  if (m) return { host: m[1], path: m[2] }
  return null
}

const remoteCache = new Map<string, { v: RepoId | null; exp: number }>()
/** owner/repo + host for the git repo containing cwd (via origin remote). */
export function repoForCwd(cwd: string): RepoId | null {
  if (!cwd) return null
  return memoTtl(remoteCache, cwd, () => {
    try {
      const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return parseRemote(url)
    } catch {
      return null
    }
  })
}

const rootCache = new Map<string, { v: string; exp: number }>()
/** The repo root (git toplevel) for cwd, or '' if not a repo. */
export function repoRootOf(cwd: string): string {
  if (!cwd) return ''
  return memoTtl(rootCache, cwd, () => {
    try {
      return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return ''
    }
  })
}

export type GitStatus = {
  ok: boolean
  branch: string
  ahead: number
  behind: number
  dirty: number
}

export function gitStatus(cwd: string): GitStatus {
  const out: GitStatus = { ok: false, branch: '', ahead: 0, behind: 0, dirty: 0 }
  if (!cwd) return out
  const run = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return ''
    }
  }
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch) return out
  out.ok = true
  out.branch = branch
  const ab = run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  if (ab) {
    const [behind, ahead] = ab.split(/\s+/).map(Number)
    out.behind = behind || 0
    out.ahead = ahead || 0
  }
  const porcelain = run(['status', '--porcelain'])
  out.dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0
  return out
}

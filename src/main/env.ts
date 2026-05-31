import { execFileSync, execFile } from 'node:child_process'
import { accessSync, existsSync, constants, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { enginePath } from './settings'

// Finder/dock-launched macOS apps inherit only a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew-installed CLIs (glab, gh, codex,
// claude) aren't found by execFile/spawn — the MRs/CI/merge features silently
// no-op as "not authenticated". Resolve the real login-shell PATH once at
// startup and merge in the well-known bin dirs as a fallback.
export function fixPath(): void {
  let resolved = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-ilc', 'echo "__GT_PATH__:$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const line = out.split('\n').find((l) => l.startsWith('__GT_PATH__:'))
    resolved = line ? line.slice('__GT_PATH__:'.length).trim() : ''
  } catch {
    /* fall back to the well-known dirs below */
  }
  const fallback = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${homedir()}/.local/bin`]
  const merged = [
    ...(resolved ? resolved.split(':') : []),
    ...(process.env.PATH ? process.env.PATH.split(':') : []),
    ...fallback,
  ].filter(Boolean)
  process.env.PATH = [...new Set(merged)].join(':')
}

// --- tool / engine readiness detection (for onboarding + Settings) -----------

/** First executable named `name` on the (already PATH-fixed) PATH, or ''. */
function which(name: string): string {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const p = join(dir, name)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      /* not here */
    }
  }
  return ''
}

/** Resolve a configured engine value (bare name → PATH; absolute → validate). */
function resolveBin(nameOrPath: string): string {
  if (nameOrPath.includes('/')) {
    try {
      accessSync(nameOrPath, constants.X_OK)
      return nameOrPath
    } catch {
      return ''
    }
  }
  return which(nameOrPath)
}

/** `cursor-agent status` prints "✓ Logged in as <email>" when authed. Unlike
 *  claude/codex (which we only check for presence), cursor exposes a cheap auth
 *  probe, so we surface it for the Settings/onboarding readiness dot. */
function cursorAuthProbe(cli: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cli, ['status'], { timeout: 6000 }, (err, stdout, stderr) => {
      resolve(/logged in/i.test(`${stdout || ''}\n${stderr || ''}`))
    })
  })
}

type AuthInfo = { authed: boolean; host: string }
/** `<cli> auth status` — but glab exits non-zero if ANY configured host is
 *  unauthed (e.g. an unused gitlab.com entry) even when the self-hosted host you
 *  actually use IS authed. So treat a "Logged in to <host>" line as success and
 *  report that host, rather than trusting the exit code. */
function authProbe(cli: string): Promise<AuthInfo> {
  return new Promise((resolve) => {
    execFile(cli, ['auth', 'status'], { timeout: 6000 }, (err, stdout, stderr) => {
      const m = `${stdout || ''}\n${stderr || ''}`.match(/Logged in to (\S+)/i)
      resolve({ authed: !!m || !err, host: m?.[1] || '' })
    })
  })
}

export type EnvDetect = {
  codex: { found: boolean; path: string }
  claude: { found: boolean; path: string }
  cursor: { found: boolean; path: string; authed: boolean }
  gh: { found: boolean; path: string; authed: boolean; authHost: string }
  glab: { found: boolean; path: string; authed: boolean; authHost: string }
  tgScripts: boolean
  apps: { editors: string[]; browsers: string[] }
}

// Known external apps to offer for the "Open in editor/browser" handoffs.
// Detected by .app bundle name so `open -a <name>` works without a CLI/PATH.
const EDITOR_APPS = ['Cursor', 'Visual Studio Code', 'VSCodium', 'Zed', 'Windsurf', 'Sublime Text']
const BROWSER_APPS = ['Brave Browser', 'Arc', 'Google Chrome', 'Firefox', 'Microsoft Edge', 'Safari']
function appInstalled(name: string): boolean {
  return (
    existsSync(join('/Applications', `${name}.app`)) ||
    existsSync(join(homedir(), 'Applications', `${name}.app`))
  )
}
/** Installed editor/browser .app bundles (for the Settings/onboarding pickers). */
export function detectApps(): { editors: string[]; browsers: string[] } {
  return { editors: EDITOR_APPS.filter(appInstalled), browsers: BROWSER_APPS.filter(appInstalled) }
}

/** Probe which engines/forge CLIs are installed + (for forges) authenticated. */
export async function detectEnv(): Promise<EnvDetect> {
  const codex = resolveBin(enginePath('codex'))
  const claude = resolveBin(enginePath('claude'))
  const cursor = resolveBin(enginePath('cursor'))
  const gh = which('gh')
  const glab = which('glab')
  const none: AuthInfo = { authed: false, host: '' }
  const [ghAuth, glabAuth, cursorAuthed] = await Promise.all([
    gh ? authProbe(gh) : Promise.resolve(none),
    glab ? authProbe(glab) : Promise.resolve(none),
    cursor ? cursorAuthProbe(cursor) : Promise.resolve(false),
  ])
  return {
    codex: { found: !!codex, path: codex },
    claude: { found: !!claude, path: claude },
    cursor: { found: !!cursor, path: cursor, authed: cursorAuthed },
    gh: { found: !!gh, path: gh, authed: ghAuth.authed, authHost: ghAuth.host },
    glab: { found: !!glab, path: glab, authed: glabAuth.authed, authHost: glabAuth.host },
    tgScripts: existsSync(join(homedir(), '.claude', 'bin', 'telegram-notify.sh')),
    apps: detectApps(),
  }
}

// The portable activity-feed hook (plain JS). Behavior-identical to the
// committed bin/gt-notify (that file is the canonical copy / docs reference).
const GT_NOTIFY_SRC = `#!/usr/bin/env bun
// gt-notify — append one event to the TerMinal activity feed.
// Usage: gt-notify <kind> "<title>" [--detail ..] [--repo ..] [--repo-root ..] [--session ..]
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const pos = []
const opt = {}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--')) opt[a.slice(2)] = args[++i] ?? ''
  else pos.push(a)
}
const kind = pos[0] || 'info'
const title = pos[1] || ''
if (!title) {
  console.error('usage: gt-notify <kind> "<title>" [--detail ..] [--repo ..] [--repo-root ..] [--session ..]')
  process.exit(1)
}
const ev = {
  id: randomUUID(),
  ts: Date.now(),
  kind,
  title,
  ...(opt.detail ? { detail: opt.detail } : {}),
  ...(opt.repo ? { repo: opt.repo } : {}),
  ...(opt['repo-root'] ? { repoRoot: opt['repo-root'] } : {}),
  ...(opt.session ? { sessionId: opt.session } : {}),
}
const LOG = join(homedir(), '.config', 'TerMinal', 'activity.jsonl')
mkdirSync(dirname(LOG), { recursive: true })
appendFileSync(LOG, JSON.stringify(ev) + '\\n')
`

/** Write the gt-notify hook to ~/.local/bin (on PATH for most shells). */
export function installGtNotify(): { ok: boolean; path?: string; error?: string } {
  try {
    const dir = join(homedir(), '.local', 'bin')
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, 'gt-notify')
    writeFileSync(dest, GT_NOTIFY_SRC)
    chmodSync(dest, 0o755)
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

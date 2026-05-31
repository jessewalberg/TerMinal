import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// Persisted, self-configuring app settings. Every key has a working default —
// a fresh install (no file) runs fine, and an empty string means "resolve at
// read time" (e.g. projectsDir → your home dir). Legacy files in the old
// { telegram, telegramControl } shape are migrated on read.

export type EngineId = 'codex' | 'claude' | 'cursor'
export type EngineCfg = {
  path: string // '' = use the bare binary name on PATH
  defaultModel: string // '' = let claude/codex/cursor pick their own default
}

// The set of known engines + the executable each resolves to on PATH. The
// engine *id* is usually the binary name, but Cursor's CLI is `cursor-agent`,
// so the id→binary indirection lives here (used by enginePath + detection).
export const ENGINE_IDS: EngineId[] = ['codex', 'claude', 'cursor']
const ENGINE_BIN: Record<EngineId, string> = {
  codex: 'codex',
  claude: 'claude',
  cursor: 'cursor-agent',
}
/** The executable name for an engine id (cursor → cursor-agent, else the id). */
export function engineBinaryName(engine: EngineId): string {
  return ENGINE_BIN[engine] ?? engine
}
export type ForgePref = 'auto' | 'github' | 'gitlab'
export type TelegramCfg = {
  notify: boolean // mirror notifications to Telegram (opt-in)
  control: boolean // accept inbound AFK commands from Telegram (opt-in)
  botToken: string // BotFather token → native Bot API (else falls back to scripts)
  chatId: string // the single authorized chat (auth boundary)
}
// External-app handoffs: macOS app names used with `open -a <name>` — robust
// (no PATH/CLI dependency). '' → the built-in default.
export type AppsCfg = {
  editor: string // e.g. "Cursor" / "Visual Studio Code" — "Open in editor"
  browser: string // e.g. "Brave Browser" — "Open in browser"
}
export type OpenRouterCfg = {
  apiKey: string
  defaultModel: string // e.g. 'anthropic/claude-haiku-4.5'
}
/** Cloudflare API creds for the read-only Workers-deployments poller (off until
 *  both are set). Token needs Workers Scripts:Read on the account. */
export type CloudflareCfg = {
  apiToken: string
  accountId: string
}
export type Settings = {
  onboarded: boolean
  projectsDir: string // '' → resolved to your home dir
  worktreesDir: string // '' → <projectsDir>/.worktrees
  engines: Record<EngineId, EngineCfg>
  defaultEngine: EngineId
  forge: ForgePref // 'auto' picks gh/glab per-repo from the remote host
  telegram: TelegramCfg
  apps: AppsCfg
  /** OpenRouter — NOT a full coding harness (use claude-code/codex for that).
   *  Used for one-shot calls inside scripts: health-check classifiers, cheap
   *  precheck escalations, MR-authorship sniffing, etc. Optional. */
  openrouter: OpenRouterCfg
  cloudflare: CloudflareCfg
  harnessDir: string // optional cross-repo review-artifact store
  templateRepo: string // scaffold source
}

// A patch may carry partial nested telegram/engines/apps without losing siblings.
export type SettingsPatch = Partial<
  Omit<Settings, 'telegram' | 'engines' | 'apps' | 'openrouter' | 'cloudflare'>
> & {
  telegram?: Partial<TelegramCfg>
  engines?: Partial<Record<EngineId, Partial<EngineCfg>>>
  apps?: Partial<AppsCfg>
  openrouter?: Partial<OpenRouterCfg>
  cloudflare?: Partial<CloudflareCfg>
}

const DEFAULT_EDITOR = 'Cursor'
const DEFAULT_BROWSER = 'Brave Browser'

const DEFAULT_TEMPLATE_REPO = 'https://github.com/trevormil/project-template'

export function defaultSettings(): Settings {
  return {
    onboarded: false,
    projectsDir: '',
    worktreesDir: '',
    engines: {
      codex: { path: '', defaultModel: '' },
      claude: { path: '', defaultModel: '' },
      cursor: { path: '', defaultModel: '' },
    },
    defaultEngine: 'claude', // claude is the required engine; codex/cursor are optional
    forge: 'auto',
    telegram: { notify: false, control: false, botToken: '', chatId: '' },
    apps: { editor: '', browser: '' },
    openrouter: { apiKey: '', defaultModel: 'anthropic/claude-haiku-4.5' },
    cloudflare: { apiToken: '', accountId: '' },
    harnessDir: '',
    templateRepo: '',
  }
}

/** Coerce any on-disk shape (incl. the legacy flat booleans) into Settings. */
export function migrate(raw: unknown): Settings {
  const s = defaultSettings()
  if (!raw || typeof raw !== 'object') return s
  const r = raw as Record<string, any>

  // legacy flat booleans (pre-nesting)
  if (typeof r.telegram === 'boolean') s.telegram.notify = r.telegram
  if (typeof r.telegramControl === 'boolean') s.telegram.control = r.telegramControl
  // new nested telegram
  if (r.telegram && typeof r.telegram === 'object') {
    if (typeof r.telegram.notify === 'boolean') s.telegram.notify = r.telegram.notify
    if (typeof r.telegram.control === 'boolean') s.telegram.control = r.telegram.control
    if (typeof r.telegram.botToken === 'string') s.telegram.botToken = r.telegram.botToken
    if (typeof r.telegram.chatId === 'string') s.telegram.chatId = r.telegram.chatId
  }

  if (typeof r.onboarded === 'boolean') s.onboarded = r.onboarded
  for (const k of ['projectsDir', 'worktreesDir', 'harnessDir', 'templateRepo'] as const) {
    if (typeof r[k] === 'string') s[k] = r[k]
  }
  if (ENGINE_IDS.includes(r.defaultEngine)) s.defaultEngine = r.defaultEngine
  if (r.forge === 'auto' || r.forge === 'github' || r.forge === 'gitlab') s.forge = r.forge
  if (r.engines && typeof r.engines === 'object') {
    for (const e of ENGINE_IDS) {
      const cfg = r.engines[e]
      if (cfg && typeof cfg === 'object') {
        if (typeof cfg.path === 'string') s.engines[e].path = cfg.path
        if (typeof cfg.defaultModel === 'string') s.engines[e].defaultModel = cfg.defaultModel
      }
    }
  }
  if (r.apps && typeof r.apps === 'object') {
    if (typeof r.apps.editor === 'string') s.apps.editor = r.apps.editor
    if (typeof r.apps.browser === 'string') s.apps.browser = r.apps.browser
  }
  if (r.openrouter && typeof r.openrouter === 'object') {
    if (typeof r.openrouter.apiKey === 'string') s.openrouter.apiKey = r.openrouter.apiKey
    if (typeof r.openrouter.defaultModel === 'string') s.openrouter.defaultModel = r.openrouter.defaultModel
  }
  if (r.cloudflare && typeof r.cloudflare === 'object') {
    if (typeof r.cloudflare.apiToken === 'string') s.cloudflare.apiToken = r.cloudflare.apiToken
    if (typeof r.cloudflare.accountId === 'string') s.cloudflare.accountId = r.cloudflare.accountId
  }
  return s
}

// --- secrets at rest ---------------------------------------------------------
// Encrypt credential fields in settings.json via Electron safeStorage (macOS
// Keychain). In-memory Settings always hold PLAINTEXT — only the on-disk file
// is sealed. Identifiers (accountId) and config stay plaintext. Existing
// plaintext files keep working and silently upgrade on the next write.

const SECRET_PATHS = [
  'telegram.botToken',
  'telegram.chatId',
  'openrouter.apiKey',
  'cloudflare.apiToken',
] as const
const ENC = 'enc:'

/** Pure: deep-copy `obj` applying `fn` to each non-empty string at a secret path. */
function transformSecrets<T extends Record<string, any>>(obj: T, fn: (v: string) => string): T {
  const copy = structuredClone(obj)
  for (const path of SECRET_PATHS) {
    const segs = path.split('.')
    let cur: any = copy
    for (let i = 0; i < segs.length - 1 && cur; i++) cur = cur[segs[i]]
    const leaf = segs[segs.length - 1]
    if (cur && typeof cur === 'object' && typeof cur[leaf] === 'string' && cur[leaf] !== '') {
      cur[leaf] = fn(cur[leaf])
    }
  }
  return copy
}

/** Seal secret fields for disk (inject the crypto so it's unit-testable). */
export function sealSecrets<T extends Record<string, any>>(s: T, seal: (v: string) => string): T {
  return transformSecrets(s, seal)
}
/** Open secret fields read from disk; non-`enc:` values pass through unchanged. */
export function openSecrets<T extends Record<string, any>>(raw: T, open: (v: string) => string): T {
  return transformSecrets(raw, open)
}

export type SecretStore = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(enc: Buffer): string
}
// Default = passthrough (tests, headless, or before init). Replaced once the
// app is ready and Electron safeStorage is available.
let secretCrypto = { seal: (v: string) => v, open: (v: string) => v }

/** Wire real encryption. Called once at app-ready with Electron's safeStorage
 *  (kept out of this module's imports so settings.ts stays electron-free). */
export function initSecretSealer(ss: SecretStore): void {
  if (!ss || !ss.isEncryptionAvailable()) return // leave passthrough — store plaintext
  secretCrypto = {
    seal: (v) => {
      try {
        return ENC + ss.encryptString(v).toString('base64')
      } catch {
        return v
      }
    },
    open: (v) => {
      if (!v.startsWith(ENC)) return v // legacy plaintext
      try {
        return ss.decryptString(Buffer.from(v.slice(ENC.length), 'base64'))
      } catch {
        return v
      }
    },
  }
  cache = null // force a decrypt-aware re-read on next access
}

const FILE = join(homedir(), '.config', 'TerMinal', 'settings.json')

let cache: Settings | null = null
export function readSettings(): Settings {
  if (cache) return cache
  try {
    cache = migrate(openSecrets(JSON.parse(readFileSync(FILE, 'utf8')), secretCrypto.open))
  } catch {
    cache = defaultSettings()
  }
  return cache
}

/** Deep-merge a patch over current settings (telegram/engines merge per-key). */
export function patchSettings(patch: SettingsPatch): Settings {
  const cur = readSettings()
  const next: Settings = {
    ...cur,
    ...patch,
    telegram: { ...cur.telegram, ...(patch.telegram || {}) },
    apps: { ...cur.apps, ...(patch.apps || {}) },
    engines: {
      codex: { ...cur.engines.codex, ...(patch.engines?.codex || {}) },
      claude: { ...cur.engines.claude, ...(patch.engines?.claude || {}) },
      cursor: { ...cur.engines.cursor, ...(patch.engines?.cursor || {}) },
    },
    openrouter: { ...cur.openrouter, ...(patch.openrouter || {}) },
    cloudflare: { ...cur.cloudflare, ...(patch.cloudflare || {}) },
  }
  cache = next // in-memory stays plaintext
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(sealSecrets(next, secretCrypto.seal), null, 2)) // sealed on disk
  } catch {
    /* best effort */
  }
  return next
}

// --- resolution: turn '' defaults into concrete paths ------------------------

/** Pure: where worktrees live, given a settings value + a resolved projects dir. */
export function worktreesFrom(worktreesDir: string, projectsResolved: string): string {
  return worktreesDir || join(projectsResolved, '.worktrees')
}

export function resolvedProjectsDir(): string {
  return readSettings().projectsDir || homedir()
}

export function resolvedWorktreesDir(): string {
  return worktreesFrom(readSettings().worktreesDir, resolvedProjectsDir())
}

/** Optional cross-repo review-artifact store. '' (default) = none; the in-repo
 *  .reviews/ dir is the primary source and needs no configuration. */
export function resolvedHarnessDir(): string {
  return readSettings().harnessDir
}

export function resolvedTemplateRepo(): string {
  return readSettings().templateRepo || DEFAULT_TEMPLATE_REPO
}

/** The binary to invoke for an engine: explicit path > env (claude) > binary name. */
export function enginePath(engine: EngineId): string {
  const p = readSettings().engines[engine]?.path
  if (p) return p
  if (engine === 'claude' && process.env.GT_CLAUDE_BIN) return process.env.GT_CLAUDE_BIN
  return engineBinaryName(engine)
}

/** Per-engine model fallback. Returns '' when no fallback is set, in which
 *  case callers should let claude/codex pick their own default. */
export function engineDefaultModel(engine: EngineId): string {
  return readSettings().engines[engine]?.defaultModel || ''
}

export const telegramNotifyEnabled = () => readSettings().telegram.notify
export const telegramControlEnabled = () => readSettings().telegram.control

/** macOS app name for the "Open in editor" / "Open in browser" handoffs. */
export const resolvedEditorApp = () => readSettings().apps.editor || DEFAULT_EDITOR
export const resolvedBrowserApp = () => readSettings().apps.browser || DEFAULT_BROWSER

import { test, expect, describe } from 'bun:test'
import {
  migrate,
  defaultSettings,
  worktreesFrom,
  engineBinaryName,
  sealSecrets,
  openSecrets,
} from './settings'

describe('secrets at rest (seal/open)', () => {
  // Injected fake crypto so the pure transform is testable without electron.
  const seal = (v: string) => `ENC#${v}`
  const open = (v: string) => (v.startsWith('ENC#') ? v.slice(4) : v)

  const withSecrets = () => {
    const s = defaultSettings()
    s.telegram.botToken = 'bot:abc'
    s.telegram.chatId = '999'
    s.openrouter.apiKey = 'sk-or-1'
    s.cloudflare.apiToken = 'cf-tok'
    s.cloudflare.accountId = 'acc-123'
    return s
  }

  test('seal transforms only the secret fields, not identifiers/config', () => {
    const sealed = sealSecrets(withSecrets(), seal)
    expect(sealed.telegram.botToken).toBe('ENC#bot:abc')
    expect(sealed.telegram.chatId).toBe('ENC#999')
    expect(sealed.openrouter.apiKey).toBe('ENC#sk-or-1')
    expect(sealed.cloudflare.apiToken).toBe('ENC#cf-tok')
    // identifiers + non-secret config stay plaintext
    expect(sealed.cloudflare.accountId).toBe('acc-123')
    expect(sealed.openrouter.defaultModel).toBe('anthropic/claude-haiku-4.5')
  })

  test('seal then open round-trips back to plaintext', () => {
    const opened = openSecrets(sealSecrets(withSecrets(), seal), open)
    expect(opened.telegram.botToken).toBe('bot:abc')
    expect(opened.openrouter.apiKey).toBe('sk-or-1')
    expect(opened.cloudflare.apiToken).toBe('cf-tok')
  })

  test('open passes legacy plaintext through (no enc prefix → unchanged)', () => {
    const legacy = withSecrets() // plaintext on disk, never sealed
    expect(openSecrets(legacy, open).cloudflare.apiToken).toBe('cf-tok')
  })

  test('empty secrets are left untouched (not sealed)', () => {
    const sealed = sealSecrets(defaultSettings(), seal)
    expect(sealed.telegram.botToken).toBe('')
    expect(sealed.openrouter.apiKey).toBe('')
  })
})

describe('migrate', () => {
  test('empty / garbage → defaults', () => {
    expect(migrate(undefined)).toEqual(defaultSettings())
    expect(migrate(null)).toEqual(defaultSettings())
    expect(migrate('nope')).toEqual(defaultSettings())
    expect(migrate(42)).toEqual(defaultSettings())
  })

  test('legacy flat booleans → nested telegram', () => {
    const s = migrate({ telegram: true, telegramControl: true })
    expect(s.telegram.notify).toBe(true)
    expect(s.telegram.control).toBe(true)
    expect(s.telegram.botToken).toBe('') // filled from defaults
    expect(s.onboarded).toBe(false)
  })

  test('legacy false booleans preserved', () => {
    const s = migrate({ telegram: false, telegramControl: false })
    expect(s.telegram.notify).toBe(false)
    expect(s.telegram.control).toBe(false)
  })

  test('new nested telegram round-trips', () => {
    const s = migrate({
      onboarded: true,
      telegram: { notify: true, control: false, botToken: 'abc:123', chatId: '999' },
    })
    expect(s.onboarded).toBe(true)
    expect(s.telegram).toEqual({ notify: true, control: false, botToken: 'abc:123', chatId: '999' })
  })

  test('engines + scalars', () => {
    const s = migrate({
      projectsDir: '/p',
      worktreesDir: '/w',
      defaultEngine: 'claude',
      forge: 'github',
      harnessDir: '/h',
      templateRepo: 'https://x/y',
      engines: { codex: { path: '/bin/codex' }, claude: { path: '' } },
    })
    expect(s.projectsDir).toBe('/p')
    expect(s.worktreesDir).toBe('/w')
    expect(s.defaultEngine).toBe('claude')
    expect(s.forge).toBe('github')
    expect(s.harnessDir).toBe('/h')
    expect(s.templateRepo).toBe('https://x/y')
    expect(s.engines.codex.path).toBe('/bin/codex')
  })

  test('invalid enum values fall back to defaults', () => {
    const s = migrate({ defaultEngine: 'gpt', forge: 'bitbucket' })
    expect(s.defaultEngine).toBe('claude') // claude is the required engine; codex is optional
    expect(s.forge).toBe('auto')
  })

  test('wrong-typed fields are ignored, not coerced', () => {
    const s = migrate({ projectsDir: 123, onboarded: 'yes', engines: { codex: { path: 5 } } })
    expect(s.projectsDir).toBe('')
    expect(s.onboarded).toBe(false)
    expect(s.engines.codex.path).toBe('')
  })
})

describe('engine parity (cursor)', () => {
  test('defaults include all three engines', () => {
    const s = defaultSettings()
    expect(Object.keys(s.engines).sort()).toEqual(['claude', 'codex', 'cursor'])
    expect(s.engines.cursor).toEqual({ path: '', defaultModel: '' })
  })

  test('engineBinaryName maps the cursor id to its real binary', () => {
    // The engine id is "cursor" but the executable on PATH is "cursor-agent".
    expect(engineBinaryName('cursor')).toBe('cursor-agent')
    expect(engineBinaryName('codex')).toBe('codex')
    expect(engineBinaryName('claude')).toBe('claude')
  })

  test('defaultEngine accepts cursor', () => {
    expect(migrate({ defaultEngine: 'cursor' }).defaultEngine).toBe('cursor')
  })

  test('cursor engine cfg round-trips', () => {
    const s = migrate({
      engines: { cursor: { path: '/bin/cursor-agent', defaultModel: 'composer-2.5' } },
    })
    expect(s.engines.cursor).toEqual({ path: '/bin/cursor-agent', defaultModel: 'composer-2.5' })
  })
})

describe('cloudflare creds', () => {
  test('round-trip apiToken + accountId', () => {
    const s = migrate({ cloudflare: { apiToken: 'cf-tok', accountId: 'acc-123' } })
    expect(s.cloudflare).toEqual({ apiToken: 'cf-tok', accountId: 'acc-123' })
  })
  test('default is empty (poller off)', () => {
    expect(defaultSettings().cloudflare).toEqual({ apiToken: '', accountId: '' })
  })
})

describe('worktreesFrom', () => {
  test('explicit value wins', () => {
    expect(worktreesFrom('/custom/wt', '/projects')).toBe('/custom/wt')
  })
  test('falls back to <projects>/.worktrees', () => {
    expect(worktreesFrom('', '/projects')).toBe('/projects/.worktrees')
  })
})

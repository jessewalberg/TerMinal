import { test, expect, describe } from 'bun:test'
import {
  migrate,
  defaultSettings,
  worktreesFrom,
  engineBinaryName,
  sealSecrets,
  openSecrets,
  classifyProjectsDir,
  roleRoutingFrom,
  ROLE_IDS,
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
    return s
  }

  test('seal transforms only the secret fields, not config', () => {
    const sealed = sealSecrets(withSecrets(), seal)
    expect(sealed.telegram.botToken).toBe('ENC#bot:abc')
    expect(sealed.telegram.chatId).toBe('ENC#999')
    expect(sealed.openrouter.apiKey).toBe('ENC#sk-or-1')
    // non-secret config stays plaintext
    expect(sealed.openrouter.defaultModel).toBe('anthropic/claude-haiku-4.5')
  })

  test('seal then open round-trips back to plaintext', () => {
    const opened = openSecrets(sealSecrets(withSecrets(), seal), open)
    expect(opened.telegram.botToken).toBe('bot:abc')
    expect(opened.openrouter.apiKey).toBe('sk-or-1')
  })

  test('open passes legacy plaintext through (no enc prefix → unchanged)', () => {
    const legacy = withSecrets() // plaintext on disk, never sealed
    expect(openSecrets(legacy, open).openrouter.apiKey).toBe('sk-or-1')
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

describe('classifyProjectsDir', () => {
  // Injected probe: only this one path "is" a git repo.
  const isRepo = (d: string) => d === '/Users/me/projects/nerdletters'

  test('a dir that is itself a git repo is rejected with a parent suggestion', () => {
    const v = classifyProjectsDir('/Users/me/projects/nerdletters', isRepo)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('is-repo')
      expect(v.suggestedParent).toBe('/Users/me/projects')
      expect(v.message).toMatch(/parent/i)
    }
  })

  test('a parent folder that contains repos (not a repo itself) is accepted', () => {
    expect(classifyProjectsDir('/Users/me/projects', isRepo)).toEqual({ ok: true })
  })

  test('blank / whitespace dir is accepted (resolves to home at read time)', () => {
    expect(classifyProjectsDir('', isRepo)).toEqual({ ok: true })
    expect(classifyProjectsDir('   ', isRepo)).toEqual({ ok: true })
  })

  test('trims surrounding whitespace before probing', () => {
    expect(classifyProjectsDir('  /Users/me/projects/nerdletters  ', isRepo).ok).toBe(false)
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

describe('role routing (task-first model policy)', () => {
  test('defaults: plan/verify→claude opus, code→cursor, review→codex', () => {
    const s = defaultSettings()
    expect(s.roles.plan).toEqual({ engine: 'claude', model: 'opus' })
    expect(s.roles.code).toEqual({ engine: 'cursor', model: '' })
    expect(s.roles.review).toEqual({ engine: 'codex', model: '' })
    expect(s.roles.verify).toEqual({ engine: 'claude', model: 'opus' })
    expect(s.taskFlow).toEqual({ verify: 'heavy', planGate: false })
  })

  test('migrate: settings.json without roles/taskFlow seeds defaults (back-compat)', () => {
    const m = migrate({ onboarded: true })
    expect(m.roles).toEqual(defaultSettings().roles)
    expect(m.taskFlow).toEqual(defaultSettings().taskFlow)
  })

  test('migrate: valid role overrides round-trip; invalid entries fall to defaults per-key', () => {
    const m = migrate({
      roles: {
        plan: { engine: 'codex', model: 'gpt-5' },
        code: { engine: 'nonsense', model: 42 },
      },
      taskFlow: { verify: 'always', planGate: true },
    })
    expect(m.roles.plan).toEqual({ engine: 'codex', model: 'gpt-5' })
    expect(m.roles.code).toEqual({ engine: 'cursor', model: '' }) // invalid engine → default kept
    expect(m.roles.review).toEqual(defaultSettings().roles.review)
    expect(m.taskFlow).toEqual({ verify: 'always', planGate: true })
  })

  test('migrate: valid engine with wrong-typed model keeps engine, blanks model', () => {
    const m = migrate({ roles: { review: { engine: 'claude', model: 42 } } })
    expect(m.roles.review).toEqual({ engine: 'claude', model: '' })
  })

  test('migrate: invalid taskFlow values fall back per-key', () => {
    const m = migrate({ taskFlow: { verify: 'sometimes', planGate: 'yes' } })
    expect(m.taskFlow).toEqual({ verify: 'heavy', planGate: false })
  })

  test('roleRoutingFrom: configured table wins; absent/partial table falls to defaults', () => {
    expect(roleRoutingFrom(undefined, 'plan')).toEqual({ engine: 'claude', model: 'opus' })
    const roles = { review: { engine: 'claude' as const, model: 'sonnet' } }
    expect(roleRoutingFrom(roles, 'review')).toEqual({ engine: 'claude', model: 'sonnet' })
    expect(roleRoutingFrom(roles, 'code')).toEqual({ engine: 'cursor', model: '' })
  })

  test('ROLE_IDS lists the four stages in pipeline order', () => {
    expect(ROLE_IDS).toEqual(['plan', 'code', 'review', 'verify'])
  })
})

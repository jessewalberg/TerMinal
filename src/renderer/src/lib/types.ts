import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

// Mirror of the preload `gt` bridge. Kept hand-written so plugins have a clean
// typed surface without reaching across tsconfig roots into the preload build.
export type TranscriptStats = {
  ok: boolean
  sessionId: string
  model: string
  cwd: string
  gitBranch: string
  contextTokens: number
  contextLimit: number
  contextPct: number
  totalInputTokens: number
  totalOutputTokens: number
  estCostUsd: number
  turns: number
  lastAction: { tool: string; detail: string } | null
  firstUserText: string
  aiTitle: string
  permissionMode: string
  lastPrompt: string
  toolCounts: Record<string, number>
  mtime: number
  ts: number
}

export type TaskItem = { id: string; subject: string; status: string; activeForm: string }

// Mirror of src/main/events.ts ActivityKind — keep in sync with the tab's
// ICON / KIND_LABEL / activityTone maps. Unknown kinds fall back gracefully.
export type ActivityKind =
  | 'session-start'
  | 'session-end'
  | 'ticket-filed'
  | 'ticket-closed'
  | 'pr-opened'
  | 'pr-verdict'
  | 'pr-merged'
  | 'deploy'
  | 'tests-pass'
  | 'tests-fail'
  | 'check'
  | 'doc'
  | 'agent-run'
  | 'task-complete'
  | 'blocked'
  | 'error'
  | 'info'
export type ActivityEvent = {
  id: string
  ts: number
  kind: ActivityKind
  title: string
  detail?: string
  repo?: string
  repoRoot?: string
  sessionId?: string
  ref?: { ticket?: number; pr?: number }
  runId?: string
  runSource?: 'cron' | 'agent' | 'workflow'
}

export type UsageWindow = { pct: number; resetsAt: number | null } | null
export type Usage = {
  ok: boolean
  plan: string
  tier: string
  fiveHour: UsageWindow
  sevenDay: UsageWindow
  overagePct: number | null
  stale: boolean
  error?: string
  ts: number
}

export type CommandWidget = {
  id: string
  title: string
  icon?: string
  command: string
  intervalMs: number
  mode: 'text' | 'big' | 'kv'
  source: 'global' | 'repo'
}

export type CommandResult = { ok: boolean; stdout: string; code: number }

export type Ticket = {
  slug: string
  id: number
  title: string
  status: string
  priority: string
  horizon: string
  hitl: boolean
  type: string
  source: string
  created: string
  updated: string
  prs: string[]
  refs: string[]
  depends_on: number[]
  body: string
}

export type ProjectSession = {
  slug: string
  id: number
  title: string
  status: string
  goal: string
  started: string
  ended: string
  anchor: string
  tickets: string[]
  branches: string[]
  prs: string[]
  body?: string
}

export type NewTicket = { title: string; type: string; priority: string; status: string; body: string }

export type DocCategory = 'changelog' | 'decisions' | 'maintainer' | 'developer' | 'personal' | 'reports' | 'other'
export type DocEntry = {
  path: string
  title: string
  category: DocCategory
  managedBy?: string
  subgroup?: string // for 'reports': the agent name (second path segment)
}
export type DocsTree = {
  categories: { id: DocCategory; label: string; items: DocEntry[] }[]
}

export type Engine = 'codex' | 'claude' | 'cursor'
export type SessionEngine = Engine | 'local'
export type EngineCfg = { path: string; defaultModel: string }
// Task-first role routing: which engine+model runs each task stage.
export type RoleId = 'plan' | 'code' | 'review' | 'verify'
export type RoleCfg = { engine: Engine; model: string }
export type TaskFlowCfg = { verify: 'heavy' | 'always' | 'never'; planGate: boolean }
export type ForgePref = 'auto' | 'github' | 'gitlab'
export type TelegramCfg = { notify: boolean; control: boolean; botToken: string; chatId: string }
export type AppsCfg = { editor: string; browser: string }
export type OpenRouterCfg = { apiKey: string; defaultModel: string }
export type Settings = {
  onboarded: boolean
  projectsDir: string
  worktreesDir: string
  engines: Record<Engine, EngineCfg>
  defaultEngine: Engine
  forge: ForgePref
  telegram: TelegramCfg
  apps: AppsCfg
  openrouter: OpenRouterCfg
  harnessDir: string
  templateRepo: string
  maxRunMs: number // per-run soft wall-clock cap (ms); 0 = off, default 3h
  maxRunHardMs: number // per-run HARD cap (ms): SIGTERM when exceeded; 0 = off
  hiddenRepos: string[] // repos manually hidden from the fleet inventory (#14)
  roles: Record<RoleId, RoleCfg> // task-stage routing (plan/code/review/verify)
  taskFlow: TaskFlowCfg
}
export type SettingsPatch = Partial<
  Omit<Settings, 'telegram' | 'engines' | 'apps' | 'openrouter' | 'roles' | 'taskFlow'>
> & {
  telegram?: Partial<TelegramCfg>
  engines?: Partial<Record<Engine, Partial<EngineCfg>>>
  apps?: Partial<AppsCfg>
  openrouter?: Partial<OpenRouterCfg>
  roles?: Partial<Record<RoleId, Partial<RoleCfg>>>
  taskFlow?: Partial<TaskFlowCfg>
}

/** Result of validating a projectsDir candidate (settings:validateProjectsDir).
 *  `ok:false` means the chosen dir is itself a git repo, not a parent folder. */
export type ProjectsDirVerdict =
  | { ok: true }
  | { ok: false; reason: 'is-repo'; message: string; suggestedParent: string }

/** Tool/engine readiness probed by the main process (env:detect). */
export type EnvDetect = {
  codex: { found: boolean; path: string }
  claude: { found: boolean; path: string }
  cursor: { found: boolean; path: string; authed: boolean }
  gh: { found: boolean; path: string; authed: boolean; authHost: string }
  glab: { found: boolean; path: string; authed: boolean; authHost: string }
  tgScripts: boolean
  apps: { editors: string[]; browsers: string[] }
}

export type Agent = {
  id: string
  title: string
  description?: string
  icon?: string
  prompt: string
  opensPr?: boolean
  engine?: Engine
  model?: string
  inPlace?: boolean
  /** FORCE MODE — bypasses the main-branch push gate. UI shows a red FORCE chip. */
  force?: boolean
  source?: 'default' | 'override' | 'repo' | 'global'
  hasScript?: boolean
}
// Per-(repo, agent) state sidecar — the runtime owns lastScannedSha /
// lastScannedRef / lastRunAt / lastRunId; scripts can pin arbitrary
// string keys beyond that via `terminal-cli state set <key> <value>`.
export type AgentStateRecord = {
  lastScannedSha?: string
  lastScannedRef?: string
  lastRunAt?: number
  lastRunId?: string
  [key: string]: unknown
}
export type Persona = { id: string; title: string; description: string; icon?: string; prompt: string }
export type PipelineId = 'single' | 'review' | 'review-iterate'
export type PipelineInfo = { id: PipelineId; title: string; description: string }
export type AgentRunStatus = 'running' | 'done' | 'failed' | 'canceled' | 'interrupted'
export type AgentRun = {
  id: string
  agentId: string
  agentTitle: string
  engine: Engine
  persona?: string
  pipeline?: string
  status: AgentRunStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
  repoRoot: string
  worktree: string
  branch: string
  output: string
  /** Snapshot at run-time of the agent's force flag. */
  force?: boolean
  stepEngines?: Engine[] // per-step engines for multi-engine task runs
  gateWaiting?: boolean // parked at a plan-approval gate (resumable)
}

export type ScheduleSpec =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'calendar'; minute: number; hour: number; weekdays?: number[] }
  | { kind: 'cron'; expr: string }
export type ScheduleStatus = 'never' | 'running' | 'done' | 'failed'
export type ScheduleEnv = Record<string, string>
export type Schedule = {
  id: string
  repoRoot: string
  repoLabel: string
  agentId: string
  agentTitle: string
  engine: Engine
  model?: string
  prompt: string
  spec: ScheduleSpec
  enabled: boolean
  env?: ScheduleEnv
  createdAt: number
  lastRun?: number
  lastStatus?: ScheduleStatus
  lastRunId?: string
  // added by schedules:list
  describe?: string
  nextRun?: number | null
}
export type WindowStats = {
  events: number
  ticketsFiled: number
  ticketsClosed: number
  prsOpened: number
  prsMerged: number
  reviews: number
  testsPass: number
  testsFail: number
  agentRuns: number
  checks: number
  docs: number
  blocked: number
}
export type RunStats = { total: number; done: number; failed: number; running: number; successRate: number }
export type CycleStats = {
  merged: number
  medianHours: number | null
  fileToOpenHours: number | null
  openToMergeHours: number | null
}
export type Funnel = { filed: number; opened: number; merged: number }
export type FactoryHealth = {
  generatedAt: number
  window24h: WindowStats
  window7d: WindowStats
  agents: RunStats
  cron: RunStats & { recentFailures: number }
  hitlOpen: number
  cycle: CycleStats
  funnel: Funnel
  recentFailures: { title: string; ts: number; repo: string; kind: string }[]
  daily: { day: string; count: number }[]
  byRepo: { repo: string; events: number }[]
}
export type HitlSource = 'manual' | 'cron-fail' | 'agent' | 'factory' | 'skill'
export type HitlItem = {
  id: string
  title: string
  detail?: string
  action?: string
  repo?: string
  repoRoot?: string
  source: HitlSource
  status: 'open' | 'resolved'
  createdAt: number
  resolvedAt?: number
  runId?: string
  runSource?: 'cron' | 'agent' | 'workflow'
  ticketPath?: string
}
export type BgTask = {
  id: string
  repo: string
  repoRoot: string
  prompt: string
  engine: Engine
  model?: string
  worktree: string
  branch: string
  pid?: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  startedAt: number
  endedAt?: number
  exitCode?: number
  logFile: string
  mrUrl?: string
  label: string
}

export type UnifiedRun = {
  id: string
  source: 'cron' | 'agent' | 'workflow'
  agentId: string
  agentTitle: string
  engine: string
  status: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  repoRoot: string
  repoLabel: string
  branch: string
  worktree: string
  persona?: string
  pipeline?: string
  scheduleId?: string
  error?: string
  /** Snapshot at run-time of the agent's force flag. */
  force?: boolean
  stepEngines?: string[] // per-step engines for multi-engine task runs
  gateWaiting?: boolean // parked at a plan-approval gate (resumable)
}

export type CronRun = {
  id: string
  scheduleId: string
  agentId: string
  agentTitle: string
  engine: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  exitCode?: number
  branch: string
  repoLabel: string
  worktree: string
  error?: string
}

export type Review = {
  number: number
  overall: number | null
  verdict: string
  testStatus: string
  stale: boolean
  commitsBehind: number
  /** Cross-PR triage: high/medium/low (or unscored if absent). */
  riskTier: 'high' | 'medium' | 'low' | 'unscored'
}

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

export type SkillScope = 'project' | 'personal' | 'plugin'
export type SkillInfo = {
  name: string
  description: string
  scope: SkillScope
  namespace?: string
  platforms: Engine[]
}

export type CiJob = { id: number; name: string; stage: string; status: string; webUrl: string }
export type CiInfo = { status: string; webUrl: string; jobs: CiJob[] }
export type MrListResult = { mrs: Mr[]; error?: string }

// ─── CI tab — full pipeline / workflow run list (independent of MR) ─────────
export type CiRunStatus =
  | 'queued'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'pending'
export type CiRun = {
  id: string
  name: string
  status: CiRunStatus
  branch: string
  shortSha: string
  event: string
  webUrl: string
  createdAt: number
  updatedAt: number
  durationMs: number | null
}
export type CiTabStep = {
  name: string
  status: CiRunStatus
  number: number
}
export type CiTabJob = {
  id: string
  name: string
  stage: string
  status: CiRunStatus
  webUrl: string
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  steps?: CiTabStep[]
}
export type CiListResult = { runs: CiRun[]; error?: string }
export type CiJobsResult = { jobs: CiTabJob[]; error?: string }
export type CiLogResult = { log: string; truncated?: boolean; error?: string }

export type TabContext = {
  cwd: string
  sessionId: string
  repoRoot: string
  repoPath: string
  repoHost: string
  forgeKind: 'github' | 'gitlab'
  forgeLabel: 'PR' | 'MR'
  forgeSym: '#' | '!'
  hasBacklog: boolean
  hasSessions: boolean
  hasAgents: boolean
}

export type SessionMeta = {
  id: string
  engine: Engine
  cwd: string
  gitBranch: string
  model: string
  turns: number
  firstUserText: string
  mtime: number
}

/** Cross-repo PR/MR bucket counts for the Triage tab (one row per known repo). */
export type FleetMrSummary = {
  repo: string
  repoRoot: string
  label: 'PR' | 'MR'
  open: number
  approve: number
  changes: number
  needsReview: number
}
export type RepoInventory = {
  name: string
  path: string
  lastActivityMs: number
  ageDays: number // -1 when unknown (no commits)
  hasSchedule: boolean
  hidden: boolean
  bucket: 'active' | 'dormant' | 'dead'
}

export type FleetSession = {
  key: string
  sessionId: string
  name: string
  cwd: string
  repo: string
  branch: string
  model: string
  status: 'working' | 'idle' | 'awaiting'
  contextPct: number
  contextTokens: number
  contextLimit: number
  turns: number
  aiTitle: string
  lastAction: { tool: string; detail: string } | null
}

export type StartOpts = {
  mode: 'new' | 'resume'
  engine?: SessionEngine
  sessionId?: string
  cwd?: string
  name?: string
  cols: number
  rows: number
}

export type SessionInfo = {
  sessionId: string
  cwd: string
  mode: '' | 'new' | 'resume'
  name: string
  engine: SessionEngine
  claude: string
}

export type TddInfo = {
  ok: boolean
  repo: string
  number: number
  overall: number | null
  verdict: string
  testStatus: string
  stale: boolean
  commitsBehind: number
  ts: number
}

export type GtApi = {
  listSessions: () => Promise<SessionMeta[]>
  startSession: (key: string, opts: StartOpts) => Promise<{ sessionId: string; cwd: string }>
  setActiveSession: (key: string) => Promise<void>
  stopSession: (key: string) => Promise<void>
  fleet: () => Promise<FleetSession[]>
  fleetMrs: () => Promise<FleetMrSummary[]>
  fleetRepos: () => Promise<RepoInventory[]>
  setRepoHidden: (path: string, hidden: boolean) => Promise<RepoInventory[]>
  pickDir: () => Promise<string | null>
  projectDirs: () => Promise<{ name: string; path: string }[]>
  detectEnv: () => Promise<EnvDetect>
  installGtNotify: () => Promise<{ ok: boolean; path?: string; error?: string }>
  scaffoldProject: (
    name: string,
    parentDir?: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  isFullscreen: () => Promise<boolean>
  onFullscreen: (cb: (v: boolean) => void) => () => void
  settings: {
    get: () => Promise<Settings>
    patch: (patch: SettingsPatch) => Promise<Settings>
    validateProjectsDir: (dir: string) => Promise<ProjectsDirVerdict>
  }
  telegram: {
    test: () => Promise<{ ok: boolean; error?: string }>
  }
  openrouter: {
    test: () => Promise<{ ok: boolean; text?: string; model?: string; error?: string }>
    chat: (opts: {
      messages: { role: string; content: string }[]
      model?: string
      maxTokens?: number
      temperature?: number
    }) => Promise<{ ok: boolean; text?: string; model?: string; error?: string }>
    presets: () => Promise<{
      free: readonly { id: string; label: string }[]
      cheapPaid: readonly { id: string; label: string; inUsdPerM: number }[]
    }>
  }
  cheapLlm: (opts: {
    messages: { role: string; content: string }[]
    model?: string
    route?: 'auto' | 'claude-p' | 'openrouter'
    maxTokens?: number
    temperature?: number
    timeoutMs?: number
  }) => Promise<{ ok: boolean; text?: string; model?: string; route?: string; error?: string }>
  classify: {
    ci: (rawLog: string) => Promise<{
      class: string
      confidence: string
      evidence: string[]
      isCheapClass: boolean
      source: string
    }>
    risk: (input: { files: string[]; diffLines?: number; title?: string }) => Promise<{
      tier: 'low' | 'medium' | 'high'
      confidence: string
      evidence: string[]
      source: string
    }>
  }
  mrAuthorship: (iid: number, opts?: { refine?: boolean }) => Promise<{
    total: number
    byTool: Record<string, number>
    dominant: string
    commits: {
      sha: string
      shortSha: string
      authorEmail: string
      authorName: string
      subject: string
      tool: string
      confidence: string
      evidence: string[]
    }[]
  } | null>
  agents: {
    allRuns: () => Promise<UnifiedRun[]>
    runLog: (source: 'cron' | 'agent' | 'workflow', runId: string) => Promise<string>
    list: () => Promise<Agent[]>
    save: (agent: Partial<Agent> & { id: string; title: string; prompt: string }) => Promise<{ ok: true } | { error: string }>
    reset: (id: string) => Promise<{ ok: true } | { error: string }>
    script: (id: string) => Promise<{ path: string; body: string } | null>
    state: (id: string) => Promise<{ path: string; exists: boolean; state: AgentStateRecord }>
    stateReset: (id: string) => Promise<{ ok: true } | { error: string }>
    convert: (id: string) => Promise<{ ok: true; scriptPath: string; sidecarPath: string } | { error: string }>
    design: (text: string, engine: Engine, scope: 'repo' | 'global', model?: string) =>
      Promise<AgentRun | { error: string }>
    personas: () => Promise<Persona[]>
    pipelines: () => Promise<PipelineInfo[]>
    run: (
      id: string,
      engine?: Engine,
      persona?: string,
      pipeline?: string,
      model?: string,
    ) => Promise<AgentRun | { error: string }>
    runTicket: (
      slug: string,
      engine: Engine,
      persona?: string,
      pipeline?: string,
      model?: string,
    ) => Promise<AgentRun | { error: string }>
    runPr: (
      pr: { iid: number; sourceBranch: string; title?: string; webUrl?: string },
      kind: 'review' | 'iterate',
      engine: Engine,
      persona?: string,
      pipeline?: string,
      model?: string,
    ) => Promise<AgentRun | { error: string }>
    runs: () => Promise<AgentRun[]>
    cancel: (runId: string) => Promise<boolean>
    resumeGate: (runId: string) => Promise<boolean>
    removeWorktree: (runId: string) => Promise<boolean>
    rerun: (run: UnifiedRun) => Promise<{ ok: true; runId?: string } | { error: string }>
    onStatus: (cb: (run: AgentRun) => void) => () => void
    onOutput: (cb: (p: { runId: string; chunk: string }) => void) => () => void
    onRunsChanged: (cb: (runs: UnifiedRun[]) => void) => () => void
  }
  schedules: {
    list: () => Promise<Schedule[]>
    save: (input: {
      id?: string
      agentId: string
      engine: Engine
      model?: string
      spec: ScheduleSpec
      enabled?: boolean
      env?: ScheduleEnv
    }) => Promise<{ ok: true; id: string } | { error: string }>
    remove: (id: string) => Promise<boolean>
    toggle: (id: string, enabled: boolean) => Promise<boolean>
    runNow: (id: string) => Promise<{ ok: true }>
    runs: (id?: string) => Promise<CronRun[]>
    runLog: (runId: string) => Promise<string>
    reconcile: () => Promise<{ loaded: number; removed: number }>
    removeAll: () => Promise<{ removed: number }>
    disabledList: () => Promise<string[]>
    disabledToggle: (id: string, disabled: boolean) => Promise<string[]>
    disabledAll: (disabled: boolean) => Promise<string[]>
    design: (text: string, engine: Engine) => Promise<AgentRun | { error: string }>
  }
  tasks: {
    /** Task-first entry: freeform prompt → role-routed plan/code/review/verify run. */
    start: (repoRoot: string, text: string) => Promise<AgentRun | { error: string }>
  }
  hitl: {
    list: () => Promise<HitlItem[]>
    file: (item: Omit<HitlItem, 'id' | 'status' | 'createdAt'>) => Promise<HitlItem>
    resolve: (id: string, resolved?: boolean) => Promise<boolean>
    remove: (id: string) => Promise<boolean>
  }
  factory: {
    health: () => Promise<FactoryHealth>
    start: (engine: Engine) => Promise<AgentRun | { error: string }>
  }
  activity: {
    list: () => Promise<ActivityEvent[]>
    clear: () => Promise<void>
    onEvent: (cb: (ev: ActivityEvent) => void) => () => void
  }
  pty: {
    input: (key: string, data: string) => void
    resize: (key: string, size: { cols: number; rows: number }) => void
    onData: (cb: (key: string, data: string) => void) => () => void
    onExit: (cb: (key: string, code: number) => void) => () => void
  }
  transcript: () => Promise<TranscriptStats>
  firstPrompt: (sessionId: string) => Promise<string>
  harnessTdd: () => Promise<TddInfo>
  usage: () => Promise<Usage>
  gitStatus: () => Promise<GitStatus>
  mrSummary: () => Promise<MrSummary>
  sessionTasks: () => Promise<TaskItem[]>
  meta: () => Promise<SessionInfo>
  listCommandWidgets: () => Promise<CommandWidget[]>
  runCommand: (command: string) => Promise<CommandResult>
  onTick: (cb: () => void) => () => void
  tabContext: () => Promise<TabContext>
  tickets: {
    list: () => Promise<Ticket[]>
    get: (slug: string) => Promise<Ticket | null>
    create: (input: NewTicket) => Promise<Ticket>
    update: (slug: string, patch: { status?: string; priority?: string }) => Promise<boolean>
    spawn: (text: string, engine: Engine, model?: string) => Promise<AgentRun | { error: string }>
  }
  docs: {
    list: () => Promise<DocsTree>
    get: (relPath: string) => Promise<string>
  }
  projectSessions: () => Promise<ProjectSession[]>
  getProjectSession: (slug: string) => Promise<ProjectSession | null>
  listSkills: () => Promise<SkillInfo[]>
  listMrs: () => Promise<MrListResult>
  getMr: (iid: number) => Promise<MrDetail | null>
  getMrDiff: (iid: number) => Promise<string>
  getMrCi: (iid: number) => Promise<CiInfo | null>
  mergeMr: (iid: number) => Promise<{ ok: boolean; error?: string }>
  ci: {
    list: (limit?: number) => Promise<CiListResult>
    jobs: (runId: string) => Promise<CiJobsResult>
    log: (jobId: string) => Promise<CiLogResult>
  }
  openExternal: (url: string) => Promise<void>
  openInBrowser: (url: string) => Promise<void>
  openInEditor: (path?: string) => Promise<void>
  openConfigDir: () => Promise<string>
  mcpInstall: () => Promise<{ ok: true; installed: string[] } | { error: string }>
  workspace: {
    isBootstrapped: (
      repoRoot: string,
    ) => Promise<{ bootstrapped: boolean; status: 'full' | 'partial' | 'none'; missing: string[] }>
    bootstrap: (repoRoot: string) => Promise<{ ok: true } | { error: string }>
  }
  release: {
    start: () => Promise<{ ok: true; pid: number | null; log: string; repoRoot: string } | { error: string }>
    tail: () => Promise<string>
    status: () => Promise<{ running: boolean; pid?: number | null }>
  }
  observability: {
    summary: (range?: 'today' | 'week' | 'month' | 'all') => Promise<{
      totalUsd: number
      totalRuns: number
      byModel: Record<string, { runs: number; usd: number; inputTokens: number; outputTokens: number }>
      bySource: Record<string, { runs: number; usd: number }>
      byAgent: Record<string, { runs: number; usd: number }>
      byRepo: Record<string, { runs: number; usd: number }>
    }>
    byAgent: (range?: 'today' | 'week' | 'month' | 'all') => Promise<{
      agentId: string
      runs: number
      usd: number
      outcomes: { prOpened: number; ticketFiled: number; merged: number; none: number }
    }[]>
    daily: (days?: number) => Promise<{ date: string; usd: number; runs: number; byModel: Record<string, number> }[]>
    runs: (limit?: number) => Promise<{
      id: string
      source: string
      startedAt: number
      endedAt?: number
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      costUsd: number
      repoRoot: string
      sessionId?: string
      runId?: string
      agentId?: string
      durationMs?: number
      exitCode?: number
    }[]>
    models: () => Promise<string[]>
  }
  budgets: {
    get: () => Promise<{
      dailyTotalUsd: number
      perAgent: Record<string, number>
      warnAt: number[]
      overrideUntil: number | null
    }>
    setDaily: (usd: number) => Promise<unknown>
    setAgent: (agentId: string, usd: number) => Promise<unknown>
    override: (durationMs: number) => Promise<unknown>
    gate: (agentId?: string) => Promise<{
      decision: 'allow' | 'warn' | 'refuse'
      reason?: string
      spentTodayUsd: number
      capRemainingUsd: number
      capUsd: number
    }>
  }
  bg: {
    list: () => Promise<BgTask[]>
    get: (id: string) => Promise<BgTask | null>
    log: (id: string) => Promise<string>
    spawn: (input: {
      repoRoot: string
      prompt: string
      engine?: Engine
      model?: string
    }) => Promise<BgTask | { error: string }>
    cancel: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  harnessStatus: () => Promise<{
    cronRunFiles: number
    cronWorktrees: number
    cronRunsRunning: number
    cronFailed24h: number
    inProcessRunning: number
    schedulesPaused: number
    configDir: string
  }>
  clipboardWrite: (text: string) => Promise<void>
  clipboardRead: () => Promise<string>
  notes: {
    read: (scope: 'repo' | 'global') => Promise<string>
    write: (scope: 'repo' | 'global', content: string) => Promise<boolean>
  }
  files: {
    list: (rel: string) => Promise<FileEntry[]>
    read: (rel: string) => Promise<{ ok: boolean; content: string; reason?: string }>
    write: (rel: string, content: string) => Promise<boolean>
    search: (q: string) => Promise<{ file: string; line: number; text: string }[]>
    create: (rel: string, dir: boolean) => Promise<boolean>
    rename: (from: string, to: string) => Promise<boolean>
    del: (rel: string) => Promise<boolean>
  }
}

export type FileEntry = { name: string; path: string; dir: boolean; ignored?: boolean }
export type SearchHit = { file: string; line: number; text: string }
export type GitStatus = { ok: boolean; branch: string; ahead: number; behind: number; dirty: number }
export type MrSummary = {
  open: number
  approve: number
  changes: number
  needsReview: number
  label: string
}

/** A full-screen tab. Auto-discovered from src/renderer/src/tabs/<id>/index.tsx. */
export type Tab = {
  id: string
  title: string
  icon: LucideIcon
  order?: number
  /** Whether this tab applies to the attached session's repo. */
  appliesTo: (ctx: TabContext) => boolean
  /** Optional live count shown as a pill on the tab (e.g. HITL items waiting). */
  badge?: (gt: GtApi) => Promise<number>
  Component: (props: { ctx: TabContext }) => ReactNode
}

declare global {
  interface Window {
    gt: GtApi
  }
}

/**
 * A plugin is just a folder under src/renderer/src/plugins/<id>/index.tsx that
 * default-exports one of these. Drop a folder in, it auto-registers. To add your
 * own: fork the repo, copy a plugin folder, change `poll` + `render`.
 */
export type Plugin<T = unknown> = {
  id: string
  title: string
  icon: LucideIcon
  blurb: string
  order?: number
  intervalMs: number
  defaultEnabled: boolean
  /** Restrict a plugin to engines whose data source actually exists. Omitted means all engines. */
  engines?: Engine[]
  /** Re-poll immediately when the attached session's transcript changes (not just on interval). */
  realtime?: boolean
  /** Called on an interval. `prev` is the previous poll result (for rate/delta widgets). */
  poll: (gt: GtApi, prev: T | null) => Promise<T>
  render: (data: T | null) => ReactNode
}

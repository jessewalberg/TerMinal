export interface QuiesceEntry {
  id: string
  pid: number | undefined
  ageMs: number
  file: string
}

export interface QuiesceResult {
  quiet: boolean
  blockers: Array<QuiesceEntry>
  stale: Array<QuiesceEntry & { reason: string }>
}

export declare function defaultIsPidAlive(pid: number): boolean

export declare function quiesceStatus(options: {
  repoRoot: string
  runsDirs: Array<string>
  isPidAlive?: (pid: number) => boolean
  now?: number
}): QuiesceResult

export declare function setRepoSchedulesDisabled(options: {
  repoRoot: string
  schedulesFile: string
  disabledFile: string
  disable: boolean
  only?: Array<string>
}): { changed: Array<string> }

export declare function restoreWritable(options: {
  backlogDir: string
  nextId: number
}): { restored: boolean }

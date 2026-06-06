export declare function slugify(s: string): string
export declare function todayStr(): string
export declare function writeExclusive(path: string, content: string): boolean
export declare function createTicketFile(
  backlogDir: string,
  input: {
    title: string
    body?: string
    type?: string
    priority?: string
    status?: string
    source?: string
  },
): { id: number; slug: string; path: string }
export declare function updateTicketFile(
  path: string,
  patch: {
    status?: string
    priority?: string
    appendPrUrl?: string
    removePrUrl?: string
  },
): boolean
export declare function hasProjectionMarker(backlogDir: string): boolean
export declare function createVaultTicketFile(
  route: { vaultPath: string; slug: string },
  input: {
    title: string
    body?: string
    type?: string
    priority?: string
    status?: string
    horizon?: string
    size?: string
    source?: string
    prs?: string[]
    refs?: string[]
    depends_on?: Array<string | number>
  },
): { id: string; sourceId: number; path: string }
export declare function findVaultTaskBySourceId(
  vaultPath: string,
  slug: string,
  sourceId: number,
): string | null

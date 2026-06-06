export declare function resolveRoute(
  repoRoot: string,
  settings?: {
    vaultPath?: string
    projectsDir?: string
    vaultCarveOuts?: { template?: string[]; collaborator?: string[] }
  },
  env?: Record<string, string | undefined>,
): { mode: 'vault' | 'template' | 'collaborator'; vaultPath: string; slug: string }

export declare function dirsForSlug(
  slug: string,
  settings?: { projectsDir?: string },
): string[]

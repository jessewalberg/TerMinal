export declare function readDisabledIds(file: string): Set<string>

export declare function updateDisabledIds(
  file: string,
  mutator: (set: Set<string>) => void,
  options?: { isLockStale?: (lockPath: string) => boolean },
): Set<string>

export declare function hasDisabledFile(file: string): boolean

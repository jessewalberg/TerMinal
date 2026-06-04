import { dirname } from 'node:path'

// A pty spawned with a nonexistent cwd dies in chdir() before producing any
// output — the pane shows nothing but "process exited" (renamed project dirs,
// unmounted volumes). Resolve to the nearest existing ancestor instead so the
// session lands next to where the project used to be, and report the fallback
// so the caller can surface it in the pane.
export type CwdResolution = { cwd: string; fellBack: boolean; requested?: string }

export function resolveSessionCwd(
  requested: string | undefined,
  exists: (path: string) => boolean,
  home: string,
): CwdResolution {
  if (!requested) return { cwd: home, fellBack: false }
  if (exists(requested)) return { cwd: requested, fellBack: false }
  for (let dir = dirname(requested); dir !== dirname(dir); dir = dirname(dir)) {
    if (exists(dir)) return { cwd: dir, fellBack: true, requested }
  }
  // nothing below the root survives (e.g. unmounted volume) — home beats "/"
  return { cwd: home, fellBack: true, requested }
}

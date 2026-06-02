import { useEffect, useState } from 'react'
import type { ProjectsDirVerdict } from './types'

/** Validate a projectsDir candidate (debounced) via the main process, which
 *  probes the real filesystem for `<dir>/.git`. Returns the latest verdict, or
 *  null while the field is blank. Shared by Onboarding + SettingsPanel so the
 *  parent-folder guard (ticket #34) is identical in both places. */
export function useProjectsDirCheck(dir: string): ProjectsDirVerdict | null {
  const [verdict, setVerdict] = useState<ProjectsDirVerdict | null>(null)
  useEffect(() => {
    if (!dir.trim()) {
      setVerdict(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      window.gt.settings.validateProjectsDir(dir).then((v) => {
        if (live) setVerdict(v)
      })
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [dir])
  return verdict
}

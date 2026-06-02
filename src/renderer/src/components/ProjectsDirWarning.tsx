import { AlertTriangle } from 'lucide-react'
import type { ProjectsDirVerdict } from '../lib/types'

/** Soft warning shown when the chosen projects dir is itself a git repo, with a
 *  one-click "use the parent instead" remediation. Renders nothing when the
 *  verdict is ok/absent. Ticket #34. */
export function ProjectsDirWarning({
  verdict,
  onUseParent,
}: {
  verdict: ProjectsDirVerdict | null
  onUseParent: (parent: string) => void
}) {
  if (!verdict || verdict.ok) return null
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
      <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
      <div className="space-y-1">
        <div>{verdict.message}</div>
        <button
          onClick={() => onUseParent(verdict.suggestedParent)}
          className="font-mono text-amber-200 underline underline-offset-2 hover:text-amber-100"
        >
          Use {verdict.suggestedParent} instead
        </button>
      </div>
    </div>
  )
}

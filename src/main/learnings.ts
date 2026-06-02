import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Push the repo's accumulated learnings INTO the agent at spawn, instead of
// relying on it to pull them. Same gotchas recur across near-clone repos; a
// short "prior gotchas" block from docs/learnings/ turns the search_decisions
// pull into a cheap push. Capped + skipped-if-empty. See ticket #24.

export type LearningNote = { title: string; summary: string }

const MARKDOWN_RE = /\.(md|mdx|markdown)$/i

/** A real learning doc: markdown, but NOT the directory's README/INDEX, which
 *  are explainers/scaffold and must not be injected as a "gotcha" (#15). */
export function isLearningDoc(filename: string): boolean {
  return MARKDOWN_RE.test(filename) && !/^(readme|index)\.(md|mdx|markdown)$/i.test(filename)
}

/** Pure: extract a title (first H1, else filename) + one-line summary (first
 *  non-heading, non-frontmatter line) from a learning doc's content. */
export function parseLearning(content: string, filename: string): LearningNote {
  const h1 = content.match(/^#\s+(.+?)\s*$/m)
  const title = h1 ? h1[1].trim() : filename.replace(MARKDOWN_RE, '')
  let summary = ''
  let inFrontmatter = false
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (i === 0 && l === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (l === '---') inFrontmatter = false
      continue
    }
    if (!l || l.startsWith('#')) continue
    summary = l.replace(/^[-*>]\s*/, '').slice(0, 160)
    break
  }
  return { title, summary }
}

/** Pure: assemble a capped "prior gotchas" preamble from learning notes.
 *  Returns '' when there are none (caller prepends nothing). */
export function buildLearningsPreamble(notes: LearningNote[], capBytes = 1500): string {
  if (!notes.length) return ''
  const header = "Prior gotchas from this repo's docs/learnings — don't repeat these:\n"
  let body = ''
  for (const n of notes) {
    const line = `- ${n.title}${n.summary ? `: ${n.summary}` : ''}\n`
    if (Buffer.byteLength(header + body + line, 'utf8') > capBytes) break
    body += line
  }
  return body ? `${header}${body}\n` : ''
}

/** Read docs/learnings/*.md from a repo into title + one-liner notes. */
export function readLearnings(repoRoot: string): LearningNote[] {
  const dir = join(repoRoot, 'docs', 'learnings')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(isLearningDoc).sort()
  } catch {
    return []
  }
  const notes: LearningNote[] = []
  for (const f of files) {
    try {
      notes.push(parseLearning(readFileSync(join(dir, f), 'utf8'), f))
    } catch {
      /* unreadable file — skip */
    }
  }
  return notes
}

/** The capped preamble for a repo (or '' when it has no learnings). */
export function learningsPreambleFor(repoRoot: string, capBytes = 1500): string {
  return buildLearningsPreamble(readLearnings(repoRoot), capBytes)
}

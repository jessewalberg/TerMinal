// Minimal YAML-frontmatter parser for the flat schemas we read (tickets,
// sessions): scalars + single-line string/number arrays. No YAML dep.
export function parseFrontmatter(md: string): { fm: Record<string, unknown>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: md }
  const fm: Record<string, unknown> = {}
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([\w-]+):\s*(.*)$/)
    if (!mm) continue
    const [, key, rawVal] = mm
    const val = rawVal.trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else if (val.startsWith('"') && val.endsWith('"')) {
      // writers emit titles via JSON.stringify — JSON-unescape when valid so
      // quoted characters round-trip; fall back to a naive strip for legacy
      try {
        fm[key] = JSON.parse(val)
      } catch {
        fm[key] = val.slice(1, -1)
      }
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '')
    }
  }
  return { fm, body: m[2] }
}

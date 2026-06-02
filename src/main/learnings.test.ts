import { describe, expect, test } from 'bun:test'
import { parseLearning, buildLearningsPreamble, isLearningDoc } from './learnings'

describe('isLearningDoc', () => {
  test('accepts real learning markdown', () => {
    expect(isLearningDoc('0001-esm-dirname.md')).toBe(true)
    expect(isLearningDoc('some-gotcha.markdown')).toBe(true)
  })
  test('rejects README/INDEX explainers and non-markdown (#15)', () => {
    expect(isLearningDoc('README.md')).toBe(false)
    expect(isLearningDoc('readme.md')).toBe(false)
    expect(isLearningDoc('INDEX.md')).toBe(false)
    expect(isLearningDoc('notes.txt')).toBe(false)
  })
})

describe('parseLearning', () => {
  test('takes the H1 as title and the first body line as summary', () => {
    const md = '# Avoid ESM __dirname\n\nUse fileURLToPath(import.meta.url) — __dirname throws.\n'
    expect(parseLearning(md, '0001-esm.md')).toEqual({
      title: 'Avoid ESM __dirname',
      summary: 'Use fileURLToPath(import.meta.url) — __dirname throws.',
    })
  })

  test('skips YAML frontmatter and list/quote markers', () => {
    const md = '---\ntype: bug\n---\n# Title\n\n- the actual one-liner\n'
    expect(parseLearning(md, 'x.md')).toEqual({ title: 'Title', summary: 'the actual one-liner' })
  })

  test('falls back to filename when there is no H1', () => {
    expect(parseLearning('no heading here\n', '0007-thing.md')).toEqual({
      title: '0007-thing',
      summary: 'no heading here',
    })
  })
})

describe('buildLearningsPreamble', () => {
  test('empty notes → empty string (inject nothing)', () => {
    expect(buildLearningsPreamble([])).toBe('')
  })

  test('renders a header + one bullet per note', () => {
    const out = buildLearningsPreamble([
      { title: 'A', summary: 'do x' },
      { title: 'B', summary: '' },
    ])
    expect(out).toContain("Prior gotchas from this repo's docs/learnings")
    expect(out).toContain('- A: do x')
    expect(out).toContain('- B\n')
  })

  test('caps the total size, dropping overflow notes', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ title: `note-${i}`, summary: 'x'.repeat(50) }))
    const out = buildLearningsPreamble(many, 500)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(500)
    expect(out).toContain('- note-0')
    expect(out).not.toContain('- note-199')
  })
})

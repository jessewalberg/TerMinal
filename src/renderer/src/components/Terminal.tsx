import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { X } from 'lucide-react'
import type { Choice } from './EntryScreen'
import { rewriteCodexSkillSubmit } from '../lib/codexSkillInput'
import { isFindHotkey } from '../lib/hotkeys'

// Hosts the real Claude Code or Codex CLI: xterm.js renders, the PTY (main
// process) runs the chosen engine. Same pattern VS Code's integrated
// terminal uses.
export function TerminalPane({
  sessionKey,
  choice,
  onStarted,
  active = false,
}: {
  sessionKey: string
  choice: Choice
  onStarted?: (info: { sessionId: string; cwd: string }) => void
  active?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => termRef.current?.focus())
  }, [active])

  // Focus the find box when it opens.
  useEffect(() => {
    if (findOpen) requestAnimationFrame(() => findInputRef.current?.select())
  }, [findOpen])

  const runFind = (dir: 'next' | 'prev', q = query) => {
    if (!q) return
    if (dir === 'next') searchRef.current?.findNext(q)
    else searchRef.current?.findPrevious(q)
  }
  const closeFind = () => {
    setFindOpen(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const term = new Xterm({
      fontFamily: "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000, // sessions stay mounted for long stretches (#19)
      theme: {
        background: '#0a0a0f',
        foreground: '#e7e7ee',
        cursor: '#7c5cff',
        selectionBackground: '#7c5cff44',
        black: '#0a0a0f',
        brightBlack: '#5b5b6e',
      },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    term.loadAddon(new WebLinksAddon((_e, uri) => window.gt.openExternal(uri)))
    term.open(el)
    fit.fit()

    const gt = window.gt
    let skillNames = new Set<string>(choice.engine === 'codex' ? ['ticket'] : [])
    if (choice.engine === 'codex') {
      gt.listSkills()
        .then((skills) => {
          skillNames = new Set(
            skills
              .filter((s) => s.platforms.includes('codex'))
              .map((s) => s.name),
          )
        })
        .catch(() => {
          /* the fallback set above keeps /ticket usable */
        })
    }

    let lineBuffer = ''
    const writeInput = (data: string) => {
      if (choice.engine !== 'codex') {
        gt.pty.input(sessionKey, data)
        return
      }
      if (data.includes('\x1b')) {
        lineBuffer = ''
        gt.pty.input(sessionKey, data)
        return
      }

      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const rewritten = rewriteCodexSkillSubmit(lineBuffer, skillNames)
          const clearLine = '\x7f'.repeat(lineBuffer.length)
          lineBuffer = ''
          if (rewritten) {
            gt.pty.input(sessionKey, `${clearLine}${rewritten}`)
          } else {
            gt.pty.input(sessionKey, ch)
          }
          continue
        }
        if (ch === '\x7f') {
          lineBuffer = lineBuffer.slice(0, -1)
          gt.pty.input(sessionKey, ch)
          continue
        }
        if (ch === '\x03' || ch === '\x15') lineBuffer = ''
        else if (ch >= ' ') lineBuffer += ch
        gt.pty.input(sessionKey, ch)
      }
    }

    // Cmd+C / Cmd+V are handled natively by Electron's default Edit menu — don't
    // add a custom key handler too, or copy/paste fires twice (duplicates).
    // right-click: copy the selection if any, else paste (classic terminal UX).
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      if (term.hasSelection()) gt.clipboardWrite(term.getSelection())
      else gt.clipboardRead().then((t) => t && writeInput(t))
    }
    el.addEventListener('contextmenu', onContext)
    // Cmd+F opens scrollback search — but ONLY when focus is inside this pane,
    // so it doesn't steal Cmd+F from the Files tab or other inputs (#19).
    const onFindKey = (e: KeyboardEvent) => {
      if (!isFindHotkey(e) || !el.contains(document.activeElement)) return
      e.preventDefault()
      setFindOpen(true)
    }
    document.addEventListener('keydown', onFindKey)
    // attach listeners BEFORE starting the pty so no early output is missed.
    // Filter by sessionKey: every session's pty streams to all listeners.
    const offData = gt.pty.onData((key, d) => key === sessionKey && term.write(d))
    const offExit = gt.pty.onExit(
      (key) => key === sessionKey && term.write('\r\n\x1b[2m── process exited ──\x1b[0m\r\n'),
    )
    const onInput = term.onData(writeInput)

    // spawn the chosen engine attached to the session, sized to the live terminal
    gt.startSession(sessionKey, { ...choice, cols: term.cols, rows: term.rows }).then((info) =>
      onStarted?.(info),
    )

    // Debounce fit to a frame and only resize when the cell grid actually
    // changes — calling fit() synchronously inside the observer makes xterm
    // re-layout, which re-fires the observer ("ResizeObserver loop") and
    // thrashes the layout (visible flicker).
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const dims = fit.proposeDimensions()
        if (!dims || !dims.cols || !dims.rows) return
        if (dims.cols === term.cols && dims.rows === term.rows) return
        fit.fit()
        gt.pty.resize(sessionKey, { cols: term.cols, rows: term.rows })
      })
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('contextmenu', onContext)
      document.removeEventListener('keydown', onFindKey)
      offData()
      offExit()
      onInput.dispose()
      ro.disconnect()
      term.dispose()
      if (termRef.current === term) termRef.current = null
      if (searchRef.current === search) searchRef.current = null
    }
  }, [])

  return (
    <div className="relative h-full w-full">
      {findOpen && (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-lg border border-[var(--gt-border)] bg-[var(--gt-panel)] px-2 py-1 shadow-lg">
          <input
            ref={findInputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              runFind('next', e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                runFind(e.shiftKey ? 'prev' : 'next')
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
            placeholder="Find in scrollback…"
            spellCheck={false}
            className="w-44 bg-transparent text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />
          <button
            onClick={() => runFind('prev')}
            title="Previous (Shift+Enter)"
            className="px-1 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            ↑
          </button>
          <button
            onClick={() => runFind('next')}
            title="Next (Enter)"
            className="px-1 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            ↓
          </button>
          <button onClick={closeFind} title="Close (Esc)" className="text-zinc-500 hover:text-zinc-200">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      <div ref={ref} className="h-full w-full px-2 py-1" />
    </div>
  )
}

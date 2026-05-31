import type { EngineId } from './settings'

// Pure construction of the headless one-shot command for an agent run. Kept
// dependency-free (like pipelines.ts / cycle.ts) so it's unit-testable without
// pulling in the electron-coupled agents runtime. The resolved binary is
// injected — engine→executable resolution (enginePath) is the caller's job.
//
//   codex  needs `-C <worktree>`; claude uses the spawn cwd;
//   cursor uses `--workspace <worktree>` and `--force` (run-everything), the
//   non-interactive equivalent of codex's danger-full-access.

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`)

export function buildEngineCmd(
  bin: string,
  engine: EngineId,
  worktree: string,
  prompt: string,
  model?: string,
): string {
  const modelFlag = model ? ` --model ${shq(model)}` : ''
  if (engine === 'claude') {
    return `${shq(bin)} -p ${shq(prompt)} --dangerously-skip-permissions${modelFlag}`
  }
  if (engine === 'cursor') {
    // stream-json + --stream-partial-output: cursor's default `text` format
    // buffers the whole turn and prints it only on completion, so a live run
    // shows nothing for minutes (looks hung) — unlike claude/codex which stream
    // through the script(1) PTY. NDJSON deltas are decoded back to plain text by
    // createCursorStreamDecoder() in the runtime (see cursor-stream.ts).
    return `${shq(bin)} -p ${shq(prompt)} --force --workspace ${shq(worktree)}${modelFlag} --output-format stream-json --stream-partial-output`
  }
  return `${shq(bin)} exec -s danger-full-access -C ${shq(worktree)}${modelFlag} ${shq(prompt)}`
}

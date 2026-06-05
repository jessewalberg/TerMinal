**Verdict: REQUEST-CHANGES**

**Findings**

1. **major - [src/main/telegram.ts](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/telegram.ts:468), [src/main/telegram.ts](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/telegram.ts:1045)**  
   Telegram `/resolve` and inline HITL Resolve call `resolveHitl` directly, but only the Electron IPC path calls `resumeGate` at [src/main/index.ts](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/index.ts:839). A plan gate resolved from Telegram is marked resolved while the run stays parked with no child process.  
   **Fix:** centralize HITL resolution so every resolve surface looks up the item, resolves it, and calls `resumeGate(item.runId)` for agent run-linked gate items.

2. **major - [src/renderer/src/App.tsx](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/renderer/src/App.tsx:328), [src/renderer/src/App.tsx](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/renderer/src/App.tsx:814)**  
   The composer receives `activeWorkspaceRoot`, but that is the session cwd, not the git repo root. If the active terminal is in `/repo/packages/api`, `TaskComposer` will not match it against fleet repo paths at [TaskComposer.tsx:47](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/renderer/src/components/TaskComposer.tsx:47) and can default to the last-used or first repo. That can start an expensive task in the wrong repo.  
   **Fix:** pass `activeCtx?.repoRoot` or resolve the cwd to a git root before giving it to the composer.

3. **major - [src/main/agents.ts](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/agents.ts:1042)**  
   Role-less cursor script-first runs are no longer byte-identical: the decoder is now gated by `&& !scriptPath`. Before this series, untagged cursor runs used the cursor decoder even when a script existed. This violates the explicit daily-driver guarantee for steps without roles.  
   **Fix:** preserve the old decoder behavior for untagged steps, or make this an explicit compatibility-breaking bug fix with targeted regression coverage.

4. **major - [src/main/agents.ts](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/agents.ts:1150), [src/main/agents.ts](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/agents.ts:591)**  
   Parked gate terminal states are stale. Hard cap deletes the pending gate and finalizes `interrupted` without clearing `run.gateWaiting`; startup recovery also changes `running` to `interrupted` without clearing it. The Runs tab shows the approve button whenever `gateWaiting` is true at [runs/index.tsx:454](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/renderer/src/tabs/runs/index.tsx:454), so interrupted runs can display a no-op approve action.  
   **Fix:** clear `gateWaiting` before finalizing interrupted recovered/reaped gate runs, and close or update the associated HITL item.

5. **minor - [src/renderer/src/tabs/runs/index.tsx](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/renderer/src/tabs/runs/index.tsx:456), [src/main/index.ts](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/index.ts:711)**  
   Runs-tab approval resumes the gate but does not resolve the HITL item created in [agents.ts:899](/Volumes/home-ext/projects/TerMinal/.claude/worktrees/task-routing/src/main/agents.ts:899). The run proceeds, but the HITL inbox keeps a stale plan approval item.  
   **Fix:** store the HITL id returned by `fileHitl` and resolve it from the resume hook, including Runs-tab approval.

**What I Verified**

- Confirmed the reviewed scope with `git log origin/main..HEAD --oneline`: 11 commits.
- Inspected `git diff origin/main..HEAD` and focused file hunks for `agents.ts`, `routing.ts`, settings migration, IPC, composer, Runs tab, cursor ledger, cron, and bg tasks.
- Ran `git diff --check origin/main..HEAD`: no whitespace errors.
- I did not rerun the full suite or `tsc`; the prompt states 375 tests pass and TypeScript is clean.

---
reviewer: codex (codex exec, read-only, separate process — reviewer ≠ implementer)
scope: git diff origin/main..HEAD (11-commit task-routing series, pre-fix tip 6674972)
verdict: request-changes (4 major, 1 minor)
addressed-by: bd73f91cfd0e2394d88f36ba41a66bd788ad4d1c — all five findings fixed; suite 377 green post-fix
date: 2026-06-05

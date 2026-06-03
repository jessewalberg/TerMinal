---
id: 0010
title: A "wedged session" is an unattended agent stuck on the same failing action with no progress past it — not just a repeated error signature
anchor: ADR-0010
status: accepted
date: 2026-06-03
owner: Jesse
area: observability / wedged-session detector / HITL noise
confidence: high
supersedes:
superseded-by:
---

## [1] Context

The wedged-session detector (`src/main/wedged-session-detector.ts`) files a
HITL ("Session likely wedged") when it believes an agent is stuck looping on
the same problem. In practice it fired repeatedly on healthy sessions, training
the user to ignore it (alert fatigue).

A deep dive (multi-agent workflow + manual transcript replay) classified **every
recently-flagged session as a false positive**, verified against the real
transcripts in `~/.claude/projects` and the filed HITLs in
`~/.config/TerMinal/hitl.json`:

- `candidate-assessment` — `Exit code 1` ×3: three **different** benign commands
  (`git merge-base` diagnostic, `gh pr create`→"No commits between",
  `gh pr create`→"PR already exists").
- `peak6` — `429` ×3: textbook exponential backoff on a public RPC, then a pivot
  to another provider.
- `TerMinal` (its own driving session) — `File has been modified since read` ×4:
  an edit-conflict burst that recovered ~20s later.
- `sales-agent` — `File has not been read yet` ×4: edit-conflict burst, recovered
  (filed by a pre-recovery-heuristic build).
- `nerdletters` — `MCP error -32xxx no repo matching` ×3: three distinct
  `file_ticket` calls; the agent self-diagnosed and routed around it.

The original definition of "wedged" was operationally: *the SHA1 of the first
non-empty line of a tool result recurs ≥3 times within a 10-minute window.* This
is wrong in four ways, all confirmed against real data:

1. **Signature collapse.** Claude's Bash tool prepends a literal `Exit code N`
   banner on every non-zero exit, and the signature only hashed the first line —
   so all non-zero exits (~74% of which are exit 1) collapsed into one bucket.
2. **No liveness.** It counted repeats anywhere in a window with no check for
   successful progress after the failure or whether the failure was still the
   latest activity.
3. **Successes counted as failures.** A successful result whose body merely
   contained "error"/"failed" (e.g. a `curl` returning a JSON `{"error":…}` body,
   or a `Read` of a file mentioning error handling) was treated as a failure.
4. **No transient/config carve-out + recovery race.** Rate limits, network blips,
   MCP/config errors, and not-yet-written edit-conflict recoveries all counted.

The team had been patching these one literal-string class at a time
(`isRecoveredEditConflictError`, `isSecondaryParallelCancellation`, the codex
exit-code envelope) — whack-a-mole on symptoms of a wrong definition.

## [2] Decision

Redefine "wedged" and rebuild the detector around it:

> A session is **wedged** when an *unattended* agent **repeats the same failing
> action and that action is still its most recent activity, with no successful
> progress past it** — i.e. the *same command / same error* fails
> `REPEAT_FLOOR`+ times, the latest occurrence still has no successful tool
> result after it, the session is unattended (no human typing after the errors),
> and the failure is one **retrying could plausibly fix** (transient infra and
> deterministic config/auth errors are excluded, not flagged as "wedged").

Implemented as (F-numbers map to the diagnosis):

- **F-1** Signature keys on the real error line (the `Exit code N` banner is
  stripped) **and** the scrubbed command — so the same command failing the same
  way clusters, but unrelated failures sharing a banner stay distinct.
- **F-2** Only `is_error===true` results count on the Claude path (the loose
  `ERROR_RE`-on-any-text heuristic is removed). Inspection-tool successes never
  count.
- **F-3** Transient (HTTP 429/5xx, ECONNRESET/ETIMEDOUT/…) and deterministic
  config/transport (`no repo matching`, `MCP error -`, unauthorized, EACCES)
  failures are excluded from wedge counting.
- **F-4** `findWedges` reports the qualifying sub-window's `repeats`/`windowMs`,
  not the whole bucket span.
- **F-5** Edit-conflicts whose recovery window has not yet elapsed in the
  captured data are **deferred** (re-evaluated next scan) instead of racing the
  growing transcript.
- **F-6** A liveness gate: fire only if the latest occurrence of the error has no
  successful tool result after it.
- **F-7** Attended sessions (a genuine human string-content user message dated
  after the wedge's last error) are skipped.

## [3] Options considered

- **Keep patching string-class suppressors** (status quo). Rejected: unbounded
  whack-a-mole; the next benign-but-repeated thing re-trips it.
- **Disable the detector.** Rejected: a genuinely looping unattended agent
  burning budget overnight is exactly what HITL should catch.
- **LLM-judge each candidate wedge.** Rejected for now: cost + latency on a
  5-minute background loop; the structural fix removes the false positives
  deterministically. Could revisit if precision is still insufficient.
- **Redefine + rebuild around liveness/scope (chosen).**

## [4] Tradeoffs / risks

- **Accepted false negatives, all low-stakes:**
  - A real wedge that *interleaves a trailing successful diagnostic* after its
    last failure won't fire (F-6). Acceptable: the failure isn't the tail.
  - A genuinely endless transient loop (an agent hammering a 429 forever without
    pivoting) won't fire (F-3). Acceptable: not human-actionable as "unstick the
    loop"; could be reclassified into its own alert later.
  - A human who walks away mid-loop after typing is treated as attended (F-7).
    Acceptable per the "a human is on it" rationale.
- **F-7 heuristic** keys on string-content user messages. If a future harness
  injects string-content user turns into *headless* runs, those could look
  attended. Mitigated by requiring the human turn to post-date the last error;
  revisit if headless injection patterns change.
- **Signature change invalidates** existing `wedged-sessions.json` marker keys
  (harmless: they just stop matching; pruned at 24h).

## [5] What would change our mind

- If real wedges slip through (false negatives) in practice, tighten F-6 toward
  "failures dominate the recent tail" (consecutive-run / density) rather than
  "no success after last error", and/or add the transient-loop reclassification.
- If F-7 suppresses real unattended wedges because of harness-injected user
  turns, switch the attended signal to an explicit headless/interactive marker
  if one becomes available in the transcript.
- If precision is still poor after F-1…F-7, add an LLM-judge gate on surviving
  candidates.

## [6] Follow-up work

- Backlog `0038` tracks optional hardening: transient-loop reclassification into
  its own actionable alert, and an explicit headless-vs-interactive signal.
- Consider auto-resolving the stale false-positive wedge HITLs already on disk.

## [7] Sources

- `src/main/wedged-session-detector.ts`, `src/main/wedged-session-detector.test.ts`
- `src/main/ai-collectors.ts:354,358` (5-min scan cadence)
- Real transcripts under `~/.claude/projects/` and `~/.config/TerMinal/hitl.json`
- Multi-agent diagnosis workflow (34 agents, 17/22 findings confirmed under
  adversarial verification), session 2026-06-03.

# testing — test runner detection reference

How the review agent detects and runs this repo's test suite. Results
are embedded in the unified review artifact at `.reviews/<pr-number>/<sha>.md`
(see [`code-review.md`](./code-review.md)). The `/test-suite` skill follows the
same detection logic but reports to chat without writing an artifact.

## Detect the runner

Inspect the repo in this order; if multiple match, prefer the one CI runs
(see `.github/workflows/`):

| Project file | Likely runner | Command |
|---|---|---|
| `package.json` → `scripts.test` | `bun test`, `vitest`, `jest`, `mocha`, `node --test` | from the script |
| `pyproject.toml` / `setup.py` / `tox.ini` | `pytest`, `tox`, `unittest` | `pytest`, `tox`, `python -m unittest` |
| `Cargo.toml` | `cargo test` | `cargo test` |
| `go.mod` | `go test` | `go test ./...` |
| `Gemfile` | `rspec` / `rake test` | `bundle exec rspec` / `bundle exec rake test` |
| `mix.exs` | `mix test` | `mix test` |
| `.github/workflows/*.yml` | fall back | the test `run:` step |

## Install deps if missing

Only if the lock/manifest indicates deps aren't resolved (no `node_modules/`,
no `.venv/`, etc.). Use the project's standard step. Per global CLAUDE.md §5,
prefer `bun install` over `npm install` even when a `package-lock.json` exists.

## Run

Capture combined stdout+stderr, exit code, and wall-clock time. **One run per
invocation** — don't retry until green. Flaky tests are findings, not silent
retries. Don't run partial subsets when CI runs the full suite.

## E2E / integration coverage (first-class)

Unit tests prove a function works; **automated e2e / integration tests prove the
feature is actually wired and stays correct end-to-end** — they exercise a real
production entry point (HTTP route, UI flow, CLI, job) the way a user/client
hits it. They are the runtime counterpart to the reachability check in
`code-review.md` ("tests passing ≠ shipped").

- **Detect e2e suites:** Playwright (`playwright.config.*`, `e2e/`/`tests/e2e`),
  Cypress, `supertest`/`fetch` against a booted server, API contract tests, etc.
- **Critical for any user-facing or multi-component behavior.** A PR that adds a
  route/UI/flow with only unit tests and no e2e/integration coverage of the real
  entry point is a testing finding — the wiring is unproven.
- **The fast gate may exclude slow/browser e2e.** Browser-coupled Playwright
  often can't run in the quick `bun test` gate (needs a real browser/display).
  That's an **accepted, ticketed deferral** — track the e2e as its own
  suite/ticket run locally or in a dedicated CI job, and say so; it is *not* an
  excuse to skip e2e, just to run it outside the unit gate.
- **`-s danger-full-access` is Codex-specific.** The real Codex review caller
  passes `-s danger-full-access` to the session so loopback servers and browsers
  can launch inside the sandbox. If the review runs via the Claude-fallback path
  (no sandbox, no `-s` flag), e2e suites that need a display or a bound port
  **may not be runnable**. In that case: (a) skip the e2e run gracefully — do
  not fail the whole review because of environment limits; (b) record the
  limitation as a `partial` `test_status` with a note explaining why; and (c)
  file a follow-up ticket to run the e2e suite in a capable environment (Codex
  sandbox, local CI, or a dedicated CI job). This is a deferral, not a waiver —
  the e2e suite must eventually be run and verified.
- **Run what CI runs.** If CI runs the e2e job, the review's gate should reflect
  it; if e2e is local-only, note that the unit gate is partial and the e2e is a
  separate verification.

## Test quality (adversarial, not rigged) — reviewer findings

> **Model requirement:** this adversarial judgement requires genuine semantic
> reasoning. Use **sonnet or better** (not haiku) for the reviewer that runs
> this section. Haiku-tier models lack the reasoning depth to reliably catch
> tautological, over-mocked, or regression-blind tests.

A green suite of weak tests is **worse** than no tests — it manufactures false
confidence. When reviewing, treat these as **testing findings** (medium→high)
even when the suite passes:

- **Tautological / self-referential** — asserts the implementation's current
  output back at itself (would pass for any output the code happens to produce).
- **Weak assertions** — `assert not null` / `assert no throw` where a concrete
  value/shape contract exists and should be asserted.
- **Over-mocked** — the unit under test is mocked away, so the test exercises
  the mock, not the behavior.
- **Wouldn't fail on regression** — the test still passes if you delete or break
  the feature it nominally covers (the RED test never actually went red for the
  right reason).
- **Missing edge/failure cases** — only the happy path is asserted for behavior
  that has obvious boundaries or error modes.

The bar: a test must assert *meaningful* behavior and would catch a genuine
regression. New behavior covered only by rigged/weak tests is unverified — flag
it like missing coverage, not like passing coverage.

## Status rules (`test_status` frontmatter)

- `pass` — `exit_code == 0` AND `counts.failed == 0`
- `fail` — `counts.failed > 0`
- `partial` — some suites ran, some couldn't (e.g. compile error in one package)
- `error` — couldn't run at all (no runner, install failed). Use honestly;
  never pretend a non-run is a pass.

## What NOT to do

- Don't edit test files to make them pass — failing tests become findings.
- Don't mark `pass` when tests were skipped due to install failures (`error`).
- Don't re-run until green.

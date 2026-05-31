---
id: 0004
title: workspace:bootstrap clones the template when no local checkout exists
anchor: ADR-0004
status: accepted
date: 2026-05-31
supersedes:
superseded-by:
---

## [1] Context

The in-session **Bootstrap** banner (`SessionView.tsx` → `workspace:bootstrap`)
retrofits an existing repo by running `templates/project-template/bootstrap.sh`
against it. In the **packaged app** this failed every time with:

> project-template checkout not found — initialize templates/project-template or
> set Settings → template repo to a local project-template path

Root cause: `electron-builder.yml` ships only `out/**` + `package.json`, so the
`templates/project-template` submodule is **not bundled**. The old
`localProjectTemplateRoot()` probed `app.getAppPath()` / `process.cwd()` /
`moduleDir/../..` (all inside the asar) plus a configured *local* path, found no
`bootstrap.sh`, and returned `''` → hard error. `scaffoldProject` had already
solved the identical problem for *new* projects by falling back to a shallow
clone of `resolvedTemplateRepo()` (`scaffold.ts` `templateSource()`), but the
bootstrap path never got that fallback. Net effect: scaffolding new repos
worked; retrofitting existing repos was dead in every shipped build. Tracked as
ticket #0016.

## [2] Decision

**[2.1] Template resolution is a pure, injectable unit.** New
`src/main/template.ts` (`pickTemplateSource`, `isTemplateUrl`) is electron-free
and unit-tested (`template.test.ts`), following the `settings.ts` /
`engine-cmd.ts` "keep the logic pure, inject the side effects" pattern.
`pickTemplateSource` takes the candidate dirs, a `hasBootstrap` probe, the
template repo, and a `cloneToTmp` function, and returns `{dir, cleanup?}` or
`{error}`.

**[2.2] `workspace:bootstrap` falls back to cloning.** It builds the local
candidate dirs (`templateDirCandidates()`), and when none expose `bootstrap.sh`
shallow-clones `resolvedTemplateRepo()` into a tmp dir (`cloneTemplateToTmp`,
mirroring `scaffold.ts`), runs the script, and removes the temp clone in
`finally`. The old `localProjectTemplateRoot()` is removed; `sourceCheckoutRoot`
(still used by the in-app rebuild path) stays.

## [3] Tradeoffs & known limitations

- **`telegram.ts` `/install <agent>` keeps its own un-fallback'd copy** of
  `sourceCheckoutRoot` / `localProjectTemplateRoot` (it probes the template's
  `.agents/`, not `bootstrap.sh`). Same packaged-app limitation, but a different
  command — left out to keep this change small. Dedupe tracked as ticket #0033.
- **`scaffold.ts` still duplicates** the local-or-clone logic rather than calling
  `pickTemplateSource`; unifying both onto `template.ts` is part of #0033.
- The clone uses `--depth 1` against the configured repo (default
  `github.com/trevormil/project-template`); offline with no local checkout still
  errors — now with a clearer message — it just no longer hard-fails when a clone
  is possible.
- **Partial-adoption detection is still open** (#0016): `isBootstrapped` checks
  only `.agents/`, so repos with `.agents/` but no `backlog/`/`sessions/` never
  re-prompt.

## [4] What would change our mind

- If `templates/project-template` were bundled into the app (e.g. via
  `extraResources`), the local checkout would always exist and the clone path
  becomes dead weight — drop it.
- If template resolution diverges meaningfully between scaffold and bootstrap
  (different markers, refresh policy), two focused resolvers may beat one
  over-parameterized `pickTemplateSource`.

# Task: standalone runner (Storybook test-runner mode)

**Status:** **shipped** (Phase R-1..R-5 complete as of 2026-05-24).
**Position:** sibling capture path to the Vitest plugin, not a
successor. Both are first-class.
**Design:** `design/RUNNER.md`
**Decision context:**
- `../../../PROGRESS.md` 2026-05-22 — "Standalone runner direction"
  (initial design)
- `../../../PROGRESS.md` 2026-05-23 — "Runner direction LOCKED"
  (decision after empirical OOM tests with default vitest pool config)
- `../../../PROGRESS.md` 2026-05-24 — "Multi-shard orchestration"
  (Phase R-5 ships)
- `../../../PROGRESS.md` 2026-05-25 — "Vitest plugin path saved via
  pool: 'forks' + maxForks: 3" (the "architecturally limited" claim
  below was retracted)

**Why the framing below was retracted (2026-05-25).** The 2026-05-23
OOM tests were run with vitest's default pool config (threads,
unbounded fileParallelism). Switching to `pool: 'forks' + maxForks: 3
+ isolate: true` lifted the wall — qorus-ide completes the full
90-file suite in 7 min at 7.9 GB peak. The runner remains the right
answer for consumers pinned to old Vitest versions or who already use
`@storybook/test-runner` for other reasons, but it is no longer
"the only path" for application-class Storybooks. See
`design/INTEGRATION_PATHS.md` for the current decision matrix.

> Historical framing (kept for context):
> *Severity: demo-blocker for the primary target (qorus-ide). The
> Vitest plugin path is architecturally limited at qorus-ide's
> scale; the runner library is the only path that delivers "super
> good and fast" on application-class Storybooks. Verified via 3 OOM
> tests on 2026-05-23.*

## Architecture update (2026-05-23)

The original design in `design/RUNNER.md` proposed a standalone
`qlip-runner` CLI that spawns `@storybook/test-runner` as a child
process. After researching how Argos's `@argos-ci/storybook` actually
works, the right shape is **simpler**: provide a **library export**
that consumers wire into their own `.storybook/test-runner.ts`.

Specifically:
- Export `@qoretechnologies/qlip/test-runner` with a `qlipCapture`
  function compatible with `TestRunnerConfig['postVisit']`
- Consumer installs `@storybook/test-runner` themselves and runs
  it themselves (no child-process spawning by us)
- We provide an optional `qlip-serve-and-test` helper CLI for
  consumers who want one-command UX

This pattern matches Argos's `@argos-ci/storybook/test-runner` export
verbatim. ~2-3 days instead of 5.

See `../../docs/RUNNER_IMPLEMENTATION_PLAN.md` for the full
phase-by-phase plan.

## Goal

Add a second capture path that runs on `@storybook/test-runner`
instead of the consumer's Vitest. Same output (manifest +
screenshots), same upload protocol, same review UI. The Vitest
plugin path stays unchanged.

## Phases

Implementation is broken into five phases that ship independently.
Each phase ends in a runnable state (or a clean no-op state) so we
can pause / resume without orphan code.

### Phase R-1 — Skeleton + test-runner driver

- [ ] Create `src/runner/` directory.
- [ ] Add `src/runner/cli.ts` with yargs-based arg parsing for the
      flags listed in `design/RUNNER.md` §"CLI surface".
- [ ] Add `"bin": { "qlip-runner": "./dist/runner/cli.js" }` to
      `package.json`.
- [ ] Add `"@storybook/test-runner"` to `peerDependencies` with
      `peerDependenciesMeta` marking it (and `vitest`) optional.
- [ ] Add subpath export `"./runner"` pointing at
      `./dist/runner/index.js`.
- [ ] Add `src/runner/test-runner-config.ts` that builds a
      `TestRunnerConfig` with empty `preVisit` + `postVisit` hooks
      (still a no-op at this phase — wired in phase R-2).
- [ ] Add `src/runner/index.ts` exporting `runQlipCapture()` (the
      programmatic API). v1 implementation just shells out to
      test-runner with the generated config.

**Done when:** `yarn qlip-runner --url http://localhost:6006` runs
the test-runner against an external Storybook, exits cleanly, and
prints "no captures yet (skeleton)." No screenshots written.

### Phase R-2 — Capture hook

- [ ] Port `applyAnimationControl` / `waitForDomIdle` /
      `applyIgnoreMasks` from `src/runtime/screenshot.ts` into
      `src/runner/prep.ts`. Each function becomes a string body that
      can be passed to `page.evaluate()`.
- [ ] Add `src/runner/capture.ts` implementing the `postVisit` body
      per the lifecycle in `design/RUNNER.md` §"Capture lifecycle":
      `getStoryContext` → `resolveQlipOptions` → prep → screenshot →
      manifest entry.
- [ ] Wire `capture.ts` into `test-runner-config.ts` so every story
      gets a screenshot written under
      `<outputDir>/<buildId>/stories/auto/<title>--<name>.png`.
- [ ] Add `src/runner/manifest-store.ts` — single-process accumulator
      that mirrors `QlipManifest` from `src/types.ts`. Writes one
      fragment at end of run so the existing
      `mergeManifestFragments()` can still be the chokepoint.
- [ ] Add unit tests for `prep.ts` (DOM mutation, mask placement,
      animation pause) using `happy-dom` or `jsdom` — same fixture
      style as `src/runtime/screenshot.ts`'s coverage.

**Done when:** screenshots land on disk for every story in the
target Storybook, and `manifest-fragments/runner.json` is written.
No upload yet.

### Phase R-3 — Static server + manifest + upload (MVP)

- [ ] Add `src/runner/server.ts`: spawn an `http-server` (or
      equivalent) bound to a free port when `--storybook-static
      <dir>` is passed. Return the URL + a teardown function. Pick
      port via `get-port` to dodge collisions.
- [ ] Wire end-of-run sequence in `cli.ts`:
      `mergeManifestFragments(buildDir)` → if upload configured →
      `uploadBuild({ buildDir, options })`.
- [ ] Honour `QLIP_UPLOAD_URL` / `QLIP_UPLOAD_TOKEN` / `QLIP_PROJECT`
      env vars + `--fail-on-upload-error` flag.
- [ ] Hook teardown on `process.on('exit'|'SIGINT'|'SIGTERM')` so
      the static server doesn't outlive a Ctrl-C.

**Done when:** `qlip-runner --storybook-static ./storybook-static`
with `QLIP_UPLOAD_URL` set produces a build in qlip-server that the
review UI renders correctly.

### Phase R-4 — Smoke + polish + 0.2.0-beta cut

- [ ] E2E smoke against `qlip-playground` — same procedure as the
      Vitest path uses; should produce identical-looking builds.
- [ ] (With explicit user permission) E2E smoke against `qorus-ide`
      with the runner. Verify Vitest 2.1 + Storybook 8.5 works.
- [ ] README update — document the runner path alongside the Vitest
      plugin, with the consumer command snippet.
- [ ] Lock `design/RUNNER.md` from "design only" to "shipped" — add
      a PROGRESS.md decision log entry recording any spec drift from
      the design.
- [ ] Publish `0.2.0-beta.<timestamp>` so external consumers can
      pin it without grabbing from git.

**Done when:** any external Storybook consumer can install
`@qoretechnologies/qlip` + `@storybook/test-runner` + run the
`qlip-runner` CLI against their built Storybook and see their build
in qlip-ui.

### Phase R-5 — v2 features (open-ended)

Track each as its own task; not required for runner MVP.

- [ ] Manual screenshots inside play functions via
      `page.exposeBinding('__qlip_screenshot', ...)`.
- [ ] Error captures on test-runner reported story failures.
- [ ] `parameters.qlip.fullPage` for long-page captures (server side
      already accepts; just plumb in the runner).
- [ ] Storybook 9 verification — bump peer range, add a smoke
      fixture, test against a SB9 playground.
- [ ] Parallel browser contexts (`--max-workers > 1`). Default stays
      `1` until we have a memory-budget heuristic.

## Out of scope for this task

Track separately when relevant; explicitly NOT part of the runner
direction:

- **qlip-server changes.** The wire protocol from `design/UPLOAD.md`
  is honoured exactly. No new endpoints, no schema changes.
- **qlip-ui changes.** Builds from either capture path render
  identically — the runner is invisible to the review UI.
- **Visual diff engine changes.** Already abstracted; capture path
  doesn't affect diffing.
- **Deprecating the Vitest plugin path.** Both paths coexist
  indefinitely. Vitest plugin remains the fast path for greenfield
  projects on the latest Vitest.

## Open design questions

Mirror of `design/RUNNER.md` §"Open questions" — pasted here so
implementers can knock them off without flipping between files.

1. `http-server` vs `sirv` for static-server spawn — recommendation:
   `http-server`, revisit only if dep weight matters.
2. `@storybook/test-runner` peer range — design recommends
   `^0.21.0`; lock the upper bound after smoke against latest stable.
3. Story-level `parameters.qlip.upload` override — declined for v1.
4. Per-story `fullPage` — declined for v1.
5. Manual `screenshot(name)` API in play functions — phase R-5.
6. Error captures on test-runner failures — phase R-5.
7. Manifest fragment vs single-file — keep fragments (one writer
   per run) to share the merger path with the Vitest plugin.

## Acceptance checklist (for phase R-3 = MVP)

- [ ] `qlip-runner` binary registered in `package.json`.
- [ ] `runQlipCapture()` programmatic API exported from
      `@qoretechnologies/qlip/runner`.
- [ ] CLI flags + env vars from design doc all honoured.
- [ ] Static-server path works (`--storybook-static <dir>`).
- [ ] External-URL path works (`--url <url>`).
- [ ] Every story produces one auto screenshot.
- [ ] Per-story `parameters.qlip` honoured (viewport, ignoreElements,
      skip, disableAnimations, pauseAnimationsAtEnd, waitForIdleMs).
- [ ] `manifest.json` written with one entry per captured story.
- [ ] Build POSTs to qlip-server when `QLIP_UPLOAD_URL` is set.
- [ ] Branch + commit auto-detection works (`$GITHUB_*` + git).
- [ ] Test-runner exit code propagates to the CLI exit code.
- [ ] `--fail-on-upload-error` flag respected.
- [ ] Smoke against `qlip-playground` produces a build that renders
      correctly in qlip-ui.
- [ ] `yarn precheck` passes — typecheck + lint + tests.
- [ ] README documents the runner path.

## References

- Design: `design/RUNNER.md`
- Cross-repo contract (unchanged): `design/UPLOAD.md`
- Existing Vitest plugin: `src/plugin/vitestPlugin.ts`
- Existing capture (to port): `src/runtime/screenshot.ts`
- Existing upload (reused): `src/upload/upload.ts`,
  `src/upload/manifest.ts`, `src/upload/autodetect.ts`
- Storybook test-runner README:
  https://github.com/storybookjs/test-runner
- The OOM incident that motivated `--max-workers 1` default: see
  `../../../PROGRESS.md` 2026-05-22 decision log.

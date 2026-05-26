# Task: Vitest 2 reporter compatibility

**Status:** shipped 2026-05-23 — see "Outcome" at the bottom.

**Original status:** in progress 2026-05-22
**Owner:** Nick
**Severity:** demo-blocker — without this, `@qoretechnologies/qlip` from
`feature/mvp` can't upload from any consumer pinned to Vitest 2 or 3.0
(notably `qorus-ide` on `^2.1.4`).
**Why this is a compat patch (not the runner):** see
`../../docs/RUNNER_VS_COMPAT.md`.

## Root cause

Today's plugin registers `QlipUploadReporter` via two mechanisms:

1. **`configureVitest` plugin hook** — pushes the reporter into
   `vitest.config.reporters` AFTER project resolution.
2. **The reporter exposes `onTestRunEnd`** as its only finalize hook.

Both are Vitest-3.1+ APIs:

- `configureVitest` was added in Vitest **3.1.0-beta.2** (PR #7349,
  March 2026). On Vitest 2.x it doesn't exist; the hook is silently
  never called.
- `onTestRunEnd` replaced the older `onFinished` lifecycle method in
  Vitest 3. On Vitest 2.x the Reporter interface only defines
  `onFinished(files, errors, coverage?)`; `onTestRunEnd` is not
  called.

Net effect on Vitest 2.x consumers: capture works (qlip runtime uses
the stable `@vitest/browser/context` page/commands surface), but the
reporter is never invoked → no manifest merge, no upload.

## Strategy

Dual-version registration in the plugin + dual-name finalize in the
reporter. Verified by reading Vitest 2.1 and Vitest 4.x dist sources:

**Reporter resolution (both versions):**
`createReporters` accepts pre-instantiated `Reporter` *instances*
verbatim. From `qorus-ide/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js`
line 5186 (V2.1) and `qlip/node_modules/.../cli-api.Cx2DW4Bc.js` line
10611 (V4):
```js
// if not a [name, opts] tuple, return as-is
return referenceOrInstance;
```

So pushing the instance into `config.test.reporters` survives on
both. The reason we originally moved to `configureVitest` was to
handle the workspace edge case where project-level reporters didn't
receive global lifecycle events — but in single-project consumers
(qorus-ide's `vitest.workspace.ts` has two projects but the
storybook project IS where the qlip plugin lives) the project-level
push still fires `onFinished`/`onTestRunEnd` for that project's
runs.

**Plugin changes (`src/plugin/vitestPlugin.ts`):**
1. In the `config` hook, push a fresh `QlipUploadReporter` instance
   into the returned `test.reporters` array (alongside the user's
   own reporters + `'default'`).
2. Keep the `configureVitest` registration as-is for Vitest 4 — the
   `reporterRegistered` dedup flag already prevents double-pushes
   when both mechanisms fire.

**Reporter changes (`src/upload/reporter.ts`):**
1. Add `onFinished(files?, errors?, coverage?)` method (Vitest 2 lifecycle)
   alongside the existing `onTestRunEnd()` (Vitest 3+/4 lifecycle).
2. Both delegate to a single private `finalize()` method.
3. Guard with a `finalized: boolean` instance flag so we never run
   the merge + upload twice (defensive — covers the case where
   both hooks fire on the same Vitest version).

**Peer-dependency change (`package.json`):**
- Widen `peerDependencies.vitest` from `^4.0.0` to `>=2.1.0 <5.0.0`.
- Add `peerDependenciesMeta` if needed for future optionality.

## Acceptance

- [ ] Plugin pushes reporter instance in `config` hook
- [ ] Reporter has `onFinished` + `onTestRunEnd` both delegating to
      shared `finalize()` with idempotency guard
- [ ] Peer-dep range widened
- [ ] `yarn precheck` clean
- [ ] Manual smoke: qlip-playground (Vitest 4) — upload still works
- [ ] Manual smoke: qorus-ide (Vitest 2.1) with a single small story
      file (`src/stories/Charts/JobStatus.stories.tsx`),
      `--no-file-parallelism --pool=forks --poolOptions.forks.singleFork`
      — upload arrives at qlip-server
- [ ] Two builds visible in qlip-ui under project `qorus-ide`
- [ ] qorus-ide repo fully reverted (vitest.workspace.ts back to
      `auto: false`, no `upload` block, `node_modules/@qoretechnologies/qlip`
      removed)
- [ ] qlip-server, qlip-ui still untouched (the contract is unchanged)
- [ ] Tracker marked done, `../docs/RUNNER_VS_COMPAT.md` written

## Phases (small)

1. Update reporter — add `onFinished` + `finalize` dedup.
2. Update plugin — push instance in `config` hook.
3. Update `package.json` peer-dep range.
4. Run `yarn precheck` — must stay green.
5. Local smoke against `qlip-playground` — sanity check Vitest 4 path.
6. Wire qorus-ide for ONE story (local link, scoped vitest run, low
   concurrency), confirm two uploads land.
7. Revert qorus-ide changes cleanly.
8. Write `../docs/RUNNER_VS_COMPAT.md`.

## Outcome (2026-05-23)

**Shipped.** Implementation:
- `src/upload/finalize.ts` (new) — shared `finalizeBuild()` function
  with process-global symbol-keyed idempotency flag.
- `src/upload/reporter.ts` — now slim. `onTestRunEnd` + `onFinished`
  both delegate to `finalizeBuild()`.
- `src/runtime/global-setup.ts` (new) — exports `setup` + `teardown`
  for Vitest's `globalSetup` API. `teardown()` calls `finalizeBuild()`.
  Plugin stashes runtime config on a symbol-keyed global so the
  teardown can pick it up (same Node process, no file I/O).
- `src/plugin/vitestPlugin.ts` — pushes reporter instance into
  `config.test.reporters` (V4 single-project path), keeps existing
  `configureVitest` push (V4 belt-and-suspenders), AND injects the
  globalSetup file (V2 workspace path).
- `package.json` — `peerDependencies.vitest` widened to
  `>=2.1.0 <5.0.0`.

**Why it was harder than initially planned.** The `config`-hook
reporter push works for V4 single-project AND V2 single-project,
but Vitest 2 in **workspace mode** (qorus-ide's setup) scopes
project-level reporters away from the end-of-run lifecycle —
verified in V2.1 `cli-api.js:10494` where `this.reporters` reads
from the *root* resolved config, not project configs. The fix was
to add a `globalSetup` teardown as a Node-side hook that fires
regardless of project scoping. Diagnosis came from running the
test live and seeing the reporter never fire, then reading the
V2 dist line-by-line.

**Verification.**
- `yarn precheck` clean (lint + typecheck + 44 unit tests).
- `qlip-playground` smoke (Vitest 4): one upload, 16 entries,
  no duplicates. Dedup flag confirmed working — both reporter
  and globalSetup teardown fire on V4 but only one finalize runs.
- `qorus-ide` smoke (Vitest 2.1): two builds uploaded to
  qlip-server, visible at
  `http://localhost:3100/api/builds?project=qorus-ide`
  (builds `20260523-000841` and `20260523-000901`).
- `qorus-ide` repo cleanly reverted — `git status --short
  vitest.workspace.ts package.json` shows no changes.

**Background reading written.**
`docs/RUNNER_VS_COMPAT.md` explains why we picked compat over
runner today + when to revisit.

## Out of scope

- The standalone runner direction (paused; see
  `design/RUNNER.md` + `.tasks/STANDALONE_RUNNER.md`).
- Vitest 1.x support — pre-2.1 reporter API has more drift; not
  worth the maintenance.
- Vitest 5+ support — when it lands, we'll re-evaluate.
- Anything in qlip-server / qlip-ui (the wire protocol is unchanged).

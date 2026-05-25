# Choosing your integration: Vitest plugin vs. standalone runner

> Status: living guide, written 2026-05-25 after qorus-ide-class workloads
> exposed the limits of the Vitest plugin path. Companion to
> `RUNNER.md` (architecture of the runner) and `UPLOAD.md` (the wire
> contract both paths share).

`@qoretechnologies/qlip` ships **two integration paths**. Both produce
identical manifest + screenshot bundles and POST to the same
`/api/builds/upload` endpoint on qlip-server — the server can't tell
them apart. Pick the path that fits your project's size + tooling.

---

## TL;DR — decision table

| Your Storybook | Recommended path | Why |
|---|---|---|
| < 50 stories | **Vitest plugin** | Zero extra dependencies; runs as a side effect of your existing `yarn test:stories`. |
| 50–150 stories, light/medium components | **Vitest plugin** | Still comfortable. Budget RAM if components are heavy. |
| 150+ stories OR full-app-shell stories OR dashboard-class components | **Runner** | Vitest browser-mode accumulates per-file module cache; large suites hit OOM. The runner shards into independent processes. |
| You're not sure | Start with Vitest plugin. Switch to runner if you OOM. Switching is just changing the invocation — nothing else moves. | |

The two paths are not redundant — they target different size envelopes.
Keep both available; consumers pick at integration time.

---

## Path A — Vitest plugin

**What it is.** A Vite plugin (`qlipVitestPlugin`) you add to your
`vitest.config.ts`. When Vitest runs your stories through the Storybook
Vitest addon, the plugin's afterEach hook captures a screenshot for
each story. If `QLIP_UPLOAD_URL` is set in env, the build is uploaded
when the test run finishes.

**Setup.** One plugin in `vitest.config.ts` — see [README.md](../README.md)
"Vitest setup" section.

**Invocation.** Whatever you already use to run Vitest (`yarn test:stories`,
`vitest --project=storybook`, etc.). No new commands.

**Strengths.**
- Zero new tools — one extra dependency.
- Screenshots happen as a side effect of normal tests; no separate "capture" step.
- Custom `it()`/`test()` blocks layered on top of stories still run (the runner doesn't see those).
- Vitest snapshot matchers, vitest mocks, vitest hooks all work normally.

**Limits.**
- Vitest creates a new BrowserContext per test file; per-file Node module cache never clears (acknowledged by the Vitest team — there's no API in Node to clear it).
- For qorus-ide-class workloads (215 files, several mounting the full IDE chrome), we measured **40 GB peak RSS and OOM** at ~file 55/215. Even with captures turned off — i.e. the OOM is in Vitest itself, not qlip.
- Sharding through addon-vitest doesn't work cleanly today; the addon resolves the full story set from Storybook's config and ignores Vitest's CLI file filters.

See `docs/WHY_NOT_VITEST_FOR_QORUS_IDE.md` at the project root for the
full trail of empirical evidence.

---

## Path B — Standalone runner

**What it is.** A CLI (`qlip-serve-and-test`) that builds a static
Storybook, serves it on a free port, spawns `@storybook/test-runner`
(Jest + Playwright) against it, and captures via a `postVisit` hook.
Same approach Argos and Chromatic use under the hood.

**Setup.**
1. `yarn add -D @storybook/test-runner` (peer; not bundled by qlip).
2. Add a `postVisit` hook in `.storybook/test-runner.ts`:
   ```ts
   import type { TestRunnerConfig } from '@storybook/test-runner';
   import { getStoryContext } from '@storybook/test-runner';
   import { qlipCapture } from '@qoretechnologies/qlip/test-runner';

   const config: TestRunnerConfig = {
     async postVisit(page, context) {
       await qlipCapture(page, context, { getStoryContext });
     },
   };
   export default config;
   ```

**Invocation.**
```bash
# Build storybook + serve + capture + upload, all in one:
yarn qlip-serve-and-test --shards 8

# Or, if you already have a static Storybook served somewhere:
yarn qlip-serve-and-test --url http://localhost:6006 --shards 8
```

Useful flags (full list in `qlip-serve-and-test --help`):

| Flag | Purpose |
|---|---|
| `--shards <n>` | Run test-storybook N times sequentially with `--shard k/N`. Each shard is a fresh subprocess; memory resets between shards. Default `1`. |
| `--continue-on-failure` | Don't stop the loop when a shard exits non-zero. Right default for visual-regression demos where assertion failures don't invalidate captures. |
| `--storybook-static <dir>` | Path to built Storybook (default `./storybook-static`). |
| `--url <url>` | Skip the static server, run against an existing URL. |
| `-- <args>` | Pass-through to test-storybook (e.g. `-- --maxWorkers 2`). |

**Strengths.**
- Each shard is its own Node process — module cache resets between shards.
- Test-runner navigates `iframe.html?id=<story>` per story, closes the page, moves on — no per-file BrowserContext accumulation.
- Jest's `workerIdleMemoryLimit` (via `-- --workerIdleMemoryLimit=1500MB`) recycles workers above a threshold.
- Decoupled from the consumer's Vitest version. Works on Vitest 1, 2, 3, 4, or no Vitest at all.
- Verified on qorus-ide (1,279 stories, 8 shards): peak RSS ~2.2 GB, ~12 min wall time.

**Limits.**
- One extra peer dependency (`@storybook/test-runner`).
- Custom Vitest tests layered on stories (`it()`/`test()` blocks, vitest snapshot matchers) **don't run** through the runner — Jest doesn't know about Vitest's API. If you rely on those, stay on Path A or run both.
- Capture lifecycle is `postVisit` only — there's no equivalent of Vitest's afterEach for the test file as a whole. The qlip `screenshot()` call inside a play function still works (it's called during play, not after).

See `RUNNER.md` for architecture, code reuse, and "how to extend."

---

## What's identical between the two

| Concern | Both paths |
|---|---|
| Manifest schema | Same `QlipManifest` JSON shape (`src/types.ts`, `MANIFEST.md`). |
| Wire format | Same multipart `POST /api/builds/upload`. Same field-name-encoding for screenshot paths. |
| Auto/manual/error screenshot kinds | Same `QlipEntryKind` union, same filesystem layout (`auto/`, `manual/`, `error/`). |
| Story parameter resolution | Same three-tier precedence (explicit options → story parameters → plugin defaults). |
| Branch + commit auto-detection | Same `autodetectBranch` / `autodetectCommit` helpers (GitHub Actions env first, then `git rev-parse`). |
| qlip-server behaviour | Server has no idea which path produced the upload. Dashboard, diffing, baselines, retention, all behave identically. |

This is the architectural point: the **capture path is hot-swappable**.
Switch by changing the invocation; nothing downstream cares.

---

## Migration between the two

**Vitest plugin → runner** (sized up past the plugin's envelope):

1. `yarn add -D @storybook/test-runner`
2. Create `.storybook/test-runner.ts` with the `postVisit` hook above.
3. (Optional) Remove `qlipVitestPlugin()` from `vitest.config.ts` — keeping it doesn't break the runner, it just means screenshots get captured by whichever path runs.
4. Add `yarn build-storybook && yarn qlip-serve-and-test --shards N` to CI in place of `yarn test:stories`.

**Runner → Vitest plugin** (project shrank enough to fit, or you want vitest-style assertions on stories):

1. Add `qlipVitestPlugin()` to `vitest.config.ts` per README.
2. Run `yarn test:stories` as your capture path.
3. (Optional) Remove the `qlipCapture` import from `.storybook/test-runner.ts` — though it doesn't hurt to leave both wired and let CI pick.

There's no data migration: the dashboard build history is the same regardless of which path produced earlier builds.

---

## Open questions / future work

- **Will addon-vitest scale at qorus-ide-class workloads in 2026?**
  We tested with Vitest 2.1 + Storybook 8.5. Vitest 4.1 + Storybook 9
  ship `detectAsyncLeaks` and stable Browser Mode, but the underlying
  module-cache accumulation issues we hit on 2.1 are not specifically
  called out as fixed in the 4.0/4.1 release notes. Worth a re-test;
  see PROGRESS.md "Next action" if/when scheduled.

- **Per-story page lifecycle in test-runner.** test-runner navigates
  per story but the **page** is reused (Storybook's iframe runtime
  re-mounts on navigation). Real per-page teardown isn't free — it's
  Storybook-side behaviour we don't control. So far we haven't hit a
  ceiling, but it's worth knowing the constraint.

- **Sharding policy for very small consumers.** `--shards 8` on a
  14-story playground is wasteful (~3s of orchestration overhead per
  shard). `--shards 1` is the right default; advise consumers to set
  it higher only when peak RAM is a concern.

---

## How to extend

### Adding a new capture-time option (e.g. `delayBeforeScreenshotMs`)

Both paths share the same option resolver in
`src/config/parameters.ts`. Steps:

1. Add the field to `QlipCaptureOptions` in `src/types.ts`.
2. Add a default to `QlipResolvedDefaults` and the plugin's default
   merger.
3. Resolve precedence in `resolveQlipOptions()` (`src/config/parameters.ts`).
4. Use the resolved value in `src/runtime/screenshot.ts` (Vitest path)
   AND `src/test-runner/index.ts:qlipCapture` (runner path). Symmetry
   is the point — every option must work in both.
5. Document in this file's "What's identical between the two" table if
   the option is path-agnostic.

### Adding a new orchestrator flag to qlip-serve-and-test

Only affects the runner path. Steps in `qlip/src/test-runner/cli/serve-and-test.ts`:

1. Add the field to `IParsedArgs`.
2. Parse in `parseArgs`.
3. Use it in `runServeAndTest`.
4. Document in the USAGE text and in the "Useful flags" table above.
5. Add a unit test in `tests/test-runner/serve-and-test.test.ts`.

### Splitting capture paths if they ever diverge meaningfully

Today both paths share ~80% of the code (everything under
`src/runtime/`, `src/fs/`, `src/upload/`, `src/config/`). If we ever
need genuinely different capture behaviour per path (e.g. the runner
gets full-page screenshots that the Vitest path can't do), the natural
split point is:

- `src/runtime/screenshot.ts` — Vitest-path captures
- `src/test-runner/index.ts` — runner-path captures (calls into
  `src/runtime/` for shared logic)

Don't split the manifest writer, the upload code, or the option
resolver — those should stay shared so the wire contract can't drift.

# Choosing your integration: Vitest plugin vs. standalone runner

> Status: living guide. Revised 2026-05-25 after the Vitest plugin path
> was shown viable for qorus-ide-class workloads with the right pool
> config (PROGRESS.md decision log entry of the same date). Companion
> to `RUNNER.md` (architecture of the runner) and `UPLOAD.md` (the wire
> contract both paths share).
>
> Previous version of this doc framed the Vitest plugin as suitable only
> for ≤150 stories. That cap was a consequence of the **default** pool
> config (threads + unbounded fileParallelism), not of the plugin
> itself. See "Memory-safe config for large Storybooks" below.

`@qoretechnologies/qlip` ships **two integration paths**. Both produce
identical manifest + screenshot bundles and POST to the same
`/api/builds/upload` endpoint on qlip-server — the server can't tell
them apart. Pick the path that fits your project's tooling, not its size.

<!-- Decision: see PROGRESS.md 2026-05-25 — Vitest plugin path saved on qorus-ide via pool: 'forks' + maxForks: 3 -->

---

## TL;DR — decision table

| Your situation | Recommended path | Why |
|---|---|---|
| Greenfield, ≤150 stories | **Vitest plugin** (default config) | Zero extra dependencies; runs as a side effect of `yarn test:stories`. |
| 150+ stories / heavy components / full-app-shell stories | **Vitest plugin (memory-safe config)** | Add `pool: 'forks' + maxForks: N` (see recipe below). Verified on qorus-ide (90 files, 643 tests, 7 min, 7.9 GB peak). |
| Cannot upgrade Vitest (pinned to 1.x / 2.x for other reasons) and want zero-Vitest capture | **Runner** | Decoupled from consumer's Vitest version. Test-runner ships its own Jest internally. |
| Already use `@storybook/test-runner` for other reasons (a11y, etc.) | **Runner** | Drop one more `postVisit` hook in; reuse the test-runner you already run. |
| You're not sure | Start with Vitest plugin (default). Move to memory-safe config if you OOM, runner if you can't be on Vitest 4. | |

The two paths target different *tooling preferences*, not different
size envelopes. Keep both available; consumers pick at integration time.

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

**Limits — and the config that lifts them.**

The historical concern was that vitest browser-mode accumulates per-file
BrowserContexts and module cache, and at default settings spawns one
worker per CPU core. On a 12-core M4 Pro that's 12 concurrent
BrowserContexts × ~2 GB each = 24 GB peak, which OOMs even before
captures are involved. We measured this on qorus-ide (May 23, 2026):
40 GB peak RSS, OOM at file ~55, captures on **or** off — the OOM was
in vitest, not qlip.

**The cap is removed by switching `pool: 'threads'` (default) →
`pool: 'forks'` and capping concurrent forks via `maxForks`.** See
"Memory-safe config for large Storybooks" below. Verified on qorus-ide
(90 files / 643 tests / 7 min / 7.9 GB peak — well within budget on a
24 GB Mac).

Two genuine remaining limits, neither of which the runner avoids:
- **vite dep-optimization re-runs.** On Storybook + Vitest 2/3, vite
  may re-optimize deps mid-run and cause a handful of test files to
  execute twice. Adds wall time, doesn't affect correctness.
  Tracked upstream (Storybook #33067).
- **No upstream API to clear Node's module cache.** Per-fork
  accumulation within a single fork still grows linearly with files;
  `isolate: true` (default) ensures fork *processes* die between files,
  which is what bounds memory. Without per-fork process recycling, a
  long-running single-fork run can still climb (we saw this with
  `singleFork: true` — bounded but slow, and a separate liveness issue
  hit on play-function failures).

---

## Memory-safe config for large Storybooks

Drop the following into your `vitest.workspace.ts` / `vitest.config.ts`
storybook project:

```ts
{
  test: {
    name: 'storybook',
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({}),
      instances: [{ browser: 'chromium' }],
    },
    // ↓ THE memory-safe knobs ↓
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 3,       // tune to your cores + RAM
        minForks: 1,
        isolate: true,     // default — pinned for clarity
      },
    },
    fileParallelism: true, // default — forks distribute files across themselves
    setupFiles: ['.storybook/vitest.setup.ts'],
  },
  plugins: [
    react(),
    storybookTest({ configDir: '.storybook' }),
    qlipVitestPlugin({ /* your options */ }),
  ],
}
```

### Tuning `maxForks`

Each fork peaks at ~3 GB RSS during a heavy file's chromium render. So
the rule of thumb is:

```
maxForks ≤ (free_RAM_GB - 4) / 3
```

| Hardware | Suggested maxForks | Expected peak |
|---|---|---|
| 8 GB MacBook (CI runner, GitHub Actions Linux) | 1 | ~3 GB |
| 16 GB Mac (M1/M2 base) | 2 | ~6 GB |
| 24 GB Mac (M4 Pro / M3 Pro 18-24 GB) | 3 | ~9 GB |
| 32 GB workstation | 4–6 | ~12-18 GB |

If you don't know, start with `maxForks: 2` and bump up if your run is
slow but RAM is comfortable. Don't blindly set to CPU count — that's
exactly what the default was doing and it doesn't work.

### A safety net while testing

A scratch run that goes wrong on a 90-file Storybook can lock a
laptop into swap for a long time. The repo ships
`scripts/watchdog-rss.sh` for exactly this — it wraps any command,
walks the process tree's RSS every N seconds, and SIGTERMs the whole
group when it crosses a threshold. Example:

```bash
# 18 GB ceiling, 2-second polling, abortable via `touch /tmp/abort`
./scripts/watchdog-rss.sh 18000 \
  --interval=2 \
  --log=/tmp/wd.log \
  --abort-file=/tmp/abort \
  -- yarn vitest run --project storybook
```

This is a generic safety harness for any expensive test command, not a
qlip-specific feature. Use it the first time you flip `auto: true` on
a large Storybook, then drop it once you know the run fits.

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

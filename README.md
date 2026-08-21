# Qlip

Qlip is a Storybook screenshot capture tool. Add it to your project and every story automatically gets a screenshot after its test finishes. Use `screenshot()` inside a play function to capture intermediate states.

## Choosing your integration

Qlip ships **two integration paths**. They produce identical screenshot bundles and upload to the same server — pick by tooling preference, not project size.

| Your situation | Path | Why |
|---|---|---|
| Greenfield, ≤150 stories | **Vitest plugin** (default config) | One extra dep. Screenshots happen as a side effect of `yarn test:stories`. |
| 150+ stories / heavy components | **Vitest plugin (memory-safe config)** | Add `pool: 'forks' + maxForks: N` — see [Memory-safe config](#memory-safe-config-for-large-storybooks). |
| Can't be on Vitest 4 / want zero-Vitest capture | **Runner** (`qlip-serve-and-test`) | Decoupled from consumer's Vitest version. |
| Already running `@storybook/test-runner` | **Runner** | Add one `postVisit` hook to the test-runner you already have. |

The full comparison + when-to-switch guide is in [`design/INTEGRATION_PATHS.md`](./design/INTEGRATION_PATHS.md). The runner architecture is in [`design/RUNNER.md`](./design/RUNNER.md).

## Install

```bash
npm install --save-dev @qoretechnologies/qlip
# Plus, only for the runner path:
npm install --save-dev @storybook/test-runner
```

## Vitest setup

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { qlipVitestPlugin } from '@qoretechnologies/qlip';

const dirname =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: path.join(dirname, '.storybook'),
          }),
          qlipVitestPlugin(),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
          setupFiles: ['.storybook/vitest.setup.ts'],
        },
      },
    ],
  },
});
```

## Runner setup (for large Storybooks)

Use this **instead of** the Vitest plugin if your suite is past the
Vitest-browser-mode memory envelope (see [Choosing your integration](#choosing-your-integration)
above).

1. Add `.storybook/test-runner.ts`:

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

2. Run it:

```bash
# Build storybook, serve it on a free port, capture every story
# through @storybook/test-runner, upload as one build:
yarn build-storybook
QLIP_UPLOAD_URL=https://qlip.example.com \
QLIP_PROJECT=my-app \
yarn qlip-serve-and-test --shards 8 --continue-on-failure
```

Flags worth knowing:

- `--shards <n>` — run N test-storybook invocations sequentially with `--shard k/N`. Each shard is a fresh subprocess; memory resets between shards. Default `1`.
- `--continue-on-failure` — don't stop the loop on a non-zero shard exit. Right default for visual-regression demos where a failed play function doesn't invalidate the captured screenshot.
- `--storybook-static <dir>` — point at an existing static Storybook dir (default `./storybook-static`).
- `--url <url>` — skip the static server, capture against an already-running Storybook.
- Anything after `--` is forwarded to `test-storybook` (e.g. `-- --maxWorkers 2`).

`qlip-serve-and-test --help` for the full list.

## Authenticating uploads

When the qlip-server is started with `UPLOAD_TOKEN` set, every
upload must carry `Authorization: Bearer <token>`. Both integration
paths read this token from the **`QLIP_UPLOAD_TOKEN`** env var (the
Vitest plugin via `vitest.config.ts`, the runner CLIs via the same
env or an explicit `--token` flag). Against a localhost dev server
with `UPLOAD_TOKEN` unset, leave it blank — uploads are accepted
without a header.

There are **two kinds of token** you can put in `QLIP_UPLOAD_TOKEN`,
and qlip treats them identically — it just forwards the string as a
bearer. The difference is server-side scope:

| Token | Looks like | Scope | When to use |
|-------|-----------|-------|-------------|
| **Per-project** (recommended) | `qlt_…` (44 chars) | Exactly one project; uploads to any other project 403 | CI pipelines. Mint one per project from the dashboard's **Project settings → API tokens**; revoke it without disrupting other projects. |
| **Super-admin** (`UPLOAD_TOKEN`) | whatever you set the env to | Every project, all scopes | Bootstrapping, or a single shared CI that uploads to many projects. The legacy/escape-hatch token; keep it secret. |

Precedence is simple because qlip only sends one token: whatever
value is in `QLIP_UPLOAD_TOKEN` (or `--token`) is the one used. Pick
the **narrowest token that works** — a per-project `qlt_…` token for
a single-project CI, the super-admin token only when one uploader
genuinely spans projects. A per-project token must match the
`QLIP_PROJECT` you're uploading to, or the server returns `403`.

```bash
# CI uploading to one project — scoped per-project token:
QLIP_UPLOAD_URL=https://qlip.example.com \
QLIP_PROJECT=my-app \
QLIP_UPLOAD_TOKEN=qlt_xxxxxxxx… \
yarn test
```

See `qlip-server`'s `design/API.md §0` (auth model) and `§18`
(token CRUD) for the server side, and `design/UPLOAD.md` here for
the upload protocol.

### CI checkout: use `fetch-depth: 0` for accurate baselines

qlip auto-detects the commit ancestry (via `git rev-list`) and, on PR
builds, the base branch (via `$GITHUB_BASE_REF`) and sends them with
every upload. The server walks the ancestry to find the nearest prior
build to diff against. A **shallow** clone — `actions/checkout`'s
default — only fetches the tip commit, so that walk has nothing to
follow and the server falls back to the project's default branch,
producing noisier diffs. Fetch full history:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

qlip prints a one-time warning when it detects a shallow clone. It
never fails the upload over this — accuracy degrades, the run still
succeeds.

## Manual screenshots inside play

Use the existing **"Logged In"** story as a real-world example:

```ts
import { screenshot } from '@qoretechnologies/qlip';

export const LoggedIn = {
  play: async (ctx) => {
    // interactions and assertions...
    await screenshot(ctx, 'after-login');
  },
};
```

Take as many as you like per story — each name is its own snapshot on the server. Give them distinct names: two captures of one story sharing a name (including `auto`, which the automatic capture uses) resolve to one snapshot, and the run warns which image it had to drop.

**Known limitation:** qlip-server keys *baselines* by story, kind and viewport, without the screenshot name. A story's auto capture and its manual captures are therefore independent, but **two manual captures of one story at one viewport share a baseline** — accepting one sets the baseline for the other, which then shows a meaningless diff. The run warns when a build contains such captures. Fixing it needs a server-side change; until then, give such captures distinct viewports if you need independent baselines.

## Parameters

Configure screenshots per story via `parameters.qlip`:

```ts
export const LoggedIn = {
  parameters: {
    qlip: {
      skip: false,
      viewport: { width: 1280, height: 720 },
      disableAnimations: true,
      pauseAnimationsAtEnd: false,
      captureOnError: false,
      waitForIdleMs: 300,
      maxWaitForIdleMs: 2000,
      ignoreElements: ['.toast', '[data-qlip-ignore]'],
    },
  },
};
```

Options precedence:

1. Explicit options passed to `screenshot()`
2. `parameters.qlip`
3. Plugin defaults

## Plugin options

```ts
qlipVitestPlugin({
  outputDir: './qlip/screenshots',
  viewport: { width: 1280, height: 720 },
  disableAnimations: false,
  pauseAnimationsAtEnd: false,
  captureOnError: false,
  waitForIdleMs: 300,
  maxWaitForIdleMs: 2000,
  ignoreElements: [],
  diagnostics: false,
});
```

`waitForIdleMs` waits for DOM mutations to settle before taking a screenshot. This is especially useful for animation libraries like `react-spring` that update inline styles via `requestAnimationFrame`, which bypasses CSS-based animation disabling. Increase it if you still catch mid-transition frames, or lower it for faster runs when your UI is static. `maxWaitForIdleMs` caps the wait so stories with continuously changing UI still complete.

`ignoreElements` lets you provide CSS selectors to mask before capture. Qlip draws solid overlays on matching elements so layout stays intact while visual diffs ignore those regions.

qlip also reports what it *failed* to capture: the run warns when Storybook stories executed without producing a capture, naming them and the files they came from. It is advisory — a story that sets `parameters.qlip.auto = false` shows up there too.

`diagnostics` (or `QLIP_DEBUG=1`) logs one line per capture — story, kind, path, and which browser context wrote it. Turn it on when a CI build captured fewer stories than it ran; the always-written `capture-report.json` covers the same ground after the fact.

## Memory-safe config for large Storybooks

If your Storybook has more than ~150 stories, or any stories that mount a heavy app shell (dashboards, multi-pane editors, etc.), the **default Vitest browser-mode** can OOM — it spawns one worker per CPU core, each with its own BrowserContext, and on a 12-core machine that's easily 20+ GB peak RAM.

The fix is **two extra lines** in your storybook project's test config — switch the pool to forks and cap concurrency:

```ts
test: {
  name: 'storybook',
  browser: { enabled: true, headless: true, provider: playwright({}), instances: [{ browser: 'chromium' }] },
  // ↓ The memory-safe knobs ↓
  pool: 'forks',
  poolOptions: {
    forks: { maxForks: 3, minForks: 1, isolate: true },
  },
  setupFiles: ['.storybook/vitest.setup.ts'],
}
```

Each fork peaks at ~3 GB RSS during a heavy story's chromium render, so the rule of thumb is `maxForks ≤ (free_RAM_GB - 4) / 3`:

| Environment | Suggested `maxForks` |
|---|---|
| GitHub Actions Linux runner (~7 GB) | 1 |
| 16 GB Mac (M1/M2 base) | 2 |
| 24 GB Mac (M4 Pro / M3 Pro) | 3 |
| 32 GB+ workstation | 4–6 |

Verified on a real consumer (qorus-ide, 90 story files / 643 tests, Vitest 2.1.9, Storybook 8.5): **7 min wall time, 7.9 GB peak RSS, full suite completed with no OOM**. Full background in [`design/INTEGRATION_PATHS.md`](./design/INTEGRATION_PATHS.md#memory-safe-config-for-large-storybooks).

## Output layout

```
./qlip/screenshots/
  <buildId>/
    stories/
      auto/<storyTitle>--<storyName>.png
      manual/<storyTitle>--<storyName>--<screenshotName>.png
      error/<storyTitle>--<storyName>--qlip-auto-error-capture.png
    manifest-fragments/<contextId>-<seq>.json
    manifest.json
    capture-report.json
```

- `buildId` defaults to `YYYYMMDD-HHmmss`
- `parameters.qlip.skip === true` disables all captures for that story
- `manifest-fragments/` holds one append-only record per capture; they
  merge into `manifest.json` at end-of-run. Safe to delete after a
  build uploads — see [`design/MANIFEST_FRAGMENTS.md`](./design/MANIFEST_FRAGMENTS.md)
- `capture-report.json` is the run's audit: captures per context and
  per story file, plus any screenshot on disk that no manifest entry
  references

## Sharded CI runs

Several `vitest run` invocations (or `test-storybook` shards) can capture into one build: pin `buildId` — e.g. `buildId: process.env.GITHUB_RUN_ID` — so every shard writes into the same `<outputDir>/<buildId>/`, then upload once at the end with `npx qlip-upload --build-dir ./qlip/screenshots/$GITHUB_RUN_ID`. Fragment names carry a per-process id, so shards cannot overwrite each other's captures.

`isolate: false` is supported. Several story files then share one browser context and capture concurrently; fragments are append-only precisely so that is safe.

Add `--fail-on-partial-build` to `qlip-upload` (or `upload.failOnPartialBuild` on the plugin) to turn "screenshots on disk that never reached the manifest" from a warning into a red build.

## Manifest

Each run writes `manifest.json` inside the build folder with tool metadata, defaults, stats, and per-screenshot entries (auto + manual).

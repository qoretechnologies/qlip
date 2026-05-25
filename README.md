# Qlip

Qlip is a Storybook screenshot capture tool. Add it to your project and every story automatically gets a screenshot after its test finishes. Use `screenshot()` inside a play function to capture intermediate states.

## Choosing your integration

Qlip ships **two integration paths**. They produce identical screenshot bundles and upload to the same server — pick by project size.

| Your Storybook | Path | Why |
|---|---|---|
| < 150 stories, no full-app-shell components | **Vitest plugin** (below) | One extra dep. Screenshots happen as a side effect of `yarn test:stories`. |
| 150+ stories, or any full-app/dashboard-class story files | **Runner** (`qlip-serve-and-test`) | Vitest browser-mode accumulates per-file module cache; large suites hit OOM. The runner shards into independent processes. |
| You're not sure | Start with the Vitest plugin. Switch to runner if you OOM — switching is one new command, nothing else changes. | |

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
});
```

`waitForIdleMs` waits for DOM mutations to settle before taking a screenshot. This is especially useful for animation libraries like `react-spring` that update inline styles via `requestAnimationFrame`, which bypasses CSS-based animation disabling. Increase it if you still catch mid-transition frames, or lower it for faster runs when your UI is static. `maxWaitForIdleMs` caps the wait so stories with continuously changing UI still complete.

`ignoreElements` lets you provide CSS selectors to mask before capture. Qlip draws solid overlays on matching elements so layout stays intact while visual diffs ignore those regions.

## Output layout

```
./qlip/screenshots/
  <buildId>/
    stories/
      auto/<storyTitle>--<storyName>.png
      manual/<storyTitle>--<storyName>--<screenshotName>.png
      error/<storyTitle>--<storyName>--qlip-auto-error-capture.png
    manifest.json
```

- `buildId` defaults to `YYYYMMDD-HHmmss`
- `parameters.qlip.skip === true` disables all captures for that story

## Manifest

Each run writes `manifest.json` inside the build folder with tool metadata, defaults, stats, and per-screenshot entries (auto + manual).

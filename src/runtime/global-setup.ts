/**
 * Vitest globalSetup file — exports `teardown()` which finalizes
 * the qlip build after the test run completes.
 *
 * ## Why we need this (2026-05-23)
 *
 * Vitest's reporter lifecycle (`onTestRunEnd` on V3+, `onFinished`
 * on V2) only fires on reporters in the **root** `vitest.config`'s
 * reporters array. In **workspace mode** (`defineWorkspace(...)`),
 * when a project inside the workspace pushes a reporter into its
 * own `test.reporters`, that reporter is scoped to the project's
 * own iteration and **does not receive the end-of-run lifecycle**
 * — verified in Vitest 2.1's `cli-api.js` line 10494, where
 * `this.reporters = await createReporters(resolved.reporters, ...)`
 * reads from the resolved *root* config, not from project-local
 * configs.
 *
 * Vitest 4 sidesteps the problem with the `configureVitest` plugin
 * hook (added in V3.1.0-beta.2), which gives plugins direct write
 * access to `vitest.config.reporters` — the root array. We use
 * that on V4. But on V2, `configureVitest` doesn't exist and our
 * project-local reporter push is lifecycle-dead.
 *
 * `globalSetup`, however, fires reliably on every Vitest version,
 * including V2 workspace mode: each project's globalSetup runs
 * setup before its tests start and teardown after they finish. So
 * we plumb the finalize pipeline through a globalSetup teardown,
 * giving us a Node-side lifecycle hook that V2 honours.
 *
 * The reporter path stays as-is for V4 — both call into
 * `finalizeBuild()`, which is process-globally idempotent via a
 * symbol-keyed `globalThis` flag, so even if both fire only one
 * actually runs.
 *
 * ## Config flow
 *
 * The plugin's Node-side `config` hook (which runs in the same
 * Node process as globalSetup) stashes the resolved runtime config
 * + upload options on `globalThis.__QLIP_FINALIZE_CONFIG__`. This
 * file reads them at teardown time. No file I/O for the config —
 * we're in the same process, sharing globals is fine.
 */

import type { QlipRuntimeConfig, QlipUploadOptions } from '../types.js';
import { finalizeBuild } from '../upload/finalize.js';

export const QLIP_FINALIZE_CONFIG_KEY = Symbol.for(
  '@qoretechnologies/qlip/__finalize_config__',
);

export interface IQlipFinalizeConfig {
  runtime: QlipRuntimeConfig;
  upload?: QlipUploadOptions;
}

interface FinalizeConfigHolder {
  [QLIP_FINALIZE_CONFIG_KEY]?: IQlipFinalizeConfig;
}

export const stashFinalizeConfig = (config: IQlipFinalizeConfig): void => {
  const holder = globalThis as FinalizeConfigHolder;
  holder[QLIP_FINALIZE_CONFIG_KEY] = config;
};

export const readFinalizeConfig = (): IQlipFinalizeConfig | undefined => {
  const holder = globalThis as FinalizeConfigHolder;
  return holder[QLIP_FINALIZE_CONFIG_KEY];
};

/**
 * Vitest globalSetup contract: a default-exported async function
 * that optionally returns a teardown function, OR named `setup` /
 * `teardown` exports. We use the named-export form for clarity.
 *
 * `setup` is a no-op — all the work happens at teardown.
 */
export const setup = async (): Promise<void> => {
  /* no-op; finalize happens in teardown */
};

/**
 * `teardown` fires once after all tests in the hosting project
 * complete. Reads the stashed config, delegates to `finalizeBuild`.
 */
export const teardown = async (): Promise<void> => {
  const config = readFinalizeConfig();
  if (!config) {
    // Plugin didn't stash anything — possible if the user wired
    // globalSetup manually without the plugin, or if a workspace
    // re-resolution clobbered globals. Silent no-op rather than
    // crash; the lack of an uploaded build is already the signal.
    return;
  }
  await finalizeBuild({
    runtime: config.runtime,
    ...(config.upload !== undefined ? { upload: config.upload } : {}),
  });
};

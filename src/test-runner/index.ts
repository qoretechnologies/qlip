/**
 * `@qoretechnologies/qlip/test-runner` — the library entry point for
 * the Storybook test-runner integration.
 *
 * Designed to be wired into the consumer's `.storybook/test-runner.ts`:
 *
 * ```ts
 * import type { TestRunnerConfig } from '@storybook/test-runner';
 * import { qlipCapture } from '@qoretechnologies/qlip/test-runner';
 *
 * const config: TestRunnerConfig = {
 *   async postVisit(page, context) {
 *     await qlipCapture(page, context);
 *   },
 * };
 *
 * export default config;
 * ```
 *
 * Runtime behaviour mirrors qlip's Vitest plugin path
 * (`src/runtime/screenshot.ts`):
 *
 *   1. Read story-level `parameters.qlip` via test-runner's
 *      `getStoryContext()` helper
 *   2. Resolve options via the shared
 *      `resolveQlipOptions({ defaults, story })` from
 *      `src/config/parameters.ts`
 *   3. Skip path → record skipped entry, return
 *   4. Apply browser-side prep (animation control, DOM idle wait,
 *      ignore masks) via `page.evaluate()`
 *   5. Set viewport per-story
 *   6. `page.screenshot()` writes the PNG to
 *      `<buildDir>/stories/auto/<title>--<name>.png`
 *   7. Append entry to the in-process manifest store
 *
 * **Phase R-1 scope:** capture only. Manifest merge + upload are
 * triggered by the globalSetup teardown (Phase R-2) — not in this
 * commit yet. After R-1, screenshots land on disk and the store
 * accumulates entries; nothing is shipped to qlip-server.
 *
 * See `qlip-project/docs/RUNNER_IMPLEMENTATION_PLAN.md` for the
 * five-phase rollout.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveQlipOptions } from '../config/parameters.js';
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_VIEWPORT,
  MANIFEST_FRAGMENT_DIR,
  TOOL_NAME,
  buildAutoScreenshotPath,
  generateBuildId,
} from '../fs/output.js';
import type {
  QlipCaptureOptions,
  QlipEntryKind,
  QlipEntryStatus,
  QlipManifestEntry,
  QlipParameters,
  QlipResolvedDefaults,
  QlipViewport,
} from '../types.js';
import {
  writeEntryFragment,
  getOrInitStore,
  nextStepName,
  peekStore,
  pushEntry,
  type IQlipTestRunnerStore,
} from './manifest-store.js';
import {
  applyAnimationControlInPage,
  applyIgnoreMasksInPage,
  removeIgnoreMasksInPage,
  waitForDomIdleInPage,
} from './prep-scripts.js';
import { QLIP_TOOL_VERSION } from './version.js';

/**
 * Minimal shape of Playwright's `Page` we use. We don't import the
 * playwright type because we don't want a peer dependency on
 * playwright itself — `@storybook/test-runner` brings its own
 * Playwright and we just consume the `Page` it hands us in
 * `postVisit`. Duck-typing keeps the integration loose.
 */
export interface IPlaywrightPageLike {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  evaluate<T, R>(fn: (arg: T) => R | Promise<R>, arg: T): Promise<R>;
  screenshot(opts: {
    path?: string;
    fullPage?: boolean;
    omitBackground?: boolean;
    type?: 'png' | 'jpeg';
  }): Promise<Buffer>;
}

/**
 * Minimal shape of `@storybook/test-runner`'s TestContext (the
 * second argument of `postVisit`). Only `id`, `title`, `name` are
 * documented as guaranteed; `parameters` is fetched via
 * `getStoryContext()` (passed in via `options.getStoryContext` so
 * we can keep this module test-runner-version-agnostic).
 */
export interface IQlipTestContext {
  id: string;
  title?: string;
  name?: string;
}

/**
 * Test-runner-specific options accepted by `qlipCapture`. Most
 * fields default to env vars or qlip's standard defaults so the
 * consumer's `postVisit` body stays a single line in the common
 * case.
 */
export interface IQlipCaptureOptions {
  /**
   * Output root for screenshots + manifest fragments. Same default
   * as the Vitest plugin path. Override via the `outputDir` option
   * here, or via the `QLIP_OUTPUT_DIR` env var.
   */
  outputDir?: string;
  /**
   * Build identifier. Default: a fresh timestamp at process start
   * (one buildId per run, since the store is process-global).
   * Override via `buildId` option or `QLIP_BUILD_ID` env var. CI
   * setups doing sharding should set `QLIP_BUILD_ID` to a shared
   * value (e.g. the git SHA) so every shard uploads to the same
   * logical build.
   */
  buildId?: string;
  /**
   * Default capture options applied to every story. Story-level
   * `parameters.qlip` always wins per-story.
   */
  defaults?: Partial<QlipCaptureOptions> & { captureOnError?: boolean };
  /**
   * Inject test-runner's `getStoryContext` to fetch story
   * parameters. Passed in (not imported) so this module doesn't
   * peer-depend on `@storybook/test-runner`. The consumer wires
   * this in their `.storybook/test-runner.ts`:
   *
   * ```ts
   * import { getStoryContext } from '@storybook/test-runner';
   * await qlipCapture(page, context, { getStoryContext });
   * ```
   *
   * When omitted, qlip uses the story's `id`/`title`/`name` from
   * the `context` arg and skips parameter-based per-story config —
   * useful as a fallback.
   */
  getStoryContext?: (
    page: IPlaywrightPageLike,
    context: IQlipTestContext,
  ) => Promise<{ parameters?: { qlip?: QlipParameters } }>;
}

/**
 * Build full `QlipResolvedDefaults` from a partial override. Same
 * defaults as the Vitest plugin (`src/plugin/vitestPlugin.ts`)
 * so a project switching from one path to the other gets identical
 * behaviour with no extra config.
 */
const buildResolvedDefaults = (
  override: IQlipCaptureOptions['defaults'],
): QlipResolvedDefaults => {
  const fallbackViewport: QlipViewport =
    override?.viewport ?? DEFAULT_VIEWPORT;
  return {
    outputDir: DEFAULT_OUTPUT_DIR,
    viewport: fallbackViewport,
    skip: false,
    disableAnimations: override?.disableAnimations ?? false,
    pauseAnimationsAtEnd: override?.pauseAnimationsAtEnd ?? false,
    disableBackdropFilter: override?.disableBackdropFilter ?? true,
    captureOnError: override?.captureOnError ?? false,
    waitForIdleMs: override?.waitForIdleMs ?? 300,
    maxWaitForIdleMs: override?.maxWaitForIdleMs ?? 2000,
    ignoreElements: override?.ignoreElements ?? [],
    auto: override?.auto ?? true,
    manual: override?.manual ?? true,
    error: override?.error ?? true,
    captureConsole: override?.captureConsole ?? false,
    captureConsoleLevels: override?.captureConsoleLevels ?? ['error'],
    maxConsoleLogs: override?.maxConsoleLogs ?? 50,
    consoleLogExcludePatterns: override?.consoleLogExcludePatterns ?? [],
  };
};

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

const buildEntry = (params: {
  kind: QlipEntryKind;
  storyId: string;
  storyTitle: string | undefined;
  storyName: string | undefined;
  screenshotName: string;
  relativePath: string;
  viewport: QlipViewport;
  status: QlipEntryStatus;
  error: { message: string; stack?: string } | null;
  timingsMs: number;
}): QlipManifestEntry => ({
  kind: params.kind,
  storyId: params.storyId,
  storyTitle: params.storyTitle,
  storyName: params.storyName,
  screenshotName: params.screenshotName,
  path: params.relativePath,
  viewport: params.viewport,
  status: params.status,
  error: params.error,
  timings: { ms: params.timingsMs },
});

/**
 * Ensure every directory in the build tree exists. Idempotent;
 * called per-capture (cheap — mkdir with `recursive: true` no-ops
 * when dirs exist).
 */
const ensureBuildDirs = async (buildDir: string): Promise<void> => {
  await fs.mkdir(path.join(buildDir, 'stories', 'auto'), { recursive: true });
  await fs.mkdir(path.join(buildDir, MANIFEST_FRAGMENT_DIR), {
    recursive: true,
  });
};

/**
 * Resolve the store on first call, sharing it across every
 * subsequent `qlipCapture` invocation within the same Node
 * process.
 *
 * **Critical:** check for an existing store FIRST. Without this
 * fast-path, every capture in the same process would:
 *   1. Call `generateBuildId()` — which returns a NEW timestamp
 *      each time (only down to the second; calls in the next
 *      second yield a different ID)
 *   2. Compute a new `buildDir` from that fresh ID
 *   3. `ensureBuildDirs()` would create that NEW empty dir
 *   4. `getOrInitStore` would then return the EXISTING singleton
 *      from the first call, ignoring the new buildDir
 *
 * Net effect: one populated build dir + N empty stray dirs from
 * later calls. Fragments + screenshots all land in the FIRST
 * buildDir (per the singleton). Stray dirs are confusing waste.
 *
 * Fix: peek the store first; if it exists, skip the buildId /
 * buildDir / ensureBuildDirs work entirely.
 */
const resolveStore = async (
  options: IQlipCaptureOptions,
): Promise<IQlipTestRunnerStore> => {
  const existing = peekStore();
  if (existing) return existing;

  const outputDir = normalizePath(
    path.resolve(
      options.outputDir ??
        process.env['QLIP_OUTPUT_DIR'] ??
        DEFAULT_OUTPUT_DIR,
    ),
  );
  const buildId =
    options.buildId ?? process.env['QLIP_BUILD_ID'] ?? generateBuildId();
  const buildDir = normalizePath(path.join(outputDir, buildId));
  const defaults = buildResolvedDefaults(options.defaults);

  await ensureBuildDirs(buildDir);

  // Tool version is a hardcoded build-time constant — see
  // `./version.ts` for why we don't read package.json at runtime.
  return getOrInitStore({
    buildId,
    outputDir,
    buildDir,
    defaults,
    toolVersion: QLIP_TOOL_VERSION,
  });
};

/**
 * Capture a screenshot of the current story.
 *
 * Returns the manifest entry that was appended, primarily so
 * tests can assert on it. Production callers can ignore the
 * return value.
 *
 * Errors (capture exceptions, mask application failures) are
 * caught + recorded as failed entries — they do NOT throw, so
 * a single bad story doesn't fail the rest of the test-runner
 * run. Tests-runner's own assertions still surface to the user
 * normally.
 */
export const qlipCapture = async (
  page: IPlaywrightPageLike,
  context: IQlipTestContext,
  options: IQlipCaptureOptions = {},
): Promise<QlipManifestEntry | null> => {
  try {
    return await qlipCaptureInner(page, context, options);
  } catch (err) {
    // Test-runner's postVisit can silently absorb errors thrown from
    // hooks; surface them on stderr so a misconfigured qlip setup is
    // visible rather than producing an empty build dir + confused
    // user. Returning null mirrors the "nothing happened" semantics
    // — the test itself stays passing.
    // eslint-disable-next-line no-console
    console.error(
      `[qlip] qlipCapture failed for story "${context.id}": ${(err as Error).message}\n${(err as Error).stack ?? ''}`,
    );
    return null;
  }
};

const qlipCaptureInner = async (
  page: IPlaywrightPageLike,
  context: IQlipTestContext,
  options: IQlipCaptureOptions,
): Promise<QlipManifestEntry | null> => {
  const store = await resolveStore(options);
  const tool = { name: TOOL_NAME };
  void tool; // (reserved for v2 — per-entry tool metadata)

  // Pull story parameters via the consumer-provided getStoryContext.
  let storyParameters: QlipParameters | undefined;
  if (options.getStoryContext) {
    try {
      const storyCtx = await options.getStoryContext(page, context);
      storyParameters = storyCtx.parameters?.qlip;
    } catch {
      // getStoryContext can fail when the page navigated away
      // mid-call or when the story errored out. Fall back to
      // capturing with defaults — better a screenshot than nothing.
      storyParameters = undefined;
    }
  }

  const resolved = resolveQlipOptions({
    defaults: store.manifest.defaults,
    story: storyParameters,
  });

  const captureStart = Date.now();
  const storyTitle = context.title;
  const storyName = context.name;

  const pathInfo = buildAutoScreenshotPath({
    buildDir: store.buildDir,
    storyId: context.id,
    storyTitle,
    storyName,
  });

  // Skip path — record the entry but don't touch the page.
  if (resolved.skip) {
    const entry = buildEntry({
      kind: 'auto',
      storyId: context.id,
      storyTitle,
      storyName,
      screenshotName: 'auto',
      relativePath: pathInfo.relativePath,
      viewport: resolved.viewport,
      status: 'skipped',
      error: null,
      timingsMs: Date.now() - captureStart,
    });
    pushEntry(store, entry);
    await writeEntryFragment(store, entry);
    return entry;
  }

  let status: QlipEntryStatus = 'captured';
  let error: { message: string; stack?: string } | null = null;
  let maskIds: string[] = [];
  try {
    await page.setViewportSize({
      width: resolved.viewport.width,
      height: resolved.viewport.height,
    });
    await page.evaluate(applyAnimationControlInPage, {
      disableAnimations: resolved.disableAnimations,
      pauseAnimationsAtEnd: resolved.pauseAnimationsAtEnd,
    });
    await page.evaluate(waitForDomIdleInPage, {
      idleMs: resolved.waitForIdleMs,
      maxWaitMs: resolved.maxWaitForIdleMs,
    });
    if (resolved.ignoreElements.length > 0) {
      maskIds = await page.evaluate(applyIgnoreMasksInPage, {
        selectors: resolved.ignoreElements,
      });
    }
    await page.screenshot({ path: pathInfo.absolutePath, type: 'png' });
  } catch (err) {
    status = 'failed';
    const typed = err as Error;
    error = {
      message: typed.message ?? String(err),
      ...(typed.stack !== undefined ? { stack: typed.stack } : {}),
    };
  } finally {
    if (maskIds.length > 0) {
      try {
        await page.evaluate(removeIgnoreMasksInPage, { ids: maskIds });
      } catch {
        /* page may have navigated away; masks die with it */
      }
    }
  }

  const entry = buildEntry({
    kind: 'auto',
    storyId: context.id,
    storyTitle,
    storyName,
    screenshotName: 'auto',
    relativePath: pathInfo.relativePath,
    viewport: resolved.viewport,
    status,
    error,
    timingsMs: Date.now() - captureStart,
  });
  pushEntry(store, entry);
  // Persist after every capture so the separate qlip-upload process
  // sees the latest state even if the test run is interrupted.
  await writeEntryFragment(store, entry);
  return entry;
};

// Public type re-exports for consumer code.
export type { QlipManifestEntry, QlipParameters, QlipViewport } from '../types.js';
export { nextStepName }; // exposed for the manual-screenshot path (v1.5)

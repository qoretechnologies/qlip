import {
  QlipEntryKind,
  QlipEntryStatus,
  QlipScreenshotOptions,
  QlipStoryContext,
  QlipViewport,
} from '../types.js';
import { resolveQlipOptions } from '../config/parameters.js';
import {
  monotonicNow,
  realClearInterval,
  realSetInterval,
  realSetTimeout,
} from './clock.js';
import {
  AUTO_ERROR_SCREENSHOT_BASE,
  MANIFEST_FRAGMENT_DIR,
  buildAutoLogPath,
  buildAutoScreenshotPath,
  buildManualLogPath,
  buildManualScreenshotPath,
  joinPath,
  sanitizeSegment,
} from '../fs/output.js';
import {
  flushConsoleLogs,
  initRuntimeState,
  markStorybookWarning,
  nextStepName,
  pruneStaleErrorEntries,
  pushEntry,
  updateStats,
} from './context.js';
import type { TestContext } from 'vitest';
import type { QlipParameters, QlipManifestEntry } from '../types.js';

/**
 * Each browser context writes its in-memory manifest to a unique
 * fragment file under `<buildDir>/manifest-fragments/<fragmentId>.json`.
 * The Node-side `mergeManifestFragments` (in `src/upload/manifest.ts`)
 * consolidates all fragments into the final `manifest.json` once Vitest
 * signals end-of-run. Writing the full manifest each time is fine —
 * fragments are tiny JSON and there's only one writer per file.
 *
 * Background: vitest browser-mode runs each `*.stories.tsx` in its
 * own browser context with its own module graph and its own
 * QlipRuntimeState. If they all wrote to a shared `manifest.json` the
 * writes would clobber each other — last test file wins, earlier
 * files' entries get stranded on disk.
 */
type WriteFileCommand = (
  path: string,
  data: string,
  encoding: 'utf-8',
) => Promise<unknown>;

// `removeFile` was added to vitest-browser's built-in `BrowserCommands`
// (see `vitest/dist/browser.d.ts`). Older Vitest 2 releases don't ship
// it; the retry-mask fix silently no-ops when the command is missing.
type RemoveFileCommand = (path: string) => Promise<unknown>;

const writeManifestFragment = async (
  commands: { writeFile: WriteFileCommand },
  buildDir: string,
  fragmentId: string,
  manifest: unknown,
): Promise<void> => {
  await commands.writeFile(
    joinPath(buildDir, MANIFEST_FRAGMENT_DIR, `${fragmentId}.json`),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
};

/**
 * Best-effort file deletion for retry-mask pruning. Silent no-op when
 * the underlying command is missing (older Vitest) or the file is
 * already gone (another cleanup path beat us to it). We deliberately
 * swallow errors — pruning is a UI-fidelity improvement, not a
 * correctness gate; a leftover orphan PNG on disk is harmless because
 * nothing in the manifest references it after the entry is pruned.
 */
const bestEffortRemoveFile = async (
  commands: { removeFile?: RemoveFileCommand },
  absolutePath: string,
): Promise<void> => {
  if (typeof commands.removeFile !== 'function') return;
  try {
    await commands.removeFile(absolutePath);
  } catch {
    // Swallow — see JSDoc.
  }
};

const ensureBrowserContext = async () => {
  if (!globalThis.__vitest_browser__) {
    throw new Error(
      '[qlip] screenshot() can only be used in Vitest Browser Mode.',
    );
  }

  // This compatibility export remains available throughout Qlip's supported
  // Vitest 2-4 range; `vitest/browser` cannot be statically resolved by V3.
  const browserModule = await import('@vitest/browser/context');
  const { page, commands } = browserModule;
  if (!page || !commands) {
    throw new Error(
      '[qlip] Playwright page is unavailable. Ensure Storybook Vitest addon is enabled.',
    );
  }
  return { page, commands };
};

/**
 * Convert Storybook's PascalCase / camelCase export-name convention
 * into the spaced Title Case Storybook itself uses for display
 * (e.g. `MultipleSubscriptionsUser` → `Multiple Subscriptions User`).
 * Mirrors the behaviour of `storyNameFromExport` in
 * `@storybook/csf` — kept in qlip so the manifest carries
 * display-ready names without forcing every consumer of the manifest
 * to depend on the Storybook package just for this transform.
 *
 * Acronym runs stay grouped (`SVGToPNG` → `SVG To PNG`) and numbers
 * stick to the preceding letters (`HTML5` → `HTML5`).
 */
const humanizeExportName = (exportName: string): string => {
  if (!exportName) return exportName;
  // Insert a space between a lowercase/digit and an uppercase letter,
  // and between an uppercase letter and the next uppercase + lowercase
  // run (handles acronyms like `SVGToPNG`).
  return exportName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
};

const resolveStoryInfo = (ctx: QlipStoryContext) => {
  const storyId = ctx.id ? String(ctx.id) : '';
  // Storybook 8.x's `composeStory()` returns a callable whose `.name`
  // property is the underlying function name (a bundler tag like
  // `"storyFn"`, NOT the story name). The actual story name is on
  // `.storyName`. addon-vitest assigns the whole composedStory to
  // `context.story`, so we prefer storyName here and fall back to
  // `name` only for older shapes / runners that pass a plain object.
  //
  // The value coming in is typically the PascalCase export name —
  // run it through `humanizeExportName` so the manifest carries the
  // spaced version Storybook itself displays.
  const rawName = ctx.storyName ?? ctx.name;
  // Humanize the export name UNLESS it's a known function-name tag
  // ("storyFn", "unboundStoryFn", ""). If we humanized "storyFn" to
  // "Story Fn" we'd defeat the downstream `isFunctionNameTag` guard
  // that uses these literal strings to recognise the bug-shape and
  // fall through to storyId-derived recovery.
  const humanizedName =
    rawName && !FUNCTION_NAME_TAGS.has(rawName)
      ? humanizeExportName(rawName)
      : rawName;
  return {
    id: storyId,
    title: ctx.title,
    name: humanizedName,
    // Filled by the auto/error capture entry points from the test
    // task's `meta.componentName` (addon-vitest); the composed story
    // context itself carries no component name.
    componentName: undefined as string | undefined,
    // Likewise filled at the entry points — the running .stories file.
    storyFilePath: undefined as string | undefined,
    parameters: ctx.parameters?.qlip,
  };
};

/**
 * Best-effort derivation of `storyTitle` and `storyName` from the
 * Storybook story id (`<kebab-title>--<kebab-name>`). Used as the
 * final fallback when `composeStory()`'s result hides the title (it
 * does in current Storybook) and neither `__STORYBOOK_PREVIEW__` nor
 * `ctx.task.suite.name` is populated (vitest browser mode via
 * addon-vitest).
 *
 * Kebab → title-cased segments joined with `/` for the title (since
 * Storybook IDs encode the title path's `/` separator as `-` after
 * kebab-casing). Multi-word component names like `TestDefinitionPanel`
 * collapse to `Test/Definition/Panel` — there's no structural signal
 * in the id alone to distinguish "deeper path" from "multi-word name".
 * Accept the minor cosmetic loss in exchange for usable groupings.
 */
const deriveTitleNameFromStoryId = (
  storyId: string,
): { title: string | undefined; name: string | undefined } => {
  if (!storyId || !storyId.includes('--')) {
    return { title: undefined, name: undefined };
  }
  const [titleKebab, nameKebab] = storyId.split('--', 2);
  const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const title = titleKebab
    ? titleKebab
        .split('-')
        .filter((seg) => seg.length > 0)
        .map(capitalize)
        .join('/')
    : undefined;
  const name = nameKebab
    ? nameKebab
        .split('-')
        .filter((seg) => seg.length > 0)
        .map(capitalize)
        .join(' ')
    : undefined;
  return { title: title || undefined, name: name || undefined };
};

const readStoryFromStore = (storyId: string) => {
  const globalAny = globalThis as {
    __STORYBOOK_PREVIEW__?: {
      storyStore?: {
        storyIndex?: Record<string, unknown> | { v?: Record<string, unknown> };
      };
      storyIndex?: Record<string, unknown> | { v?: Record<string, unknown> };
    };
    __STORYBOOK_STORY_STORE__?: {
      storyIndex?: Record<string, unknown> | { v?: Record<string, unknown> };
    };
  };

  const store =
    globalAny.__STORYBOOK_PREVIEW__?.storyStore ??
    globalAny.__STORYBOOK_STORY_STORE__;
  const previewIndex = globalAny.__STORYBOOK_PREVIEW__?.storyIndex;
  const rawIndex =
    (
      store?.storyIndex as
        | { v?: Record<string, unknown> }
        | Record<string, unknown>
        | undefined
    )?.v ??
    store?.storyIndex ??
    (
      previewIndex as
        | { v?: Record<string, unknown> }
        | Record<string, unknown>
        | undefined
    )?.v ??
    previewIndex;

  const entryMap =
    (rawIndex as { entries?: Record<string, unknown> } | undefined)?.entries ??
    (rawIndex as Record<string, unknown> | undefined);

  const entry = (
    entryMap as { [key: string]: { title?: string; name?: string } } | undefined
  )?.[storyId];
  if (!entry) {
    return null;
  }
  return {
    title: entry.title,
    name: entry.name,
  };
};

const shouldCaptureOnError = (
  defaults: { captureOnError: boolean },
  story?: QlipParameters,
) => story?.captureOnError ?? defaults.captureOnError;

/**
 * Inject a capture-time stylesheet that neutralises things which make a
 * screenshot non-deterministic or plain wrong: in-flight animations /
 * transitions and — the reason `disableBackdropFilter` exists —
 * `backdrop-filter`, which headless Chromium renders as an opaque black
 * rectangle because it can't sample the backdrop. Exported for unit
 * testing.
 */
export const applyCaptureStyleOverrides = ({
  disableAnimations,
  pauseAnimationsAtEnd,
  disableBackdropFilter,
}: {
  disableAnimations: boolean;
  pauseAnimationsAtEnd: boolean;
  disableBackdropFilter: boolean;
}) => {
  if (!globalThis.document) {
    return;
  }

  const doc = globalThis.document;
  const id = '__qlip-capture-style-overrides';
  const existing = doc.getElementById(id);

  const rules: string[] = [];
  if (disableAnimations) {
    rules.push(`
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    `);
  } else if (pauseAnimationsAtEnd) {
    rules.push(`
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `);
  }
  if (disableBackdropFilter) {
    rules.push(`
      *, *::before, *::after {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
    `);
  }

  if (rules.length === 0) {
    if (existing) {
      existing.remove();
    }
    return;
  }

  const style = existing ?? doc.createElement('style');
  style.id = id;
  style.textContent = rules.join('\n');
  if (!existing) {
    doc.head.appendChild(style);
  }

  if (typeof doc.getAnimations === 'function') {
    const animations = doc.getAnimations();
    for (const animation of animations) {
      if (disableAnimations && typeof animation.finish === 'function') {
        animation.finish();
      } else if (
        pauseAnimationsAtEnd &&
        typeof animation.pause === 'function'
      ) {
        animation.pause();
      }
    }
  }
};

const waitForDomIdle = async (idleMs: number, maxWaitMs: number) => {
  if (idleMs <= 0) {
    return;
  }

  const doc = globalThis.document;
  if (!doc || typeof MutationObserver === 'undefined') {
    await new Promise((resolve) => realSetTimeout(resolve, idleMs));
    return;
  }

  // Use the pristine clock + timers (see ./clock.ts): stories that mock
  // the date (e.g. Storybook's `parameters.mockdate`) freeze `Date.now()`,
  // which made this wait never observe elapsed time and spin until the
  // afterEach hook timed out.
  await new Promise<void>((resolve) => {
    const start = monotonicNow();
    const resolvedMaxWait = Math.max(idleMs, maxWaitMs);
    let lastChange = monotonicNow();
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      observer.disconnect();
      realClearInterval(checkInterval);
      resolve();
    };

    const observer = new MutationObserver(() => {
      lastChange = monotonicNow();
    });

    observer.observe(doc.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    const checkInterval = realSetInterval(
      () => {
        const now = monotonicNow();
        if (now - lastChange >= idleMs || now - start >= resolvedMaxWait) {
          finish();
        }
      },
      Math.min(50, idleMs),
    );
  });
};

const applyIgnoreMasks = (selectors: string[]) => {
  if (!globalThis.document || selectors.length === 0) {
    return () => undefined;
  }

  const doc = globalThis.document;
  const masks: HTMLElement[] = [];
  for (const selector of selectors) {
    const nodes = Array.from(doc.querySelectorAll<HTMLElement>(selector));
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const mask = doc.createElement('div');
      mask.setAttribute('data-qlip-mask', selector);
      mask.style.position = 'fixed';
      mask.style.left = `${rect.left}px`;
      mask.style.top = `${rect.top}px`;
      mask.style.width = `${rect.width}px`;
      mask.style.height = `${rect.height}px`;
      mask.style.background = '#000';
      mask.style.pointerEvents = 'none';
      mask.style.zIndex = '2147483647';
      doc.body.appendChild(mask);
      masks.push(mask);
    }
  }

  return () => {
    for (const mask of masks) {
      mask.remove();
    }
  };
};

const pickUniqueErrorName = (entries: QlipManifestEntry[]) => {
  const reserved = new Set(
    entries
      .filter((entry) =>
        entry.screenshotName.startsWith(AUTO_ERROR_SCREENSHOT_BASE),
      )
      .map((entry) => entry.screenshotName),
  );
  if (!reserved.has(AUTO_ERROR_SCREENSHOT_BASE)) {
    return AUTO_ERROR_SCREENSHOT_BASE;
  }
  let index = 2;
  while (reserved.has(`${AUTO_ERROR_SCREENSHOT_BASE}-${index}`)) {
    index += 1;
  }
  return `${AUTO_ERROR_SCREENSHOT_BASE}-${index}`;
};

const resolveManualArgs = (
  nameOrOptions?: string | QlipScreenshotOptions,
  options?: QlipScreenshotOptions,
) => {
  if (typeof nameOrOptions === 'string') {
    return { name: nameOrOptions, options };
  }
  return { name: nameOrOptions?.name, options: nameOrOptions };
};

const buildEntry = ({
  kind,
  storyId,
  storyTitle,
  storyName,
  componentName,
  storyFilePath,
  screenshotName,
  relativePath,
  viewport,
  status,
  error,
  timingsMs,
  logsPath,
}: {
  kind: QlipEntryKind;
  storyId: string;
  storyTitle?: string;
  storyName?: string;
  componentName?: string;
  storyFilePath?: string;
  screenshotName: string;
  relativePath: string;
  viewport: QlipViewport;
  status: QlipEntryStatus;
  error: { message: string; stack?: string } | null;
  timingsMs: number;
  logsPath?: string;
}) => ({
  kind,
  storyId,
  storyTitle,
  storyName,
  screenshotName,
  path: relativePath,
  viewport,
  status,
  error,
  timings: { ms: timingsMs },
  ...(componentName ? { componentName } : {}),
  ...(storyFilePath ? { storyFilePath } : {}),
  ...(logsPath ? { logsPath } : {}),
});

const captureScreenshot = async ({
  kind,
  story,
  screenshotName,
  options,
  testError,
}: {
  kind: QlipEntryKind;
  story: ReturnType<typeof resolveStoryInfo>;
  screenshotName?: string;
  options?: QlipScreenshotOptions;
  /**
   * For `kind: 'error'` captures, the originating test failure that
   * triggered this screenshot. Stored on the manifest entry's
   * `error` field even when the screenshot itself captures
   * successfully — so reviewers see *why* the test failed, not just
   * the post-failure DOM.
   */
  testError?: { message: string; stack?: string } | null;
}) => {
  const runtime = initRuntimeState();
  if (!runtime) {
    console.warn(
      '[qlip] Runtime config is missing. screenshot() only works in Vitest with qlipVitestPlugin enabled.',
    );
    return;
  }
  const { page, commands } = await ensureBrowserContext();

  if (!story.id) {
    if (!runtime.warnedMissingStorybook) {
      console.warn(
        '[qlip] No story context detected. Qlip only captures Storybook Vitest stories.',
      );
      markStorybookWarning(runtime);
    }
    return;
  }

  const resolved = resolveQlipOptions({
    defaults: runtime.config.defaults,
    story: story.parameters,
    override: options,
  });

  // Name conventions:
  //   - 'auto'   → fixed 'auto'
  //   - 'manual' → user-supplied or auto-numbered ('step-1'…)
  //   - 'error'  → 'qlip-auto-error-capture' (or '-2', '-3' for
  //                multiple errors on the same story). The
  //                `qlip-auto-error-capture` prefix is what the
  //                fs/output layer keys off to route to `error/`.
  const name =
    kind === 'manual'
      ? sanitizeSegment(screenshotName ?? nextStepName(runtime, story.id))
      : kind === 'error'
        ? sanitizeSegment(screenshotName ?? AUTO_ERROR_SCREENSHOT_BASE)
        : 'auto';

  const captureStart = monotonicNow();

  // `kind: 'error'` shares the manual path resolver — the helper
  // detects the `qlip-auto-error-capture` prefix on the screenshot
  // name and routes to the `error/` subtree automatically.
  const usesNamedPath = kind === 'manual' || kind === 'error';

  if (resolved.skip) {
    flushConsoleLogs(runtime);
    pushEntry(
      runtime,
      buildEntry({
        kind,
        storyId: story.id,
        storyTitle: story.title,
        storyName: story.name,
        componentName: story.componentName,
        storyFilePath: story.storyFilePath,
        screenshotName: name,
        relativePath: usesNamedPath
          ? buildManualScreenshotPath({
              buildDir: runtime.config.buildDir,
              storyId: story.id,
              storyTitle: story.title,
              storyName: story.name,
              screenshotName: name,
            }).relativePath
          : buildAutoScreenshotPath({
              buildDir: runtime.config.buildDir,
              storyId: story.id,
              storyTitle: story.title,
              storyName: story.name,
            }).relativePath,
        viewport: resolved.viewport,
        status: 'skipped',
        error: testError ?? null,
        timingsMs: monotonicNow() - captureStart,
      }),
    );
    updateStats(runtime, {
      storiesTotal:
        kind === 'auto'
          ? runtime.manifest.stats.storiesTotal + 1
          : runtime.manifest.stats.storiesTotal,
      skipped: runtime.manifest.stats.skipped + 1,
    });
    await writeManifestFragment(
      commands,
      runtime.config.buildDir,
      runtime.fragmentId,
      runtime.manifest,
    );
    return;
  }

  let relativePath = '';
  let absolutePath = '';
  if (usesNamedPath) {
    const pathInfo = buildManualScreenshotPath({
      buildDir: runtime.config.buildDir,
      storyId: story.id,
      storyTitle: story.title,
      storyName: story.name,
      screenshotName: name,
    });
    relativePath = pathInfo.relativePath;
    absolutePath = pathInfo.absolutePath;
  } else {
    const pathInfo = buildAutoScreenshotPath({
      buildDir: runtime.config.buildDir,
      storyId: story.id,
      storyTitle: story.title,
      storyName: story.name,
    });
    relativePath = pathInfo.relativePath;
    absolutePath = pathInfo.absolutePath;
  }

  let status: QlipEntryStatus = 'captured';
  // Pre-seed `error` with the originating test failure (if any) so
  // it survives a successful capture; the catch block below
  // overwrites with the *capture* error if the PNG write itself
  // throws.
  let error: { message: string; stack?: string } | null = testError ?? null;
  let cleanupMasks: (() => void) | null = null;
  try {
    await page.viewport(resolved.viewport.width, resolved.viewport.height);
    applyCaptureStyleOverrides({
      disableAnimations: resolved.disableAnimations,
      pauseAnimationsAtEnd: resolved.pauseAnimationsAtEnd,
      disableBackdropFilter: resolved.disableBackdropFilter,
    });
    await waitForDomIdle(resolved.waitForIdleMs, resolved.maxWaitForIdleMs);
    cleanupMasks = applyIgnoreMasks(resolved.ignoreElements);
    await page.screenshot({ path: absolutePath, save: true });
  } catch (err) {
    status = 'failed';
    const typedError = err as Error;
    error = {
      message: typedError.message,
      stack: typedError.stack,
    };
  } finally {
    if (cleanupMasks) {
      cleanupMasks();
    }
  }

  const flushed = flushConsoleLogs(runtime);
  let logsPath: string | undefined;
  if (resolved.captureConsole && flushed.length > 0) {
    const logPathInfo = usesNamedPath
      ? buildManualLogPath({
          buildDir: runtime.config.buildDir,
          storyId: story.id,
          storyTitle: story.title,
          storyName: story.name,
          screenshotName: name,
        })
      : buildAutoLogPath({
          buildDir: runtime.config.buildDir,
          storyId: story.id,
          storyTitle: story.title,
          storyName: story.name,
        });
    logsPath = logPathInfo.relativePath;
    await commands.writeFile(
      logPathInfo.absolutePath,
      JSON.stringify(flushed, null, 2),
      'utf-8',
    );
  }

  const entry = buildEntry({
    kind,
    storyId: story.id,
    storyTitle: story.title,
    storyName: story.name,
    componentName: story.componentName,
    storyFilePath: story.storyFilePath,
    screenshotName: name,
    relativePath,
    viewport: resolved.viewport,
    status,
    error,
    timingsMs: monotonicNow() - captureStart,
    logsPath,
  });

  pushEntry(runtime, entry);
  if (kind === 'auto') {
    updateStats(runtime, {
      storiesTotal: runtime.manifest.stats.storiesTotal + 1,
      capturedAuto:
        status === 'captured'
          ? runtime.manifest.stats.capturedAuto + 1
          : runtime.manifest.stats.capturedAuto,
      failed:
        status === 'failed'
          ? runtime.manifest.stats.failed + 1
          : runtime.manifest.stats.failed,
    });
  } else if (kind === 'error') {
    // Error captures don't bump `storiesTotal` (the matching auto
    // entry already did) and don't count toward `capturedManual`
    // (they're not user-initiated `screenshot()` calls). They DO
    // bump `failed` so the build-level failed counter reflects
    // story test failures even when the auto capture happened to
    // succeed. The server filters error-kind entries to render the
    // dedicated "Failures" surface.
    updateStats(runtime, {
      failed:
        status === 'captured' || status === 'failed'
          ? runtime.manifest.stats.failed + 1
          : runtime.manifest.stats.failed,
    });
  } else {
    updateStats(runtime, {
      capturedManual:
        status === 'captured'
          ? runtime.manifest.stats.capturedManual + 1
          : runtime.manifest.stats.capturedManual,
      failed:
        status === 'failed'
          ? runtime.manifest.stats.failed + 1
          : runtime.manifest.stats.failed,
    });
  }

  await writeManifestFragment(
    commands,
    runtime.config.buildDir,
    runtime.fragmentId,
    runtime.manifest,
  );
};

export const screenshot = async (
  ctx: QlipStoryContext,
  nameOrOptions?: string | QlipScreenshotOptions,
  options?: QlipScreenshotOptions,
) => {
  const runtime = initRuntimeState();
  if (!runtime) {
    return;
  }
  const { name, options: resolvedOptions } = resolveManualArgs(
    nameOrOptions,
    options,
  );
  const story = resolveStoryInfo(ctx);
  const params = story.parameters;
  const finalOptions = resolveQlipOptions({
    defaults: runtime.config.defaults,
    story: params,
    override: resolvedOptions,
  });
  if (!finalOptions.manual) {
    return;
  }
  await captureScreenshot({
    kind: 'manual',
    story,
    screenshotName: name,
    options: resolvedOptions,
  });
};

type QlipTestContext = TestContext & { story?: QlipStoryContext };

// Heuristic: `name` values that came from a callable function's
// `.name` property (bundler-tagged like `"storyFn"`) are not real
// story names. Treat them as missing so the fallback chain can
// recover from storyId. See `resolveStoryInfo` for context.
const FUNCTION_NAME_TAGS = new Set(['storyFn', 'unboundStoryFn', '']);
const isFunctionNameTag = (value: string | undefined): boolean =>
  value === undefined || FUNCTION_NAME_TAGS.has(value);

/**
 * The story's component (CSF default export) name as exposed by
 * addon-vitest on `task.meta.componentName` (e.g. "ReqoreEntityRow").
 * This is the only trustworthy component identity at capture time —
 * unlike the storyId-derived title, it can't collapse distinct
 * components to a shared kebab leaf. Returns undefined when absent
 * (older addon, non-Storybook runners).
 */
const metaComponentName = (ctx: QlipTestContext): string | undefined => {
  const name = (ctx.task.meta as { componentName?: string } | undefined)
    ?.componentName;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
};

/**
 * The `.stories.tsx` file the running story is defined in. Primary
 * source is the vitest worker's current test module (addon-vitest reads
 * the same for its own per-file guards); the fallback is addon-vitest's
 * `task.meta.componentPath` (the stories file only in the newer
 * CSF-factory format, a component import path otherwise).
 */
const resolveStoryFilePath = (ctx: QlipTestContext): string | undefined => {
  const workerPath = (
    globalThis as { __vitest_worker__?: { filepath?: string } }
  ).__vitest_worker__?.filepath;
  if (typeof workerPath === 'string' && workerPath.length > 0) {
    return workerPath;
  }
  const componentPath = (
    ctx.task.meta as { componentPath?: string } | undefined
  )?.componentPath;
  return typeof componentPath === 'string' && componentPath.length > 0
    ? componentPath
    : undefined;
};

export const captureAutoScreenshot = async (ctx: QlipTestContext) => {
  const runtime = initRuntimeState();
  if (!runtime) {
    return;
  }
  const storyContext = ctx.story ?? {};
  const story = resolveStoryInfo(storyContext);
  const params = story.parameters;
  const resolvedOptions = resolveQlipOptions({
    defaults: runtime.config.defaults,
    story: params,
  });
  if (!resolvedOptions.auto) {
    return;
  }
  const metaStoryId = (ctx.task.meta as { storyId?: string } | undefined)
    ?.storyId;
  if (!story.id && typeof metaStoryId === 'string') {
    story.id = metaStoryId;
  }
  story.componentName = metaComponentName(ctx);
  story.storyFilePath = resolveStoryFilePath(ctx);
  if (story.id && (!story.title || !story.name)) {
    const storeStory = readStoryFromStore(story.id);
    if (storeStory?.title && !story.title) {
      story.title = storeStory.title;
    }
    if (storeStory?.name && !story.name) {
      story.name = storeStory.name;
    }
  }
  if (isFunctionNameTag(story.name) && ctx.task.name) {
    story.name = ctx.task.name;
  }
  if (!story.title && ctx.task.suite?.name) {
    story.title = ctx.task.suite.name;
  }
  // Final fallback: derive from the storyId itself. Handles addon-vitest
  // where `composeStory` hides the title and `__STORYBOOK_PREVIEW__`
  // isn't initialized — see PROGRESS.md 2026-05-25.
  if (story.id && (!story.title || isFunctionNameTag(story.name))) {
    const derived = deriveTitleNameFromStoryId(story.id);
    if (!story.title && derived.title) {
      story.title = derived.title;
    }
    if (isFunctionNameTag(story.name) && derived.name) {
      story.name = derived.name;
    }
  }

  // Retry-mask fix: when vitest is configured with `retry > 0` and an
  // earlier attempt for THIS story failed but the current attempt
  // passed, drop the error captures those earlier attempts pushed to
  // the manifest. Left alone they'd upload alongside the successful
  // auto capture and surface as failures in the review UI even though
  // CI is green — the "green CI, red visual" gap Qlip is meant to
  // eliminate. Capture-presence alone is NOT a safe pass signal
  // (auto captures fire when the DOM settles regardless of play-test
  // outcome), so we key on vitest's authoritative `task.result`.
  const currentResult = ctx.task.result;
  const retryCount = currentResult?.retryCount ?? 0;
  if (
    story.id &&
    currentResult?.state === 'pass' &&
    retryCount > 0
  ) {
    const pruned = pruneStaleErrorEntries(runtime, story.id);
    if (pruned.length) {
      const { commands } = await ensureBrowserContext();
      for (const entry of pruned) {
        if (entry.path) {
          await bestEffortRemoveFile(
            commands,
            joinPath(runtime.config.buildDir, entry.path),
          );
        }
        if (entry.logsPath) {
          await bestEffortRemoveFile(
            commands,
            joinPath(runtime.config.buildDir, entry.logsPath),
          );
        }
      }
    }
  }

  await captureScreenshot({
    kind: 'auto',
    story,
  });
};

export const captureErrorScreenshot = async (ctx: QlipTestContext) => {
  const runtime = initRuntimeState();
  if (!runtime) {
    return;
  }
  const storyContext = ctx.story ?? {};
  const story = resolveStoryInfo(storyContext);
  const errorMetaStoryId = (ctx.task.meta as { storyId?: string } | undefined)
    ?.storyId;
  if (!story.id && typeof errorMetaStoryId === 'string') {
    story.id = errorMetaStoryId;
  }
  story.componentName = metaComponentName(ctx);
  story.storyFilePath = resolveStoryFilePath(ctx);
  const params = story.parameters;
  const resolvedOptions = resolveQlipOptions({
    defaults: runtime.config.defaults,
    story: params,
  });
  if (resolvedOptions.skip) {
    return;
  }
  if (!resolvedOptions.error) {
    return;
  }
  if (!shouldCaptureOnError(runtime.config.defaults, params)) {
    return;
  }
  if (story.id && (!story.title || !story.name)) {
    const storeStory = readStoryFromStore(story.id);
    if (storeStory?.title && !story.title) {
      story.title = storeStory.title;
    }
    if (storeStory?.name && !story.name) {
      story.name = storeStory.name;
    }
  }
  if (isFunctionNameTag(story.name) && ctx.task.name) {
    story.name = ctx.task.name;
  }
  if (!story.title && ctx.task.suite?.name) {
    story.title = ctx.task.suite.name;
  }
  // Final fallback: derive from the storyId. Same logic as the auto
  // path; the error capture inherits all the same context-shape
  // limitations of addon-vitest.
  if (story.id && (!story.title || isFunctionNameTag(story.name))) {
    const derived = deriveTitleNameFromStoryId(story.id);
    if (!story.title && derived.title) {
      story.title = derived.title;
    }
    if (isFunctionNameTag(story.name) && derived.name) {
      story.name = derived.name;
    }
  }
  // Pull the originating test failure from Vitest's `task.result`
  // shape so the manifest entry carries *why* the test failed, not
  // just the post-failure DOM. Falls back to a generic marker if the
  // shape isn't available (older Vitest, custom runner adapters).
  const failureError = extractTestFailureError(ctx);
  await captureScreenshot({
    kind: 'error',
    story,
    screenshotName: pickUniqueErrorName(runtime.manifest.entries),
    testError: failureError,
  });
};

/**
 * Strip ANSI escape sequences (color codes, cursor moves, etc.) from a
 * string. Storybook's `addon-vitest` setup-file decorates failures
 * with a clickable-link preamble wrapped in ANSI color escapes
 * (`\x1b[34m…\x1b[39m`), and Vitest's pretty-printer can wrap stacks
 * with bold/dim sequences. The manifest stores raw bytes — leaving
 * the escapes in produces noisy `[34m` literals in the dashboard's
 * FailureCollection surface. Strip at the boundary so what's stored
 * is what gets displayed.
 */
const ANSI_ESCAPE_RE = /\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (value: string): string => value.replace(ANSI_ESCAPE_RE, '');

/**
 * Pull the first failure-error from a Vitest task result. Vitest
 * stores them as an array on `task.result.errors`; in practice
 * the first entry is the one that actually fired. Returns null when
 * the shape is missing so the manifest entry's `error` field stays
 * null rather than carrying a misleading placeholder.
 *
 * Both `message` and `stack` are ANSI-stripped on the way out — they
 * land in the manifest and the dashboard, neither of which renders
 * terminal escape sequences.
 */
const extractTestFailureError = (
  ctx: QlipTestContext,
): { message: string; stack?: string } | null => {
  const result = (ctx.task as { result?: { errors?: unknown } }).result;
  if (!result || !Array.isArray(result.errors) || result.errors.length === 0) {
    return null;
  }
  const first = result.errors[0] as
    | { message?: unknown; stack?: unknown }
    | undefined;
  if (!first || typeof first.message !== 'string') {
    return null;
  }
  return {
    message: stripAnsi(first.message),
    stack: typeof first.stack === 'string' ? stripAnsi(first.stack) : undefined,
  };
};

import {
  QlipEntryKind,
  QlipEntryStatus,
  QlipScreenshotOptions,
  QlipStoryContext,
  QlipViewport,
} from '../types.js';
import { resolveQlipOptions } from '../config/parameters.js';
import {
  AUTO_ERROR_SCREENSHOT_BASE,
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
  pushEntry,
  updateStats,
} from './context.js';
import type { TestContext } from 'vitest';
import type { QlipParameters, QlipManifestEntry } from '../types.js';

const ensureBrowserContext = async () => {
  if (!globalThis.__vitest_browser__) {
    throw new Error(
      '[qlip] screenshot() can only be used in Vitest Browser Mode.',
    );
  }

  const { page, commands } = await import('@vitest/browser/context');
  if (!page || !commands) {
    throw new Error(
      '[qlip] Playwright page is unavailable. Ensure Storybook Vitest addon is enabled.',
    );
  }
  return { page, commands };
};

const resolveStoryInfo = (ctx: QlipStoryContext) => {
  const storyId = ctx.id ? String(ctx.id) : '';
  return {
    id: storyId,
    title: ctx.title,
    name: ctx.name,
    parameters: ctx.parameters?.qlip,
  };
};

const readStoryFromStore = (storyId: string) => {
  const globalAny = globalThis as {
    __STORYBOOK_PREVIEW__?: {
      storyStore?: { storyIndex?: Record<string, unknown> | { v?: Record<string, unknown> } };
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
    (store?.storyIndex as { v?: Record<string, unknown> } | Record<string, unknown> | undefined)?.v ??
    store?.storyIndex ??
    (previewIndex as { v?: Record<string, unknown> } | Record<string, unknown> | undefined)?.v ??
    previewIndex;

  const entryMap =
    (rawIndex as { entries?: Record<string, unknown> } | undefined)?.entries ??
    (rawIndex as Record<string, unknown> | undefined);

  const entry = (entryMap as { [key: string]: { title?: string; name?: string } } | undefined)?.[
    storyId
  ];
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

const applyAnimationControl = ({
  disableAnimations,
  pauseAnimationsAtEnd,
}: {
  disableAnimations: boolean;
  pauseAnimationsAtEnd: boolean;
}) => {
  if (!globalThis.document) {
    return;
  }

  const doc = globalThis.document;
  const id = '__qlip-animation-control';
  const existing = doc.getElementById(id);

  if (!disableAnimations && !pauseAnimationsAtEnd) {
    if (existing) {
      existing.remove();
    }
    return;
  }

  const style = existing ?? doc.createElement('style');
  style.id = id;
  if (disableAnimations) {
    style.textContent = `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    `;
  } else {
    style.textContent = `
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `;
  }
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
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    return;
  }

  await new Promise<void>((resolve) => {
    const start = Date.now();
    const resolvedMaxWait = Math.max(idleMs, maxWaitMs);
    let lastChange = Date.now();
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      observer.disconnect();
      clearInterval(checkInterval);
      resolve();
    };

    const observer = new MutationObserver(() => {
      lastChange = Date.now();
    });

    observer.observe(doc.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    const checkInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastChange >= idleMs || now - start >= resolvedMaxWait) {
        finish();
      }
    }, Math.min(50, idleMs));
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
      .filter((entry) => entry.screenshotName.startsWith(AUTO_ERROR_SCREENSHOT_BASE))
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
  ...(logsPath ? { logsPath } : {}),
});

const captureScreenshot = async ({
  kind,
  story,
  screenshotName,
  options,
}: {
  kind: QlipEntryKind;
  story: ReturnType<typeof resolveStoryInfo>;
  screenshotName?: string;
  options?: QlipScreenshotOptions;
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

  const name =
    kind === 'manual'
      ? sanitizeSegment(screenshotName ?? nextStepName(runtime, story.id))
      : 'auto';

  const captureStart = Date.now();

  if (resolved.skip) {
    flushConsoleLogs(runtime);
    pushEntry(
      runtime,
      buildEntry({
        kind,
        storyId: story.id,
        storyTitle: story.title,
        storyName: story.name,
        screenshotName: name,
        relativePath:
          kind === 'manual'
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
        error: null,
        timingsMs: Date.now() - captureStart,
      }),
    );
    updateStats(runtime, {
      storiesTotal:
        kind === 'auto'
          ? runtime.manifest.stats.storiesTotal + 1
          : runtime.manifest.stats.storiesTotal,
      skipped: runtime.manifest.stats.skipped + 1,
    });
    await commands.writeFile(
      joinPath(runtime.config.buildDir, 'manifest.json'),
      JSON.stringify(runtime.manifest, null, 2),
      'utf-8',
    );
    return;
  }

  let relativePath = '';
  let absolutePath = '';
  if (kind === 'manual') {
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
  let error: { message: string; stack?: string } | null = null;
  let cleanupMasks: (() => void) | null = null;
  try {
    await page.viewport(resolved.viewport.width, resolved.viewport.height);
    applyAnimationControl({
      disableAnimations: resolved.disableAnimations,
      pauseAnimationsAtEnd: resolved.pauseAnimationsAtEnd,
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
    const logPathInfo =
      kind === 'manual'
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
    screenshotName: name,
    relativePath,
    viewport: resolved.viewport,
    status,
    error,
    timingsMs: Date.now() - captureStart,
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

  await commands.writeFile(
    joinPath(runtime.config.buildDir, 'manifest.json'),
    JSON.stringify(runtime.manifest, null, 2),
    'utf-8',
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

export const captureAutoScreenshot = async (ctx: QlipTestContext) => {
  const runtime = initRuntimeState();
  if (!runtime) {
    return;
  }
  const storyContext = ctx.story ?? {};
  const story = resolveStoryInfo(storyContext);
  const params = story.parameters;
  const resolvedOptions = resolveQlipOptions({ defaults: runtime.config.defaults, story: params });
  if (!resolvedOptions.auto) {
    return;
  }
  const metaStoryId = (ctx.task.meta as { storyId?: string } | undefined)
    ?.storyId;
  if (!story.id && typeof metaStoryId === 'string') {
    story.id = metaStoryId;
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
  if (!story.name && ctx.task.name) {
    story.name = ctx.task.name;
  }
  if (!story.title && ctx.task.suite?.name) {
    story.title = ctx.task.suite.name;
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
  const params = story.parameters;
  const resolvedOptions = resolveQlipOptions({ defaults: runtime.config.defaults, story: params });
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
  if (!story.name && ctx.task.name) {
    story.name = ctx.task.name;
  }
  if (!story.title && ctx.task.suite?.name) {
    story.title = ctx.task.suite.name;
  }
  await captureScreenshot({
    kind: 'manual',
    story,
    screenshotName: pickUniqueErrorName(runtime.manifest.entries),
  });
};

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureAutoScreenshot,
  captureErrorScreenshot,
  screenshot,
} from '../../src/runtime/screenshot.js';
import { getRuntimeState } from '../../src/runtime/context.js';
import type { QlipRuntimeConfig } from '../../src/types.js';

vi.mock('@vitest/browser/context', () => {
  const page = {
    viewport: vi.fn(),
    screenshot: vi.fn(),
  };
  const commands = {
    writeFile: vi.fn(),
  };
  return { page, commands };
});

const runtimeConfig: QlipRuntimeConfig = {
  buildId: 'test-build',
  outputDir: '/tmp/qlip/screenshots',
  buildDir: '/tmp/qlip/screenshots/test-build',
  defaults: {
    outputDir: './qlip/screenshots',
    viewport: { width: 200, height: 200 },
    skip: false,
    disableAnimations: false,
    pauseAnimationsAtEnd: false,
    captureOnError: false,
    waitForIdleMs: 300,
    maxWaitForIdleMs: 2000,
    ignoreElements: [],
    auto: true,
    manual: true,
    error: true,
    captureConsole: true,
    captureConsoleLevels: ['error'],
    maxConsoleLogs: 50,
    consoleLogExcludePatterns: [],
  },
  tool: { name: 'qlip', version: '0.1.0' },
};

const resetRuntime = () => {
  delete (globalThis as { __QLIP_RUNTIME__?: unknown }).__QLIP_RUNTIME__;
};

const setConfig = () => {
  globalThis.__QLIP_CONFIG__ = runtimeConfig;
  globalThis.__vitest_browser__ = true;
};

beforeEach(async () => {
  resetRuntime();
  setConfig();
  const { page, commands } = await import('@vitest/browser/context');
  page.viewport.mockReset();
  page.screenshot.mockReset();
  commands.writeFile.mockReset();
});

describe('screenshot capture', () => {
  it('captures manual screenshots with incremental names', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    const ctx = {
      id: 'example--button',
      title: 'Example/Button',
      name: 'Primary',
    };

    await screenshot(ctx);
    await screenshot(ctx);

    const state = getRuntimeState();
    expect(state?.manifest.entries).toHaveLength(2);
    expect(state?.manifest.entries[0].screenshotName).toBe('step-1');
    expect(state?.manifest.entries[1].screenshotName).toBe('step-2');
  });

  it('honors manual screenshot name from options', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    const ctx = {
      id: 'example--button',
      title: 'Example/Button',
      name: 'Primary',
    };

    await screenshot(ctx, { name: 'paused' });

    const state = getRuntimeState();
    expect(state?.manifest.entries[0].screenshotName).toBe('paused');
  });

  it('respects skip for auto screenshots', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    await captureAutoScreenshot({
      task: {
        meta: { storyId: 'example--page' },
        name: 'Logged Out',
        suite: { name: 'Example/Page' },
      },
      story: {
        id: 'example--page',
        parameters: { qlip: { skip: true } },
      },
    });

    const state = getRuntimeState();
    const entry = state?.manifest.entries[0];
    expect(entry?.status).toBe('skipped');
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(state?.manifest.stats.skipped).toBe(1);
    expect(state?.manifest.stats.storiesTotal).toBe(1);
  });

  it('applies viewport overrides for manual screenshots', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    const ctx = {
      id: 'example--page',
      title: 'Example/Page',
      name: 'Logged In',
      parameters: { qlip: { viewport: { width: 100, height: 100 } } },
    };

    await screenshot(ctx, { viewport: { width: 300, height: 300 } });

    expect(page.viewport).toHaveBeenCalledWith(300, 300);
  });

  it('captures error screenshot when enabled', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    globalThis.__QLIP_CONFIG__ = {
      ...runtimeConfig,
      defaults: {
        ...runtimeConfig.defaults,
        captureOnError: true,
      },
    };

    // Simulate Vitest's `task.result.errors` shape so the runtime
    // can pull the originating failure into the manifest entry.
    await captureErrorScreenshot({
      task: {
        meta: { storyId: 'example--page' },
        name: 'Logged In',
        suite: { name: 'Example/Page' },
        result: {
          errors: [
            {
              message: 'expected Button to be visible',
              stack: 'at play (Page.stories.ts:42:3)',
            },
          ],
        },
      },
      story: {
        id: 'example--page',
      },
    } as never);

    const state = getRuntimeState();
    const entry = state?.manifest.entries[0];
    expect(entry?.kind).toBe('error');
    expect(entry?.screenshotName).toBe('qlip-auto-error-capture');
    expect(entry?.error?.message).toBe('expected Button to be visible');
    expect(entry?.error?.stack).toBe('at play (Page.stories.ts:42:3)');
    // Error captures bump `failed` but NOT `capturedManual` (they
    // aren't user-initiated screenshot() calls) and NOT
    // `storiesTotal` (auto entry already counted it).
    expect(state?.manifest.stats.failed).toBe(1);
    expect(state?.manifest.stats.capturedManual).toBe(0);
    expect(state?.manifest.stats.storiesTotal).toBe(0);
    // File path lands under the `error/` subtree so static review
    // tooling can grep them out without re-reading the manifest.
    expect(entry?.path).toMatch(/\/error\//);
  });

  it('error capture survives missing task.result (older Vitest shape)', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');
    globalThis.__QLIP_CONFIG__ = {
      ...runtimeConfig,
      defaults: { ...runtimeConfig.defaults, captureOnError: true },
    };
    await captureErrorScreenshot({
      task: {
        meta: { storyId: 'example--page' },
        name: 'Logged In',
        suite: { name: 'Example/Page' },
      },
      story: { id: 'example--page' },
    } as never);
    const entry = getRuntimeState()?.manifest.entries[0];
    expect(entry?.kind).toBe('error');
    // No error info available → field stays null rather than
    // carrying a misleading placeholder.
    expect(entry?.error).toBeNull();
  });

  it('records failures when capture throws', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockRejectedValue(new Error('boom'));

    await captureAutoScreenshot({
      task: {
        meta: { storyId: 'example--page' },
        name: 'Logged In',
        suite: { name: 'Example/Page' },
      },
      story: {
        id: 'example--page',
      },
    });

    const state = getRuntimeState();
    const entry = state?.manifest.entries[0];
    expect(entry?.status).toBe('failed');
    expect(entry?.error?.message).toBe('boom');
    expect(state?.manifest.stats.failed).toBe(1);
  });

  // 2026-05-25: regression coverage for the composedStory shape
  // exposed by `@storybook/experimental-addon-test`. Its
  // `context.story` is a callable function whose `.name` is the
  // bundler-tagged function name ("storyFn"), not the story name.
  // The real name lives on `.storyName`; the title isn't exposed at
  // all and must be derived from the storyId. See PROGRESS.md
  // 2026-05-25 entry on story-identity extraction.
  it('reads storyName off composedStory and derives title from storyId', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    // Mimic the shape addon-vitest assigns to context.story.
    const composedStory = Object.assign(
      function storyFn() {
        /* the bundler tags this as `.name === "storyFn"` */
      },
      {
        id: 'components-guide--default',
        storyName: 'Default',
        // no .title — composeStory never re-exposes meta.title
      },
    );

    await captureAutoScreenshot({
      task: { meta: { storyId: 'components-guide--default' }, name: 'Default' },
      story: composedStory as never,
    });

    const entry = getRuntimeState()?.manifest.entries[0];
    expect(entry?.storyName).toBe('Default');
    expect(entry?.storyTitle).toBe('Components/Guide');
    expect(entry?.storyId).toBe('components-guide--default');
  });

  it('recovers when storyName is missing and only the function name "storyFn" is available', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    // Worst case: composedStory has the bundler tag and nothing else
    // usable in ctx.story; the runtime must derive from storyId.
    const composedStory = Object.assign(function storyFn() {}, {
      id: 'fields-service-webhooks--new-webhook-can-be-added',
    });

    await captureAutoScreenshot({
      task: {
        meta: {
          storyId: 'fields-service-webhooks--new-webhook-can-be-added',
        },
        // task.name in addon-vitest could itself be "storyFn" in some
        // shapes — make sure we don't accept that as a real name.
        name: 'storyFn',
      },
      story: composedStory as never,
    });

    const entry = getRuntimeState()?.manifest.entries[0];
    expect(entry?.storyTitle).toBe('Fields/Service/Webhooks');
    expect(entry?.storyName).toBe('New Webhook Can Be Added');
  });

  it('preserves explicit storyTitle / storyName when both are already set', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    await captureAutoScreenshot({
      task: { meta: { storyId: 'example--page' }, name: 'Logged In' },
      story: {
        id: 'example--page',
        title: 'Example/Page',
        name: 'Logged In',
      },
    } as never);

    const entry = getRuntimeState()?.manifest.entries[0];
    // Provided values win — the storyId-derivation is a fallback, not
    // a clobber.
    expect(entry?.storyTitle).toBe('Example/Page');
    // "Logged In" already has a space, so the humanizer is a no-op
    // (no PascalCase boundaries to break on).
    expect(entry?.storyName).toBe('Logged In');
  });

  // 2026-05-25: storyName humanization. Storybook's `composeStory`
  // exposes the PascalCase export name as `storyName` (e.g.
  // `MultipleSubscriptionsUser`). The dashboard wants the spaced
  // Title Case that Storybook itself displays. qlip applies
  // `humanizeExportName` once, at the manifest boundary, so every
  // downstream consumer (server, UI, exports) gets the readable
  // form for free.
  it('humanizes PascalCase storyName to spaced Title Case', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    await captureAutoScreenshot({
      task: { meta: { storyId: 'components-sidebar--multiple-subscriptions-user' } },
      story: {
        id: 'components-sidebar--multiple-subscriptions-user',
        storyName: 'MultipleSubscriptionsUser',
      },
    } as never);

    const entry = getRuntimeState()?.manifest.entries[0];
    expect(entry?.storyName).toBe('Multiple Subscriptions User');
  });

  it('keeps acronym runs together when humanizing (e.g. SVGToPNG → SVG To PNG)', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    await captureAutoScreenshot({
      task: { meta: { storyId: 'export--svg-to-png' } },
      story: { id: 'export--svg-to-png', storyName: 'SVGToPNG' },
    } as never);

    const entry = getRuntimeState()?.manifest.entries[0];
    expect(entry?.storyName).toBe('SVG To PNG');
  });

  it('does NOT humanize known function-name tags ("storyFn" etc.) — preserves the guard semantics', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');

    // ctx.story.name is the bundler tag "storyFn". The humanizer must
    // leave it alone so the downstream `isFunctionNameTag` check
    // still matches and the fallback chain can recover from storyId.
    // (Without this exemption we'd humanize "storyFn" → "Story Fn"
    // and ship that as a real-looking story name.)
    await captureAutoScreenshot({
      task: { meta: { storyId: 'fields-service-webhooks--default' } },
      story: Object.assign(function storyFn() {}, {
        id: 'fields-service-webhooks--default',
      }) as never,
    });

    const entry = getRuntimeState()?.manifest.entries[0];
    // Should have recovered to the storyId-derived name, not the
    // humanized garbage.
    expect(entry?.storyName).toBe('Default');
    expect(entry?.storyTitle).toBe('Fields/Service/Webhooks');
  });

  // 2026-05-25: ANSI escape codes leak into Vitest task errors via
  // Storybook addon-vitest's setup-file, which decorates failures
  // with a clickable-link preamble wrapped in colour escapes. The
  // manifest stores raw bytes; the dashboard renders text. Strip at
  // the qlip boundary so what's stored is what gets shown.
  it('strips ANSI escape sequences from error message and stack', async () => {
    const { page } = await import('@vitest/browser/context');
    page.screenshot.mockResolvedValue('ok');
    globalThis.__QLIP_CONFIG__ = {
      ...runtimeConfig,
      defaults: { ...runtimeConfig.defaults, captureOnError: true },
    };

    // Real Storybook addon-vitest decoration shape from a failing
    // play function — ESC `[34m...ESC[39m` brackets a debug URL,
    // then the assertion error follows.
    const decoratedMessage =
      '[34mClick to debug: http://localhost:6006/?path=/story/foo--bar[39m\n\nexpected Button to be visible';
    const decoratedStack =
      '[2m    at play (Foo.stories.ts:42:3)[22m';

    await captureErrorScreenshot({
      task: {
        meta: { storyId: 'example--page' },
        result: {
          errors: [{ message: decoratedMessage, stack: decoratedStack }],
        },
      },
      story: { id: 'example--page' },
    } as never);

    const entry = getRuntimeState()?.manifest.entries[0];
    // Color codes are gone; the human-readable content is preserved.
    expect(entry?.error?.message).toBe(
      'Click to debug: http://localhost:6006/?path=/story/foo--bar\n\nexpected Button to be visible',
    );
    expect(entry?.error?.stack).toBe(
      '    at play (Foo.stories.ts:42:3)',
    );
  });
});

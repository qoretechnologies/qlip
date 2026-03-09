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

    await captureErrorScreenshot({
      task: {
        meta: { storyId: 'example--page' },
        name: 'Logged In',
        suite: { name: 'Example/Page' },
      },
      story: {
        id: 'example--page',
      },
    } as never);

    const state = getRuntimeState();
    const entry = state?.manifest.entries[0];
    expect(entry?.kind).toBe('manual');
    expect(entry?.screenshotName).toBe('qlip-auto-error-capture');
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
});

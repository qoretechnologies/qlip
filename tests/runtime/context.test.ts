import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextStepName } from '../../src/runtime/context.js';
import type { QlipRuntimeConfig } from '../../src/types.js';

describe('nextStepName', () => {
  it('increments per story', () => {
    const state = {
      config: {
        buildId: 'test',
        outputDir: '/tmp/qlip',
        buildDir: '/tmp/qlip/test',
        defaults: {
          outputDir: './qlip/screenshots',
          viewport: { width: 1200, height: 800 },
          skip: false,
          disableAnimations: false,
          pauseAnimationsAtEnd: false,
          captureOnError: false,
          captureConsole: true,
          captureConsoleLevels: ['error'],
          maxConsoleLogs: 50,
          consoleLogExcludePatterns: [],
        },
        tool: { name: 'qlip', version: '0.0.0' },
      },
      manifest: {
        tool: { name: 'qlip', version: '0.0.0' },
        buildId: 'test',
        createdAt: new Date().toISOString(),
        outputDir: '/tmp/qlip/test',
        defaults: {
          outputDir: './qlip/screenshots',
          viewport: { width: 1200, height: 800 },
          skip: false,
          disableAnimations: false,
          pauseAnimationsAtEnd: false,
          captureOnError: false,
          captureConsole: true,
          captureConsoleLevels: ['error'],
          maxConsoleLogs: 50,
          consoleLogExcludePatterns: [],
        },
        stats: {
          storiesTotal: 0,
          capturedAuto: 0,
          capturedManual: 0,
          skipped: 0,
          failed: 0,
          durationMs: 0,
        },
        entries: [],
      },
      counters: new Map<string, number>(),
      startedAt: Date.now(),
      warnedMissingStorybook: false,
      consoleLogs: [],
      fragmentId: 'frag-test',
    };

    expect(nextStepName(state, 'story--one')).toBe('step-1');
    expect(nextStepName(state, 'story--one')).toBe('step-2');
    expect(nextStepName(state, 'story--two')).toBe('step-1');
  });
});

describe('initRuntimeState — build createdAt (qlip#33)', () => {
  const RealDate = Date;
  const scope = globalThis as {
    __QLIP_CONFIG__?: QlipRuntimeConfig;
    __QLIP_RUNTIME__?: unknown;
  };

  afterEach(() => {
    globalThis.Date = RealDate;
    delete scope.__QLIP_CONFIG__;
    delete scope.__QLIP_RUNTIME__;
    vi.resetModules();
  });

  /**
   * A Storybook preview's clock, as admin-portal installs it: `Date.now()`,
   * `new Date()` and `Date()` start at a fixed instant and run on, while a
   * date built from a value is untouched.
   */
  const installPreviewClock = (startsAt: string): void => {
    const offset = RealDate.parse(startsAt) - RealDate.now();
    const now = (): number => RealDate.now() + offset;
    const PreviewDate: DateConstructor = new Proxy(RealDate, {
      construct: (target, args, newTarget) =>
        Reflect.construct(
          target,
          args.length ? args : [now()],
          newTarget === PreviewDate ? target : newTarget,
        ) as object,
      apply: (target) => new target(now()).toString(),
      get: (target, property): unknown =>
        property === 'now' ? now : Reflect.get(target, property),
    });
    globalThis.Date = PreviewDate;
  };

  it('takes the build time from the plugin, not from a Date the preview replaced first', async () => {
    const createdAt = '2026-11-11T18:27:34.000Z';
    // The preview loads before qlip's runtime, so every module of the
    // runtime is evaluated against the replaced Date.
    installPreviewClock('2026-11-03T16:00:00Z');
    vi.resetModules();
    const { initRuntimeState } = await import('../../src/runtime/context.js');
    scope.__QLIP_CONFIG__ = {
      buildId: '20261111-182734',
      outputDir: '/tmp/qlip',
      buildDir: '/tmp/qlip/20261111-182734',
      createdAt,
      defaults: {} as QlipRuntimeConfig['defaults'],
      tool: { name: 'qlip', version: '0.0.0' },
    };

    const state = initRuntimeState();

    expect(new Date().toISOString().startsWith('2026-11-03T16:00')).toBe(true);
    expect(state?.manifest.createdAt).toBe(createdAt);
  });
});

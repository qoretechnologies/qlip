import { describe, expect, it } from 'vitest';
import { resolveQlipOptions } from '../../src/config/parameters.js';

describe('resolveQlipOptions', () => {
  it('prefers explicit overrides over story params and defaults', () => {
    const resolved = resolveQlipOptions({
      defaults: {
        outputDir: './qlip/screenshots',
        viewport: { width: 1200, height: 800 },
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
      story: {
        skip: true,
        viewport: { width: 800, height: 600 },
        disableAnimations: true,
        pauseAnimationsAtEnd: true,
        waitForIdleMs: 500,
        maxWaitForIdleMs: 4000,
        ignoreElements: ['.story-mask'],
        auto: false,
        manual: false,
        error: false,
        captureConsole: false,
        captureConsoleLevels: ['warn'],
        maxConsoleLogs: 10,
        consoleLogExcludePatterns: ['Warning:.*non-boolean'],
      },
      override: {
        skip: false,
        viewport: { width: 640, height: 480 },
        disableAnimations: false,
        pauseAnimationsAtEnd: false,
        waitForIdleMs: 100,
        maxWaitForIdleMs: 800,
        ignoreElements: ['[data-testid="mask"]'],
        auto: true,
        manual: true,
        error: true,
        captureConsole: true,
        captureConsoleLevels: ['error', 'warn'],
        maxConsoleLogs: 100,
        consoleLogExcludePatterns: ['Deprecated'],
      },
    });

    expect(resolved).toEqual({
      skip: false,
      viewport: { width: 640, height: 480 },
      disableAnimations: false,
      pauseAnimationsAtEnd: false,
      waitForIdleMs: 100,
      maxWaitForIdleMs: 800,
      ignoreElements: ['[data-testid="mask"]'],
      auto: true,
      manual: true,
      error: true,
      captureConsole: true,
      captureConsoleLevels: ['error', 'warn'],
      maxConsoleLogs: 100,
      consoleLogExcludePatterns: ['Deprecated'],
    });
  });

  it('falls back to story params when overrides are missing', () => {
    const resolved = resolveQlipOptions({
      defaults: {
        outputDir: './qlip/screenshots',
        viewport: { width: 1200, height: 800 },
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
      story: {
        skip: true,
        viewport: { width: 800, height: 600 },
        disableAnimations: true,
        pauseAnimationsAtEnd: true,
        waitForIdleMs: 500,
        maxWaitForIdleMs: 4000,
        ignoreElements: ['.story-mask'],
        auto: false,
        manual: false,
        error: false,
        captureConsole: false,
        captureConsoleLevels: ['warn'],
        maxConsoleLogs: 10,
        consoleLogExcludePatterns: ['Warning:.*non-boolean'],
      },
    });

    expect(resolved).toEqual({
      skip: true,
      viewport: { width: 800, height: 600 },
      disableAnimations: true,
      pauseAnimationsAtEnd: true,
      waitForIdleMs: 500,
      maxWaitForIdleMs: 4000,
      ignoreElements: ['.story-mask'],
      auto: false,
      manual: false,
      error: false,
      captureConsole: false,
      captureConsoleLevels: ['warn'],
      maxConsoleLogs: 10,
      consoleLogExcludePatterns: ['Warning:.*non-boolean'],
    });
  });

  it('uses defaults when no overrides or story params are present', () => {
    const resolved = resolveQlipOptions({
      defaults: {
        outputDir: './qlip/screenshots',
        viewport: { width: 1200, height: 800 },
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
    });

    expect(resolved).toEqual({
      skip: false,
      viewport: { width: 1200, height: 800 },
      disableAnimations: false,
      pauseAnimationsAtEnd: false,
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
    });
  });

  it('resolves disableBackdropFilter with override > story > defaults', () => {
    const base = {
      outputDir: './qlip/screenshots',
      viewport: { width: 1200, height: 800 },
      skip: false,
      disableAnimations: false,
      pauseAnimationsAtEnd: false,
      disableBackdropFilter: true,
      captureOnError: false,
      waitForIdleMs: 300,
      maxWaitForIdleMs: 2000,
      ignoreElements: [],
      auto: true,
      manual: true,
      error: true,
      captureConsole: true,
      captureConsoleLevels: ['error'] as const,
      maxConsoleLogs: 50,
      consoleLogExcludePatterns: [],
    };
    // Default wins when nothing overrides it.
    expect(
      resolveQlipOptions({ defaults: base }).disableBackdropFilter,
    ).toBe(true);
    // A story param overrides the default.
    expect(
      resolveQlipOptions({
        defaults: base,
        story: { disableBackdropFilter: false },
      }).disableBackdropFilter,
    ).toBe(false);
    // An explicit override beats both.
    expect(
      resolveQlipOptions({
        defaults: base,
        story: { disableBackdropFilter: false },
        override: { disableBackdropFilter: true },
      }).disableBackdropFilter,
    ).toBe(true);
  });
});

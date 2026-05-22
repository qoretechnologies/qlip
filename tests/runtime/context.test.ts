import { describe, expect, it } from 'vitest';
import { nextStepName } from '../../src/runtime/context.js';

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

import { describe, expect, it } from 'vitest';
import { flushConsoleLogs, pushConsoleLog } from '../../src/runtime/context.js';
import type { QlipRuntimeState } from '../../src/runtime/context.js';
import type { QlipConsoleMessage } from '../../src/types.js';

const createState = (): QlipRuntimeState => ({
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
  counters: new Map(),
  startedAt: Date.now(),
  warnedMissingStorybook: false,
  consoleLogs: [],
});

describe('pushConsoleLog', () => {
  it('adds a log entry to the buffer', () => {
    const state = createState();
    const log: QlipConsoleMessage = { level: 'error', message: 'test error', timestamp: 1000 };
    pushConsoleLog(state, log, 50);
    expect(state.consoleLogs).toHaveLength(1);
    expect(state.consoleLogs[0]).toEqual(log);
  });

  it('respects maxLogs cap', () => {
    const state = createState();
    for (let i = 0; i < 5; i++) {
      pushConsoleLog(state, { level: 'error', message: `msg-${i}`, timestamp: i }, 3);
    }
    expect(state.consoleLogs).toHaveLength(3);
    expect(state.consoleLogs[2].message).toBe('msg-2');
  });
});

describe('flushConsoleLogs', () => {
  it('returns collected logs and resets buffer', () => {
    const state = createState();
    pushConsoleLog(state, { level: 'error', message: 'a', timestamp: 1 }, 50);
    pushConsoleLog(state, { level: 'warn', message: 'b', timestamp: 2 }, 50);

    const flushed = flushConsoleLogs(state);
    expect(flushed).toHaveLength(2);
    expect(flushed[0].message).toBe('a');
    expect(flushed[1].message).toBe('b');
    expect(state.consoleLogs).toHaveLength(0);
  });

  it('returns empty array when buffer is empty', () => {
    const state = createState();
    const flushed = flushConsoleLogs(state);
    expect(flushed).toEqual([]);
  });
});

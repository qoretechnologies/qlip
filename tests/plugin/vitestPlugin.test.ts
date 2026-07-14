/**
 * Regression tests for qlip#17 — the plugin's `config` hook must add
 * qlip's own `setupFiles` / `globalSetup` / `reporters` WITHOUT
 * duplicating the consumer's entries.
 *
 * Vite applies a `config` hook by `mergeConfig(userConfig, pluginResult)`,
 * and `mergeConfig` *concatenates* arrays — so any consumer entry the
 * plugin echoes back in its return is added a second time. The confirmed
 * failure was a consumer `setupFiles` running twice, which wedged
 * Storybook browser collection.
 *
 * These tests replicate Vite's real merge and assert that every entry —
 * the consumer's and qlip's — appears in the resolved config exactly
 * once.
 */

import { describe, expect, it } from 'vitest';
import { mergeConfig } from 'vite';
import { qlipVitestPlugin } from '../../src/plugin/vitestPlugin.js';

type TTestConfig = { test?: Record<string, unknown> } & Record<string, unknown>;

/** Invoke the plugin's `config` hook the way Vite does, then merge. */
function resolveWithPlugin(userConfig: TTestConfig): TTestConfig {
  const plugin = qlipVitestPlugin({ buildId: 'test-build' });
  const hook = plugin.config;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) throw new Error('plugin exposes no config hook');
  const result = handler(userConfig as never, {
    command: 'serve',
    mode: 'test',
  } as never) as TTestConfig;
  // Vite: `config = mergeConfig(config, pluginResult)` — user first.
  return mergeConfig(userConfig, result) as TTestConfig;
}

const occurrences = <T>(arr: T[], pred: (v: T) => boolean): number =>
  arr.filter(pred).length;

const QLIP_SETUP = /runtime[\\/]setup\.(ts|js)$/;
const QLIP_GLOBAL_SETUP = /runtime[\\/]global-setup\.(ts|js)$/;
const isQlipReporter = (r: unknown): boolean =>
  typeof r === 'object' &&
  r !== null &&
  (r as { constructor?: { name?: string } }).constructor?.name ===
    'QlipUploadReporter';

describe('qlipVitestPlugin config hook — no duplicate merge (qlip#17)', () => {
  it('appends its setup file without duplicating a single consumer entry', () => {
    const merged = resolveWithPlugin({
      test: { setupFiles: ['.storybook/vitest.setup.ts'] },
    });
    const setupFiles = merged.test?.setupFiles as string[];
    expect(
      occurrences(setupFiles, (f) => f === '.storybook/vitest.setup.ts'),
    ).toBe(1);
    expect(occurrences(setupFiles, (f) => QLIP_SETUP.test(f))).toBe(1);
  });

  it('preserves multiple consumer setup files, each exactly once', () => {
    const merged = resolveWithPlugin({
      test: { setupFiles: ['a.setup.ts', 'b.setup.ts'] },
    });
    const setupFiles = merged.test?.setupFiles as string[];
    expect(occurrences(setupFiles, (f) => f === 'a.setup.ts')).toBe(1);
    expect(occurrences(setupFiles, (f) => f === 'b.setup.ts')).toBe(1);
    expect(occurrences(setupFiles, (f) => QLIP_SETUP.test(f))).toBe(1);
  });

  it('adds its setup file when the consumer declared none', () => {
    const merged = resolveWithPlugin({ test: {} });
    const setupFiles = merged.test?.setupFiles as string[];
    expect(occurrences(setupFiles, (f) => QLIP_SETUP.test(f))).toBe(1);
    expect(setupFiles).toHaveLength(1);
  });

  it('does not duplicate a string consumer globalSetup', () => {
    const merged = resolveWithPlugin({
      test: { globalSetup: 'my.global-setup.ts' },
    });
    const globalSetup = merged.test?.globalSetup as string[];
    expect(occurrences(globalSetup, (f) => f === 'my.global-setup.ts')).toBe(1);
    expect(occurrences(globalSetup, (f) => QLIP_GLOBAL_SETUP.test(f))).toBe(1);
  });

  it('does not duplicate an array consumer globalSetup', () => {
    const merged = resolveWithPlugin({
      test: { globalSetup: ['gs-a.ts', 'gs-b.ts'] },
    });
    const globalSetup = merged.test?.globalSetup as string[];
    expect(occurrences(globalSetup, (f) => f === 'gs-a.ts')).toBe(1);
    expect(occurrences(globalSetup, (f) => f === 'gs-b.ts')).toBe(1);
    expect(occurrences(globalSetup, (f) => QLIP_GLOBAL_SETUP.test(f))).toBe(1);
  });

  it('keeps a consumer string reporter once and adds qlip once', () => {
    const merged = resolveWithPlugin({ test: { reporters: ['default'] } });
    const reporters = merged.test?.reporters as unknown[];
    expect(occurrences(reporters, (r) => r === 'default')).toBe(1);
    expect(occurrences(reporters, isQlipReporter)).toBe(1);
  });

  it('keeps a consumer tuple reporter intact and once', () => {
    const merged = resolveWithPlugin({
      test: { reporters: [['junit', { outputFile: 'out.xml' }]] },
    });
    const reporters = merged.test?.reporters as unknown[];
    expect(
      occurrences(reporters, (r) => Array.isArray(r) && r[0] === 'junit'),
    ).toBe(1);
    expect(occurrences(reporters, isQlipReporter)).toBe(1);
  });

  it("re-adds 'default' so a consumer with no reporters isn't silenced", () => {
    const merged = resolveWithPlugin({ test: {} });
    const reporters = merged.test?.reporters as unknown[];
    expect(occurrences(reporters, (r) => r === 'default')).toBe(1);
    expect(occurrences(reporters, isQlipReporter)).toBe(1);
  });
});

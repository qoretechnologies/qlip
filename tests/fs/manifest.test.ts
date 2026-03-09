import { describe, expect, it } from 'vitest';
import { createManifest } from '../../src/fs/output.js';

describe('createManifest', () => {
  it('creates a manifest with defaults and stats', () => {
    const manifest = createManifest({
      buildId: '20250102-030405',
      outputDir: '/tmp/qlip/20250102-030405',
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
      tool: { name: 'qlip', version: '0.1.0' },
      createdAt: new Date('2025-01-02T03:04:05.000Z'),
    });

    expect(manifest.tool.name).toBe('qlip');
    expect(manifest.buildId).toBe('20250102-030405');
    expect(manifest.outputDir).toBe('/tmp/qlip/20250102-030405');
    expect(manifest.stats).toEqual({
      storiesTotal: 0,
      capturedAuto: 0,
      capturedManual: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    });
  });
});

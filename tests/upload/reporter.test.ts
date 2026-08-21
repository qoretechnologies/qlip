/**
 * Unit tests for `QlipUploadReporter`'s census duties.
 *
 * The reporter is the only component that sees what Vitest ran, and it
 * has to work across two lifecycles: `onTestModuleEnd` per file on
 * Vitest 3+/4, `onFinished(files)` at end-of-run on Vitest 2. Both are
 * duck-typed, so a shape regression would otherwise surface as a
 * silently empty census.
 *
 * The merge these hooks trigger is a no-op here — the runtime points
 * at a directory with no fragments, so `finalizeBuild` returns early.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { QlipUploadReporter } from '../../src/upload/reporter.js';
import {
  readStoryCensus,
  resetStoryCensus,
} from '../../src/upload/census.js';
import type { QlipRuntimeConfig } from '../../src/types.js';

let buildDir: string;

const resetFinalizeFlag = (): void => {
  const flag = Symbol.for('@qoretechnologies/qlip/__finalized__');
  delete (globalThis as Record<symbol, boolean | undefined>)[flag];
};

const runtime = (): QlipRuntimeConfig => ({
  buildId: 'build-1',
  outputDir: buildDir,
  buildDir,
  defaults: {} as never,
  tool: { name: 'qlip', version: '0.1.0' },
});

beforeEach(async () => {
  resetStoryCensus();
  resetFinalizeFlag();
  buildDir = await mkdtemp(path.join(tmpdir(), 'qlip-reporter-test-'));
});

afterEach(async () => {
  resetStoryCensus();
  resetFinalizeFlag();
  await rm(buildDir, { recursive: true, force: true });
});

describe('QlipUploadReporter', () => {
  it('records a module census as each story file finishes (Vitest 3+/4)', async () => {
    const reporter = new QlipUploadReporter({ runtime: runtime() });

    reporter.onTestModuleEnd({
      moduleId: '/src/Button.stories.ts',
      children: {
        allTests: () => [
          { meta: () => ({ storyId: 'button--primary' }) },
          { meta: () => ({ storyId: 'button--ghost' }) },
        ],
      },
    });

    // Recorded DURING the run: the globalSetup teardown can finalize
    // the build before any end-of-run reporter hook fires, and a
    // census that lands after the merge is a census nobody reads.
    expect(readStoryCensus()?.byModule).toEqual({
      '/src/Button.stories.ts': ['button--primary', 'button--ghost'],
    });

    await reporter.onTestRunEnd();
  });

  it('records the census from the end-of-run files array (Vitest 2)', async () => {
    const reporter = new QlipUploadReporter({ runtime: runtime() });

    await reporter.onFinished([
      {
        filepath: '/src/Page.stories.tsx',
        tasks: [
          {
            type: 'suite',
            tasks: [
              { type: 'test', meta: { storyId: 'page--home' } },
              { type: 'test', meta: { storyId: 'page--about' } },
            ],
          },
        ],
      },
    ]);

    expect(readStoryCensus()?.byModule).toEqual({
      '/src/Page.stories.tsx': ['page--home', 'page--about'],
    });
  });

  it('finalizes without a census when Vitest passes no files', async () => {
    const reporter = new QlipUploadReporter({ runtime: runtime() });

    await expect(reporter.onFinished()).resolves.toBeUndefined();
    expect(readStoryCensus()).toBeUndefined();
  });
});

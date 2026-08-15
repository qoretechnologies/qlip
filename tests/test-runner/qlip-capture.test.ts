/**
 * Unit tests for `qlipCapture` — the postVisit-compatible function
 * the test-runner library exposes. Uses a stub `Page` that records
 * what would have happened (viewport set, evaluate calls,
 * screenshot path) without needing a real Playwright instance.
 *
 * The test-runner library is the dominant code path for
 * qorus-ide-class consumers, so this suite covers:
 *  - happy-path capture (viewport, prep, screenshot, manifest entry)
 *  - skip path (parameters.qlip.skip → entry with status='skipped',
 *    no page interaction)
 *  - parameters override defaults (story-level wins)
 *  - error path (screenshot throws → entry with status='failed')
 *  - mask cleanup (masks get torn down even when capture fails)
 *  - manifest stats update correctly
 *  - store reuses across calls (one buildId per process)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { qlipCapture } from '../../src/test-runner/index.js';
import { peekStore, resetStore } from '../../src/test-runner/manifest-store.js';
import { MANIFEST_FRAGMENT_DIR } from '../../src/fs/output.js';
import type { QlipManifestFragment } from '../../src/types.js';
import type { QlipParameters } from '../../src/types.js';

interface RecordedEvaluate {
  fnSource: string;
  arg: unknown;
}

interface StubPage {
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
  evaluate: <T, R>(
    fn: (arg: T) => R | Promise<R>,
    arg: T,
  ) => Promise<R>;
  screenshot: (opts: {
    path?: string;
    fullPage?: boolean;
    type?: 'png' | 'jpeg';
  }) => Promise<Buffer>;
  /** Spies the tests assert on. */
  $viewports: Array<{ width: number; height: number }>;
  $evaluates: RecordedEvaluate[];
  $screenshots: Array<{ path?: string; type?: string }>;
  /** Toggles to drive failure paths. */
  $screenshotShouldThrow?: Error;
  /** Stub return for the mask-application evaluate call. */
  $maskIds?: string[];
}

const makeStubPage = (
  overrides: Partial<StubPage> = {},
): StubPage => {
  const page: StubPage = {
    $viewports: [],
    $evaluates: [],
    $screenshots: [],
    setViewportSize: vi.fn((size: { width: number; height: number }) => {
      page.$viewports.push(size);
      return Promise.resolve();
    }),
    evaluate: vi.fn(
      <T, R>(fn: (arg: T) => R | Promise<R>, arg: T): Promise<R> => {
        page.$evaluates.push({ fnSource: fn.toString(), arg });
        // If the call is the mask-applier, return the stub mask IDs
        // so removeIgnoreMasksInPage gets called with them.
        if (fn.toString().includes('mask')) {
          return Promise.resolve((page.$maskIds ?? []) as unknown as R);
        }
        return Promise.resolve(undefined as unknown as R);
      },
    ),
    screenshot: vi.fn((opts: { path?: string; type?: string }) => {
      page.$screenshots.push({
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        ...(opts.type !== undefined ? { type: opts.type } : {}),
      });
      if (page.$screenshotShouldThrow) {
        return Promise.reject(page.$screenshotShouldThrow);
      }
      return Promise.resolve(Buffer.from(''));
    }),
    ...overrides,
  };
  return page;
};

let tmpRoot: string;

beforeEach(async () => {
  resetStore();
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'qlip-tr-'));
  // Force every test into its own isolated outputDir so they
  // don't share build state.
  process.env['QLIP_OUTPUT_DIR'] = tmpRoot;
  delete process.env['QLIP_BUILD_ID'];
});

afterEach(async () => {
  delete process.env['QLIP_OUTPUT_DIR'];
  delete process.env['QLIP_BUILD_ID'];
  resetStore();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('qlipCapture (happy path)', () => {
  it('sets viewport, applies prep, screenshots, and records a captured entry', async () => {
    const page = makeStubPage();
    const entry = await qlipCapture(page, {
      id: 'button--primary',
      title: 'Button',
      name: 'Primary',
    });

    expect(entry).not.toBeNull();
    expect(entry?.status).toBe('captured');
    expect(entry?.kind).toBe('auto');
    expect(entry?.storyId).toBe('button--primary');
    expect(entry?.storyTitle).toBe('Button');
    expect(entry?.storyName).toBe('Primary');
    expect(entry?.path).toBe('stories/auto/Button--Primary.png');
    expect(entry?.viewport).toEqual({ width: 1280, height: 720 });

    expect(page.$viewports).toEqual([{ width: 1280, height: 720 }]);
    expect(page.$screenshots).toHaveLength(1);
    expect(page.$screenshots[0].path).toContain(
      'stories/auto/Button--Primary.png',
    );
    expect(page.$screenshots[0].type).toBe('png');

    // Two evaluates: animation control + idle wait. No mask call
    // because ignoreElements is empty by default.
    expect(page.$evaluates).toHaveLength(2);
    expect(page.$evaluates[0].fnSource).toContain('animation');
    expect(page.$evaluates[1].fnSource).toContain('MutationObserver');
  });

  it('updates manifest stats: capturedAuto + storiesTotal both increment', async () => {
    const page = makeStubPage();
    await qlipCapture(page, { id: 'a--b' });
    await qlipCapture(page, { id: 'c--d' });

    const store = peekStore();
    expect(store).toBeDefined();
    expect(store?.manifest.stats.capturedAuto).toBe(2);
    expect(store?.manifest.stats.storiesTotal).toBe(2);
    expect(store?.manifest.stats.skipped).toBe(0);
    expect(store?.manifest.stats.failed).toBe(0);
    expect(store?.manifest.entries).toHaveLength(2);
  });
});

describe('qlipCapture (story parameters)', () => {
  it('skips capture entirely when parameters.qlip.skip is true', async () => {
    const page = makeStubPage();
    const getStoryContext = vi.fn(() => Promise.resolve({
      parameters: { qlip: { skip: true } as QlipParameters },
    }));

    const entry = await qlipCapture(
      page,
      { id: 'skipped--story' },
      { getStoryContext },
    );

    expect(entry?.status).toBe('skipped');
    expect(page.$viewports).toEqual([]);
    expect(page.$screenshots).toEqual([]);

    const store = peekStore();
    expect(store?.manifest.stats.skipped).toBe(1);
    expect(store?.manifest.stats.capturedAuto).toBe(0);
  });

  it('applies a story-level viewport override', async () => {
    const page = makeStubPage();
    const getStoryContext = vi.fn(() => Promise.resolve({
      parameters: {
        qlip: { viewport: { width: 320, height: 568 } } as QlipParameters,
      },
    }));

    await qlipCapture(page, { id: 'mobile--story' }, { getStoryContext });

    expect(page.$viewports).toEqual([{ width: 320, height: 568 }]);
  });

  it('falls back to defaults when getStoryContext throws', async () => {
    const page = makeStubPage();
    const getStoryContext = vi.fn(() =>
      Promise.reject(new Error('page navigated away')),
    );

    const entry = await qlipCapture(
      page,
      { id: 'errored-ctx--story' },
      { getStoryContext },
    );

    // Capture still happens with defaults.
    expect(entry?.status).toBe('captured');
    expect(page.$viewports).toEqual([{ width: 1280, height: 720 }]);
  });

  it('applies ignore-element masks before screenshot and cleans them up after', async () => {
    const page = makeStubPage({ $maskIds: ['mask-1', 'mask-2'] });
    const getStoryContext = vi.fn(() => Promise.resolve({
      parameters: {
        qlip: { ignoreElements: ['.timestamp'] } as QlipParameters,
      },
    }));

    await qlipCapture(page, { id: 'masked--story' }, { getStoryContext });

    // 4 evaluates: animation, idle, mask-apply, mask-remove
    expect(page.$evaluates).toHaveLength(4);
    const fnSources = page.$evaluates.map((e) => e.fnSource);
    expect(fnSources.some((s) => s.includes('ignore') || s.includes('mask'))).toBe(
      true,
    );
    // The remove call received the mask IDs returned by the apply call.
    const removeCall = page.$evaluates[3];
    expect((removeCall.arg as { ids: string[] }).ids).toEqual([
      'mask-1',
      'mask-2',
    ]);
  });
});

describe('qlipCapture (failure path)', () => {
  it('records a failed entry when screenshot throws, but still cleans up masks', async () => {
    const page = makeStubPage({
      $maskIds: ['mask-1'],
      $screenshotShouldThrow: new Error('chromium crashed'),
    });
    const getStoryContext = vi.fn(() => Promise.resolve({
      parameters: {
        qlip: { ignoreElements: ['.dynamic'] } as QlipParameters,
      },
    }));

    const entry = await qlipCapture(
      page,
      { id: 'flaky--story' },
      { getStoryContext },
    );

    expect(entry?.status).toBe('failed');
    expect(entry?.error?.message).toBe('chromium crashed');

    // The mask-remove evaluate fires even though screenshot failed.
    const removeEvaluate = page.$evaluates.find((e) =>
      e.fnSource.includes('removeIgnoreMasksInPage')
        ? true
        : (e.arg as { ids?: string[] }).ids !== undefined,
    );
    expect(removeEvaluate).toBeDefined();

    const store = peekStore();
    expect(store?.manifest.stats.failed).toBe(1);
    expect(store?.manifest.stats.capturedAuto).toBe(0);
  });
});

describe('qlipCapture (process-wide state)', () => {
  it('reuses the same store + buildId across multiple calls', async () => {
    const page = makeStubPage();
    await qlipCapture(page, { id: 'first--story' });
    const buildIdAfterFirst = peekStore()?.buildId;
    await qlipCapture(page, { id: 'second--story' });
    const buildIdAfterSecond = peekStore()?.buildId;

    expect(buildIdAfterFirst).toBe(buildIdAfterSecond);
    expect(peekStore()?.manifest.entries).toHaveLength(2);
  });

  it('honours QLIP_BUILD_ID env var so sharded CI can share a build', async () => {
    process.env['QLIP_BUILD_ID'] = '20990101-000000';
    const page = makeStubPage();
    await qlipCapture(page, { id: 'sharded--story' });
    expect(peekStore()?.buildId).toBe('20990101-000000');
  });

  it('writes one fragment file per capture, never rewriting one', async () => {
    // Same append-only contract as the Vitest path (issues #25/#26):
    // sharded runners share a build dir, so no writer may ever revisit
    // a file another writer might also be holding.
    const page = makeStubPage();
    await qlipCapture(page, { id: 'first--story' });
    await qlipCapture(page, { id: 'second--story' });

    const store = peekStore();
    const fragmentsDir = path.join(
      store?.buildDir ?? '',
      MANIFEST_FRAGMENT_DIR,
    );
    const files = (await readdir(fragmentsDir)).sort();
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.startsWith(`${store?.fragmentId ?? ''}-`)).toBe(true);
    }

    const fragments = await Promise.all(
      files.map(async (file) =>
        JSON.parse(
          await readFile(path.join(fragmentsDir, file), 'utf-8'),
        ) as QlipManifestFragment,
      ),
    );
    expect(fragments.map((f) => f.entries.map((e) => e.storyId))).toEqual([
      ['first--story'],
      ['second--story'],
    ]);
    expect(fragments.map((f) => f.fragmentSeq)).toEqual([1, 2]);
  });
});

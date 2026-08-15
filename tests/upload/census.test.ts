/**
 * Unit tests for the story census — the only witness to a story that
 * ran and captured nothing at all (no entry, no PNG, nothing on disk
 * to notice).
 *
 * The two task-tree shapes below are the real ones: Vitest 3+/4 hands
 * a reporter a `TestModule` whose `meta()` is a method, Vitest 2 hands
 * it plain `File` objects whose `meta` is a property. Shapes verified
 * against Vitest 4 with a probe reporter (see
 * `.tasks/FRAGMENT_WRITE_RACE.md` phase 4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  censusStoryIds,
  readStoryCensus,
  recordStoryTests,
  recordStoryTestsFromFiles,
  recordStoryTestsFromModule,
  resetStoryCensus,
} from '../../src/upload/census.js';

/** Vitest 3+/4 `TestModule` as delivered to `onTestModuleEnd`. */
const v4Module = (moduleId: string, storyIds: (string | undefined)[]) => ({
  moduleId,
  children: {
    allTests: () =>
      storyIds.map((storyId) => ({
        meta: () => (storyId === undefined ? {} : { storyId }),
      })),
  },
});

/** Vitest 2 `File` as delivered to `onFinished`. */
const v2File = (filepath: string, storyIds: (string | undefined)[]) => ({
  filepath,
  tasks: [
    {
      // Storybook nests each story test inside a suite named for the
      // component, so the walker has to recurse.
      type: 'suite',
      tasks: storyIds.map((storyId) => ({
        type: 'test',
        meta: storyId === undefined ? {} : { storyId },
      })),
    },
  ],
});

beforeEach(() => {
  resetStoryCensus();
});

afterEach(() => {
  resetStoryCensus();
});

describe('story census', () => {
  it('has no census until something is recorded', () => {
    expect(readStoryCensus()).toBeUndefined();
  });

  it('records story ids from a Vitest 4 test module', () => {
    recordStoryTestsFromModule(
      v4Module('/src/Button.stories.ts', [
        'example-button--primary',
        'example-button--large',
      ]),
    );

    expect(readStoryCensus()?.byModule).toEqual({
      '/src/Button.stories.ts': [
        'example-button--primary',
        'example-button--large',
      ],
    });
  });

  it('records story ids from a Vitest 2 files array, recursing suites', () => {
    recordStoryTestsFromFiles([
      v2File('/src/Button.stories.ts', ['example-button--primary']),
      v2File('/src/Page.stories.tsx', [
        'example-page--logged-in',
        'example-page--logged-out',
      ]),
    ]);

    expect(readStoryCensus()?.byModule).toEqual({
      '/src/Button.stories.ts': ['example-button--primary'],
      '/src/Page.stories.tsx': [
        'example-page--logged-in',
        'example-page--logged-out',
      ],
    });
  });

  it('ignores tests that carry no storyId', () => {
    // A consumer's ordinary browser tests share the project with the
    // stories; counting them would report captures as missing that
    // were never meant to happen.
    recordStoryTestsFromModule(
      v4Module('/src/mixed.test.ts', [undefined, 'a--story', undefined]),
    );

    expect(readStoryCensus()?.byModule).toEqual({
      '/src/mixed.test.ts': ['a--story'],
    });
  });

  it('unions repeated reports of one module instead of duplicating', () => {
    // Retries and watch reruns report a module more than once.
    recordStoryTests('/src/Button.stories.ts', ['a--one']);
    recordStoryTests('/src/Button.stories.ts', ['a--one', 'a--two']);

    expect(readStoryCensus()?.byModule['/src/Button.stories.ts']).toEqual([
      'a--one',
      'a--two',
    ]);
  });

  it('survives shapes it does not understand without recording anything', () => {
    // This runs inside a reporter hook: a throw here would break a
    // test run that is otherwise fine, and a wrong guess must degrade
    // to "no census" rather than "everything is missing".
    expect(() => {
      recordStoryTestsFromModule(undefined);
      recordStoryTestsFromModule({ moduleId: 42 });
      recordStoryTestsFromModule({ children: { allTests: 'not-a-function' } });
      recordStoryTestsFromFiles(undefined);
      recordStoryTestsFromFiles('nonsense');
      recordStoryTestsFromFiles([{ filepath: '/x', tasks: 'not-an-array' }]);
    }).not.toThrow();
    expect(readStoryCensus()).toBeUndefined();
  });

  it('collects every story id across modules', () => {
    recordStoryTests('/a.stories.ts', ['a--one', 'a--two']);
    recordStoryTests('/b.stories.ts', ['b--one']);

    const census = readStoryCensus();
    expect(census).toBeDefined();
    expect([...censusStoryIds(census!)].sort()).toEqual([
      'a--one',
      'a--two',
      'b--one',
    ]);
  });
});

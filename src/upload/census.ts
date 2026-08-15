/**
 * What Vitest actually ran, so the build can say what it failed to
 * capture.
 *
 * Every other signal qlip has is derived from captures that happened.
 * A story that runs and produces no capture at all leaves nothing
 * behind — no entry, no PNG, no fragment — so it is invisible to the
 * manifest and to the orphan check in `capture-report.ts`. The test
 * runner is the only witness.
 *
 * Storybook's addon-vitest stamps `storyId` onto each test's task
 * meta, which reporters can read, so the census records story ids
 * rather than counts: the run can then name the stories that went
 * missing instead of reporting a number nobody can act on.
 *
 * Collected during the run (per module, as each file finishes) rather
 * than at the end, because the reporter and the globalSetup teardown
 * race to finalize a build and either can win — see
 * `src/upload/finalize.ts`. Stashed on `globalThis` under a
 * `Symbol.for` key, the same way the finalize config is, so whichever
 * path wins reads the same census.
 *
 * ONLY the Vitest capture path feeds this. The test-runner path drives
 * stories from a Storybook index it walks itself, so a missing story
 * there is a missing visit, not a missing capture.
 */

const CENSUS_KEY = Symbol.for('@qoretechnologies/qlip/__story_census__');

export interface IQlipStoryCensus {
  /** Story ids that ran, keyed by the module (story file) running them. */
  byModule: Record<string, string[]>;
}

interface CensusHolder {
  [CENSUS_KEY]?: IQlipStoryCensus;
}

const holder = (): CensusHolder => globalThis as CensusHolder;

export const readStoryCensus = (): IQlipStoryCensus | undefined =>
  holder()[CENSUS_KEY];

export const resetStoryCensus = (): void => {
  delete holder()[CENSUS_KEY];
};

/**
 * Record the story ids one module ran. Idempotent per module: Vitest
 * can report a module more than once (retries, watch reruns), and the
 * union is what we want either way.
 */
export const recordStoryTests = (
  moduleId: string,
  storyIds: string[],
): void => {
  if (storyIds.length === 0) return;
  const census = holder()[CENSUS_KEY] ?? { byModule: {} };
  const existing = census.byModule[moduleId] ?? [];
  census.byModule[moduleId] = [...new Set([...existing, ...storyIds])];
  holder()[CENSUS_KEY] = census;
};

/** Every story id the run executed, across modules. */
export const censusStoryIds = (census: IQlipStoryCensus): Set<string> => {
  const ids = new Set<string>();
  for (const storyIds of Object.values(census.byModule)) {
    for (const id of storyIds) ids.add(id);
  }
  return ids;
};

/**
 * Pull `meta.storyId` off whatever shape the running Vitest hands a
 * reporter. Two are supported and they are structurally different:
 *
 * - Vitest 3+/4 `onTestModuleEnd(testModule)` — `TestModule` with
 *   `children.allTests()` yielding `TestCase`s whose `meta()` is a
 *   method.
 * - Vitest 2 `onFinished(files)` — plain `File` objects with a nested
 *   `tasks` array and `meta` as a property.
 *
 * Duck-typed rather than version-sniffed, and every access is
 * defensive: this runs inside a reporter hook, where a throw would
 * take down a test run that is otherwise fine. An unknown shape
 * yields nothing, which degrades to "no census" — silence, not a
 * false alarm.
 */
const storyIdOf = (task: unknown): string | undefined => {
  const meta = (task as { meta?: unknown }).meta;
  const resolved =
    typeof meta === 'function'
      ? (meta as () => unknown).call(task)
      : meta;
  const storyId = (resolved as { storyId?: unknown } | undefined)?.storyId;
  return typeof storyId === 'string' && storyId.length > 0
    ? storyId
    : undefined;
};

interface IVitestTaskLike {
  type?: string;
  tasks?: unknown[];
}

const collectFromTasks = (tasks: unknown[], into: string[]): void => {
  for (const task of tasks) {
    const node = task as IVitestTaskLike;
    if (Array.isArray(node.tasks)) {
      collectFromTasks(node.tasks, into);
      continue;
    }
    const storyId = storyIdOf(task);
    if (storyId) into.push(storyId);
  }
};

/** Vitest 3+/4: one `TestModule` as delivered to `onTestModuleEnd`. */
export const recordStoryTestsFromModule = (testModule: unknown): void => {
  try {
    const mod = testModule as {
      moduleId?: unknown;
      children?: { allTests?: () => Iterable<unknown> };
    };
    const allTests = mod.children?.allTests;
    if (typeof allTests !== 'function') return;
    const storyIds: string[] = [];
    for (const test of allTests.call(mod.children)) {
      const storyId = storyIdOf(test);
      if (storyId) storyIds.push(storyId);
    }
    recordStoryTests(
      typeof mod.moduleId === 'string' ? mod.moduleId : '<unknown>',
      storyIds,
    );
  } catch {
    // See JSDoc — a reporter hook must never break the run.
  }
};

/** Vitest 2: the `files` array delivered to `onFinished`. */
export const recordStoryTestsFromFiles = (files: unknown): void => {
  if (!Array.isArray(files)) return;
  try {
    for (const file of files) {
      const node = file as { filepath?: unknown; tasks?: unknown };
      if (!Array.isArray(node.tasks)) continue;
      const storyIds: string[] = [];
      collectFromTasks(node.tasks, storyIds);
      recordStoryTests(
        typeof node.filepath === 'string' ? node.filepath : '<unknown>',
        storyIds,
      );
    }
  } catch {
    // See JSDoc.
  }
};

/**
 * In-process manifest accumulator for the test-runner capture path.
 *
 * The Vitest plugin path runs every `*.stories.tsx` in its own
 * browser context (fresh module graph) and uses per-context manifest
 * fragments merged at end-of-run. test-runner is fundamentally
 * different: one Node process, one Jest worker (or N with sharding),
 * one Playwright page navigated through every story. There's no
 * cross-context drift to merge — a single accumulator captures
 * every entry.
 *
 * The store still writes ONE fragment file (under the same
 * `manifest-fragments/` directory the Vitest path uses) at
 * end-of-run, so the existing `mergeManifestFragments()` helper in
 * `src/upload/manifest.ts` can be the single chokepoint for both
 * paths. The merger sees one fragment instead of N — same code
 * path, simpler input.
 *
 * State lives on `globalThis` via a `Symbol.for(...)` key so:
 *   - the `qlipCapture` library function (called from postVisit)
 *     can stash entries
 *   - the globalSetup teardown (R-2) can read them out to flush
 *     to disk before triggering upload
 * Both run in the same Node process, so global state is the
 * simplest correct mechanism.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  QlipManifest,
  QlipManifestEntry,
  QlipResolvedDefaults,
} from '../types.js';
import {
  MANIFEST_FRAGMENT_DIR,
  TOOL_NAME,
  createManifest,
} from '../fs/output.js';

const STORE_KEY = Symbol.for('@qoretechnologies/qlip/__test_runner_store__');

export interface IQlipTestRunnerStore {
  /** Resolved build directory: `<outputDir>/<buildId>`. */
  buildDir: string;
  /** Build ID — either generated or read from `QLIP_BUILD_ID`. */
  buildId: string;
  /** Absolute path to outputDir (root that contains build folders). */
  outputDir: string;
  /** Accumulator. Entries are appended in capture order. */
  manifest: QlipManifest;
  /** Per-story step counters for manual screenshot naming. */
  counters: Map<string, number>;
  /** ms-since-epoch at first capture, for `durationMs`. */
  startedAt: number;
  /**
   * Per-process fragment ID. Each Jest worker / test-runner shard
   * gets its own fragment file under `manifest-fragments/`. Lines
   * up with the Vitest plugin path's fragment-per-browser-context
   * model so `mergeManifestFragments()` (in `src/upload/manifest.ts`)
   * works identically across both capture paths.
   *
   * Random + timestamp keeps it unique across parallel workers
   * without coordination.
   */
  fragmentId: string;
}

interface StoreHolder {
  [STORE_KEY]?: IQlipTestRunnerStore;
}

const holder = (): StoreHolder => globalThis as StoreHolder;

/**
 * Get-or-initialise the per-process store. Idempotent; safe to
 * call from every `postVisit` invocation.
 */
export const getOrInitStore = (init: {
  buildId: string;
  outputDir: string;
  buildDir: string;
  defaults: QlipResolvedDefaults;
  toolVersion: string;
}): IQlipTestRunnerStore => {
  const existing = holder()[STORE_KEY];
  if (existing) return existing;

  // Fragment ID: time prefix (collisions ~impossible) + random
  // suffix (paranoia against same-ms launches). Lifted from the
  // Vitest runtime's identical scheme so the merger sees one
  // consistent naming pattern.
  const fragmentId = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const store: IQlipTestRunnerStore = {
    buildId: init.buildId,
    outputDir: init.outputDir,
    buildDir: init.buildDir,
    manifest: createManifest({
      buildId: init.buildId,
      outputDir: init.buildDir,
      defaults: init.defaults,
      tool: { name: TOOL_NAME, version: init.toolVersion },
    }),
    counters: new Map(),
    startedAt: Date.now(),
    fragmentId,
  };
  holder()[STORE_KEY] = store;
  return store;
};

/**
 * Write the current store's full manifest to its fragment file on
 * disk. Called after every capture so the qlip-upload CLI (a
 * separate process) can read the latest state at end-of-run.
 *
 * Cheap: ~5 KB JSON written per capture, well within macOS/Linux
 * filesystem cache. We overwrite each call rather than appending —
 * the file's contents always reflect THIS process's full
 * accumulated manifest.
 */
export const flushFragmentToDisk = async (
  store: IQlipTestRunnerStore,
): Promise<void> => {
  const fragmentPath = path.join(
    store.buildDir,
    MANIFEST_FRAGMENT_DIR,
    `${store.fragmentId}.json`,
  );
  await fs.writeFile(
    fragmentPath,
    JSON.stringify(store.manifest, null, 2),
    'utf-8',
  );
};

/**
 * Read the current store. Returns `undefined` if `qlipCapture` was
 * never invoked (e.g. globalSetup teardown firing on a run with no
 * stories).
 */
export const peekStore = (): IQlipTestRunnerStore | undefined => {
  return holder()[STORE_KEY];
};

/** Clear the store. Used by tests + at end of teardown if desired. */
export const resetStore = (): void => {
  holder()[STORE_KEY] = undefined;
};

/** Append an entry + bump the matching stats counter. */
export const pushEntry = (
  store: IQlipTestRunnerStore,
  entry: QlipManifestEntry,
): void => {
  store.manifest.entries.push(entry);
  const stats = store.manifest.stats;
  if (entry.status === 'captured') {
    if (entry.kind === 'auto') stats.capturedAuto += 1;
    else stats.capturedManual += 1;
  } else if (entry.status === 'skipped') {
    stats.skipped += 1;
  } else if (entry.status === 'failed') {
    stats.failed += 1;
  }
  if (entry.kind === 'auto') stats.storiesTotal += 1;
  stats.durationMs = Date.now() - store.startedAt;
};

/** Increment + return next step counter for manual captures. */
export const nextStepName = (
  store: IQlipTestRunnerStore,
  storyId: string,
): string => {
  const current = store.counters.get(storyId) ?? 0;
  const next = current + 1;
  store.counters.set(storyId, next);
  return `step-${String(next)}`;
};

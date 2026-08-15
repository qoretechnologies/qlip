import {
  QlipConsoleMessage,
  QlipManifest,
  QlipManifestEntry,
  QlipRuntimeConfig,
} from '../types.js';
import { createManifest } from '../fs/output.js';
import { monotonicNow, realDateNow } from './clock.js';

export interface QlipRuntimeState {
  config: QlipRuntimeConfig;
  manifest: QlipManifest;
  counters: Map<string, number>;
  startedAt: number;
  warnedMissingStorybook: boolean;
  consoleLogs: QlipConsoleMessage[];
  /**
   * Identifies this browser context in the fragment file names it
   * writes under `<buildDir>/manifest-fragments/`. Paired with
   * `fragmentSeq` it makes every capture's file name unique, which is
   * what lets fragments be append-only. See `src/upload/manifest.ts`
   * for the Node-side merge.
   */
  fragmentId: string;
  /**
   * Captures written by this context so far. Incremented per fragment
   * write; never reused, so no fragment file is ever written twice.
   */
  fragmentSeq: number;
}

const GLOBAL_KEY = '__QLIP_RUNTIME__';

declare const __QLIP_CONFIG__: QlipRuntimeConfig | undefined;

const readConfig = (): QlipRuntimeConfig | undefined => {
  const globalValue = (globalThis as { __QLIP_CONFIG__?: QlipRuntimeConfig })
    .__QLIP_CONFIG__;
  if (globalValue) {
    return globalValue;
  }
  if (typeof __QLIP_CONFIG__ === 'undefined') {
    return undefined;
  }
  if (typeof __QLIP_CONFIG__ === 'string') {
    try {
      return JSON.parse(__QLIP_CONFIG__) as QlipRuntimeConfig;
    } catch {
      return undefined;
    }
  }
  return __QLIP_CONFIG__;
};

export const getRuntimeState = (): QlipRuntimeState | null => {
  const globalState = globalThis as {
    [GLOBAL_KEY]?: QlipRuntimeState;
  };
  return globalState[GLOBAL_KEY] ?? null;
};

export const initRuntimeState = (): QlipRuntimeState | null => {
  const existing = getRuntimeState();
  if (existing) {
    return existing;
  }

  const runtimeConfig = readConfig();
  if (!runtimeConfig) {
    return null;
  }

  const manifest = createManifest({
    buildId: runtimeConfig.buildId,
    outputDir: runtimeConfig.buildDir,
    defaults: runtimeConfig.defaults,
    tool: runtimeConfig.tool,
  });

  // Fragment ID needs to be unique per browser context, not unique per
  // build: under `isolate: false` several test files share one context
  // (and one of these states), and several vitest processes can share
  // one build dir. Stamp time + random suffix covers both — Math.random()
  // alone would collide ~1 in 16M; with the millis prefix that risk is
  // gone.
  const fragmentId = `${realDateNow().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const runtime: QlipRuntimeState = {
    config: runtimeConfig,
    manifest,
    counters: new Map(),
    startedAt: monotonicNow(),
    warnedMissingStorybook: false,
    consoleLogs: [],
    fragmentId,
    fragmentSeq: 0,
  };

  const globalState = globalThis as {
    [GLOBAL_KEY]?: QlipRuntimeState;
  };
  globalState[GLOBAL_KEY] = runtime;
  return runtime;
};

export const nextStepName = (
  state: QlipRuntimeState,
  storyId: string,
): string => {
  const current = state.counters.get(storyId) ?? 0;
  const next = current + 1;
  state.counters.set(storyId, next);
  return `step-${next}`;
};

export const pushEntry = (
  state: QlipRuntimeState,
  entry: QlipManifestEntry,
) => {
  state.manifest.entries.push(entry);
};

/**
 * Claim the next fragment sequence number for this context.
 *
 * Synchronous and unshared, so two overlapping captures — the
 * `afterEach` hooks of two test files in one context under
 * `isolate: false` — can never claim the same number, and therefore
 * never write the same fragment file.
 */
export const nextFragmentSeq = (state: QlipRuntimeState): number => {
  state.fragmentSeq += 1;
  return state.fragmentSeq;
};

/**
 * Remove every `error`-kind entry for `storyId` from the in-memory
 * manifest. Returns the removed entries so the caller can delete their
 * on-disk PNG (and log) files.
 *
 * Used by the retry-mask fix in `afterEach`: when a test attempt
 * PASSES after one or more failed attempts (vitest `retry > 0`), the
 * error captures from those earlier attempts were already pushed to
 * the manifest. Left alone, they get uploaded and surface in the
 * review UI as failures even though CI is green — the exact "green
 * CI, red visual" gap Qlip is meant to eliminate. Pruning here keeps
 * the manifest truthful; capture-presence alone is NOT a safe pass
 * signal because Qlip's `auto` capture fires when the DOM settles
 * regardless of whether the play test later fails, so a genuinely
 * failing story also has an auto capture — vitest's own final
 * `task.result.state` is the authoritative signal.
 *
 * Also decrements `stats.failed` by the count pruned so the build's
 * top-line counter matches reality.
 */
export const pruneStaleErrorEntries = (
  state: QlipRuntimeState,
  storyId: string,
): QlipManifestEntry[] => {
  if (!storyId) return [];
  const kept: QlipManifestEntry[] = [];
  const pruned: QlipManifestEntry[] = [];
  for (const entry of state.manifest.entries) {
    if (entry.kind === 'error' && entry.storyId === storyId) {
      pruned.push(entry);
      continue;
    }
    kept.push(entry);
  }
  if (pruned.length) {
    state.manifest.entries = kept;
    state.manifest.stats = {
      ...state.manifest.stats,
      failed: Math.max(0, state.manifest.stats.failed - pruned.length),
    };
  }
  return pruned;
};

export const updateStats = (state: QlipRuntimeState, updates: Partial<QlipManifest['stats']>) => {
  state.manifest.stats = {
    ...state.manifest.stats,
    ...updates,
  };
  state.manifest.stats.durationMs = monotonicNow() - state.startedAt;
};

export const markStorybookWarning = (state: QlipRuntimeState) => {
  state.warnedMissingStorybook = true;
};

export const pushConsoleLog = (
  state: QlipRuntimeState,
  log: QlipConsoleMessage,
  maxLogs: number,
) => {
  if (state.consoleLogs.length < maxLogs) {
    state.consoleLogs.push(log);
  }
};

export const flushConsoleLogs = (
  state: QlipRuntimeState,
): QlipConsoleMessage[] => {
  const logs = state.consoleLogs;
  state.consoleLogs = [];
  return logs;
};

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
   * Unique-per-browser-context identifier used as the fragment
   * filename when writing this context's manifest to
   * `<buildDir>/manifest-fragments/`. Each `*.stories.tsx` runs in
   * its own browser context with its own QlipRuntimeState (initialized
   * here); without a per-context fragment, contexts would overwrite
   * each other's writes to a shared `manifest.json`. See
   * `src/upload/manifest.ts` for the Node-side merge.
   */
  fragmentId: string;
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
  // build. Stamp time + random suffix is plenty (each context is its
  // own process / module graph, so two contexts can't race here).
  // Math.random() alone would collide ~1 in 16M; with the millis
  // prefix that risk is gone.
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

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

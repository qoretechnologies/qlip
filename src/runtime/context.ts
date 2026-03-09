import {
  QlipConsoleMessage,
  QlipManifest,
  QlipManifestEntry,
  QlipRuntimeConfig,
} from '../types.js';
import { createManifest } from '../fs/output.js';

export interface QlipRuntimeState {
  config: QlipRuntimeConfig;
  manifest: QlipManifest;
  counters: Map<string, number>;
  startedAt: number;
  warnedMissingStorybook: boolean;
  consoleLogs: QlipConsoleMessage[];
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

  const runtime: QlipRuntimeState = {
    config: runtimeConfig,
    manifest,
    counters: new Map(),
    startedAt: Date.now(),
    warnedMissingStorybook: false,
    consoleLogs: [],
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
  state.manifest.stats.durationMs = Date.now() - state.startedAt;
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

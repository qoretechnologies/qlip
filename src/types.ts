export interface QlipViewport {
  width: number;
  height: number;
}

export interface QlipCaptureOptions {
  skip?: boolean;
  viewport?: QlipViewport;
  disableAnimations?: boolean;
  pauseAnimationsAtEnd?: boolean;
  waitForIdleMs?: number;
  maxWaitForIdleMs?: number;
  ignoreElements?: string[];
  auto?: boolean;
  manual?: boolean;
  error?: boolean;
  captureConsole?: boolean;
  captureConsoleLevels?: QlipConsoleLevel[];
  maxConsoleLogs?: number;
  consoleLogExcludePatterns?: string[];
}

export interface QlipParameters extends QlipCaptureOptions {
  captureOnError?: boolean;
}

export interface QlipPluginOptions extends QlipCaptureOptions {
  outputDir?: string;
  buildId?: string;
  captureOnError?: boolean;
}

export type QlipResolvedDefaults = Required<QlipCaptureOptions> & {
  outputDir: string;
  captureOnError: boolean;
};

export interface QlipRuntimeConfig {
  buildId: string;
  outputDir: string;
  buildDir: string;
  defaults: QlipResolvedDefaults;
  tool: { name: string; version: string };
}

export interface QlipScreenshotOptions extends QlipCaptureOptions {
  name?: string;
}

export interface QlipStoryContext {
  id?: string;
  title?: string;
  name?: string;
  parameters?: { qlip?: QlipParameters };
}

export type QlipConsoleLevel = 'error' | 'warn';

export interface QlipConsoleMessage {
  level: QlipConsoleLevel;
  message: string;
  timestamp: number;
}

export type QlipEntryKind = 'auto' | 'manual';
export type QlipEntryStatus = 'captured' | 'skipped' | 'failed';

export interface QlipManifestEntry {
  kind: QlipEntryKind;
  storyId: string;
  storyTitle?: string;
  storyName?: string;
  screenshotName: string;
  path: string;
  viewport: QlipViewport;
  status: QlipEntryStatus;
  error: { message: string; stack?: string } | null;
  timings: { ms: number };
  logsPath?: string;
}

export interface QlipManifest {
  tool: { name: string; version: string };
  buildId: string;
  createdAt: string;
  outputDir: string;
  defaults: QlipResolvedDefaults;
  stats: {
    storiesTotal: number;
    capturedAuto: number;
    capturedManual: number;
    skipped: number;
    failed: number;
    durationMs: number;
  };
  entries: QlipManifestEntry[];
}

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

/**
 * Options for uploading a finished build to a qlip-server instance.
 * See `design/UPLOAD.md` for the protocol details.
 */
export interface QlipUploadOptions {
  /** Base URL of the qlip-server (e.g. "http://localhost:3100"). */
  serverUrl: string;
  /**
   * Bearer token, required by the server when UPLOAD_TOKEN is set.
   * Omit for unauthenticated dev servers.
   */
  uploadToken?: string;
  /** Project name to upload under. Defaults to "default". */
  project?: string;
  /**
   * Git branch. Auto-detected from $GITHUB_HEAD_REF, $GITHUB_REF_NAME,
   * or `git rev-parse --abbrev-ref HEAD` when omitted.
   */
  branch?: string;
  /**
   * Git commit SHA. Auto-detected from $GITHUB_SHA or
   * `git rev-parse HEAD` when omitted.
   */
  commit?: string;
  /** Skip upload entirely (handy for local-only runs). */
  disabled?: boolean;
  /**
   * Whether an upload failure should fail the test run.
   * Default: `false` — the run succeeds and the failure is logged.
   * Set to `true` in CI when you want red builds on upload errors.
   */
  failOnUploadError?: boolean;
}

export interface QlipPluginOptions extends QlipCaptureOptions {
  outputDir?: string;
  buildId?: string;
  captureOnError?: boolean;
  /**
   * Upload the finished build to a qlip-server. When unset, no upload
   * happens — the screenshots stay on local disk.
   */
  upload?: QlipUploadOptions;
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

/**
 * Manifest entry kind discriminant.
 *   - `auto`   — post-render screenshot taken in `afterEach` for
 *                every story.
 *   - `manual` — explicit `screenshot()` call inside a `play`
 *                function.
 *   - `error`  — screenshot captured at the moment a test failed.
 *                Always paired with a populated `error.message` on
 *                the same manifest entry; never has a baseline
 *                comparison (the server skips diff for this kind).
 *                See `captureErrorScreenshot` in
 *                `src/runtime/screenshot.ts` and the contract notes
 *                in `qlip/design/MANIFEST.md`.
 */
export type QlipEntryKind = 'auto' | 'manual' | 'error';
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

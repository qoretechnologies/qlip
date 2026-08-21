export interface QlipViewport {
  width: number;
  height: number;
}

export interface QlipCaptureOptions {
  skip?: boolean;
  viewport?: QlipViewport;
  disableAnimations?: boolean;
  pauseAnimationsAtEnd?: boolean;
  /**
   * Strip `backdrop-filter` from the page for the duration of the
   * capture. Headless Chromium can't composite a backdrop blur, so
   * blurred overlays (reqore panels/popovers/drawers, frosted modals)
   * render as opaque **black rectangles** in the screenshot. The blur is
   * decorative and never the thing under visual test, so this defaults to
   * `true`; set `false` to keep it.
   *
   * @default true
   */
  disableBackdropFilter?: boolean;
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
  /**
   * Base URL of the qlip-server (e.g. "http://localhost:3100" for a
   * local dev server). Optional — when omitted, uploads go to the
   * hosted Qore Technologies instance.
   *
   * @default 'https://qlip.qoretechnologies.com'
   */
  serverUrl?: string;
  /**
   * Bearer token, required by the server when UPLOAD_TOKEN is set.
   * Omit for unauthenticated dev servers.
   *
   * May be either a per-project token minted from the dashboard
   * (`qlt_…`, scoped to one project) or the server's super-admin
   * `UPLOAD_TOKEN` value (any project). Forwarded verbatim as
   * `Authorization: Bearer <token>`; scope is enforced server-side.
   * Prefer the narrowest token that works. See the README's
   * "Authenticating uploads" section.
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
  /**
   * PR base branch (e.g. "develop"). Auto-detected from
   * $GITHUB_BASE_REF (set only on PR builds) when omitted. On push
   * builds it stays undefined and the server falls back to the
   * project's default branch.
   */
  baseBranch?: string;
  /**
   * Commit SHAs from HEAD backward, nearest-first, capped at 100.
   * Auto-detected via `git rev-list` when omitted. The server walks
   * this list to resolve a visual baseline. Omitted (not sent) when
   * git history is unavailable. See `design/UPLOAD.md`.
   */
  ancestorCommits?: string[];
  /**
   * Pull-request URL for the build (e.g.
   * "https://github.com/owner/repo/pull/123"). Auto-detected from the
   * GitHub Actions PR context ($GITHUB_REF `refs/pull/<n>/merge` +
   * $GITHUB_SERVER_URL/$GITHUB_REPOSITORY) when omitted. Only present
   * on `pull_request` builds — undefined (not sent) for local runs and
   * direct pushes. The server stores it so the dashboard can show a
   * "View PR" link. See `design/UPLOAD.md`.
   */
  pullRequestUrl?: string;
  /** Skip upload entirely (handy for local-only runs). */
  disabled?: boolean;
  /**
   * Whether an upload failure should fail the test run.
   * Default: `false` — the run succeeds and the failure is logged.
   * Set to `true` in CI when you want red builds on upload errors.
   */
  failOnUploadError?: boolean;
  /**
   * Whether a partial build should fail the run. A build is partial
   * when PNGs exist on disk that no manifest entry references — i.e.
   * captures whose manifest record was lost. Default: `false` (warn
   * only). See `design/MANIFEST_FRAGMENTS.md`.
   */
  failOnPartialBuild?: boolean;
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
  /**
   * Log one line per capture (story, kind, path, context + sequence)
   * and keep it in the build's `capture-report.json`. Off by default;
   * `$QLIP_DEBUG=1` turns it on without touching config. Use it when a
   * CI build captured fewer stories than it ran.
   */
  diagnostics?: boolean;
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
  /** See `QlipPluginOptions.diagnostics`. */
  diagnostics?: boolean;
}

export interface QlipScreenshotOptions extends QlipCaptureOptions {
  name?: string;
}

export interface QlipStoryContext {
  id?: string;
  title?: string;
  /**
   * The story's human-friendly name. Storybook's `composeStory()`
   * sets this as `storyName` on the result (the `name` property is
   * the underlying function name — usually a bundler tag like
   * `"storyFn"` — and is NOT the story name). We accept both so the
   * runtime works with whichever shape the consumer's context
   * carries.
   */
  name?: string;
  storyName?: string;
  parameters?: {
    qlip?: QlipParameters;
    /**
     * Storybook's Autodocs / MDX story description. Authors write it
     * via `parameters.docs.description.story` on a story. qlip reads it
     * at capture time and forwards it verbatim onto the manifest entry's
     * `description` field so the dashboard can show *why* a story looks
     * the way it does next to its screenshot. Optional — most stories
     * carry no description.
     */
    docs?: { description?: { story?: string } };
  };
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
  /**
   * The story's component (CSF default export) name, e.g.
   * "ReqoreEntityRow". Sourced from addon-vitest's
   * `task.meta.componentName`, which is the only reliable component
   * identity available at capture time — the composed story exposes no
   * `title`, and the storyId is a lossy kebab encoding that can't
   * distinguish the title's `/` separators from spaces (so a
   * storyId-derived title collapses distinct components to a shared
   * leaf, e.g. "Display/Entity Row" + "Display/Severity Row" → "Row").
   * The server prefers this over the storyTitle/storyId derivation when
   * present. Absent on the manual `screenshot()` path (no test task).
   */
  componentName?: string;
  /**
   * Source file the story is defined in, e.g.
   * "src/components/Button.stories.tsx". Sourced from the running test
   * module (`__vitest_worker__.filepath`), falling back to
   * addon-vitest's `task.meta.componentPath`. Lets a downstream consumer
   * (the dashboard's review summary, an agent acting on rejections) jump
   * straight to the file. Absent on the manual `screenshot()` path and
   * when neither source is available.
   */
  storyFilePath?: string;
  /**
   * Human-written story description, sourced from Storybook's
   * `parameters.docs.description.story` at capture time. Lets the
   * dashboard render the intent of a story alongside its screenshot.
   * Trimmed at capture; omitted entirely when absent or empty. The
   * server persists this into `snapshots.description`.
   */
  description?: string;
  screenshotName: string;
  path: string;
  viewport: QlipViewport;
  status: QlipEntryStatus;
  error: { message: string; stack?: string } | null;
  timings: { ms: number };
  logsPath?: string;
  /**
   * sha256 hex of the PNG (the blob key). Set by `uploadBuild` at send
   * time, not persisted to the on-disk manifest. Absent on non-captured
   * entries. See `qlip-server/design/UPLOAD.md §0`.
   */
  sha256?: string;
  sizeBytes?: number;
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

/**
 * Marks every entry for `(storyId, kind)` as stale, whatever order the
 * fragments merge in. Written by the retry-mask prune when a story
 * passes on a later attempt: the error captures from the failed
 * attempts are no longer real failures. Order-independent by design —
 * "this story ultimately passed" is true regardless of when the
 * tombstone lands relative to the entries it retracts.
 */
export interface QlipManifestTombstone {
  storyId: string;
  kind: QlipEntryKind;
}

/**
 * One capture's on-disk record under `<buildDir>/manifest-fragments/`.
 *
 * Fragments are append-only: one file per capture, written exactly
 * once and never rewritten, so concurrent captures — in one context,
 * across contexts, or across processes sharing a `--build-dir` —
 * cannot clobber each other. `entries` therefore holds a single entry
 * (or none, for a tombstone-only fragment), but the merger accepts any
 * count so fragments written by older qlip versions still merge.
 *
 * See `design/MANIFEST_FRAGMENTS.md`.
 */
export interface QlipManifestFragment extends QlipManifest {
  /** Identifies the writing browser context / process. */
  fragmentId?: string;
  /** Per-context capture counter; orders entries within a context. */
  fragmentSeq?: number;
  tombstones?: QlipManifestTombstone[];
}

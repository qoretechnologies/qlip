/**
 * Vitest reporter that finalizes the build after every test file has
 * reported. Two responsibilities:
 *
 * 1. **Always:** merge per-browser-context manifest fragments (written
 *    by `src/runtime/screenshot.ts`) into the canonical `manifest.json`
 *    via `mergeManifestFragments`. Without this step, multi-test-file
 *    runs produce a partial manifest containing only the last test
 *    file's entries — see `src/upload/manifest.ts` header for the
 *    full background.
 *
 * 2. **When `upload` is configured:** POST the merged build to the
 *    qlip-server. On failure either throw (when
 *    `upload.failOnUploadError` is set) or log to stderr.
 *
 * Wired up by `qlipVitestPlugin` unconditionally so non-upload users
 * still get the merge.
 *
 * ## Vitest 2 ↔ Vitest 4 compatibility (2026-05-23)
 *
 * Vitest 2.x's `Reporter` interface uses `onFinished(files, errors,
 * coverage?)` as its end-of-run hook; Vitest 3+ renamed it to
 * `onTestRunEnd()`. We implement BOTH and route them through a
 * single `finalize()` private. A `finalized` flag guards against
 * double-firing if a Vitest version happens to call both (we haven't
 * observed it, but it's cheap insurance).
 *
 * We deliberately do NOT `implements Reporter` on the class — the
 * Reporter type from `vitest/reporters` is the *current* Vitest's
 * shape, and pinning to it would force a major rebump whenever
 * Vitest changes a peripheral signature. Both `onFinished` and
 * `onTestRunEnd` are duck-typed by the runtime; the type-only import
 * stays as a reference for IDE assistance.
 *
 * See `.tasks/VITEST_2_COMPAT.md` for the full rationale + verified
 * line references into Vitest 2.1 and 4.x dist sources.
 */

import type { QlipRuntimeConfig, QlipUploadOptions } from '../types.js';
import { finalizeBuild } from './finalize.js';

export interface IQlipUploadReporterOptions {
  runtime: QlipRuntimeConfig;
  /**
   * Upload options. When omitted the reporter still merges fragments
   * into `manifest.json`; it just skips the POST.
   */
  upload?: QlipUploadOptions;
}

export class QlipUploadReporter {
  private readonly runtime: QlipRuntimeConfig;
  private readonly upload: QlipUploadOptions | undefined;

  constructor(opts: IQlipUploadReporterOptions) {
    this.runtime = opts.runtime;
    this.upload = opts.upload;
  }

  /**
   * Vitest 3+ end-of-run hook. Delegates to the shared
   * `finalizeBuild()` so both lifecycle names share one code path.
   * `finalizeBuild` is process-globally idempotent.
   */
  async onTestRunEnd(): Promise<void> {
    await this.invokeFinalize();
  }

  /**
   * Vitest 2 end-of-run hook (renamed to `onTestRunEnd` in V3).
   * Same shared implementation as `onTestRunEnd` above.
   *
   * Variadic-by-omission: V2 passes `(files, errors, coverage?)`,
   * but the merge reads from disk and never touches in-memory test
   * state, so we accept the call and ignore the args. JavaScript
   * silently drops extra positional arguments — no signature
   * tightness needed at the call site.
   */
  async onFinished(): Promise<void> {
    await this.invokeFinalize();
  }

  private async invokeFinalize(): Promise<void> {
    await finalizeBuild({
      runtime: this.runtime,
      ...(this.upload !== undefined ? { upload: this.upload } : {}),
    });
  }
}

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
 */

import type { Reporter } from 'vitest/reporters';
import type { QlipRuntimeConfig, QlipUploadOptions } from '../types.js';
import { autodetectBranch, autodetectCommit } from './autodetect.js';
import { mergeManifestFragments } from './manifest.js';
import { QlipUploadError, uploadBuild } from './upload.js';

export interface IQlipUploadReporterOptions {
  runtime: QlipRuntimeConfig;
  /**
   * Upload options. When omitted the reporter still merges fragments
   * into `manifest.json`; it just skips the POST.
   */
  upload?: QlipUploadOptions;
}

export class QlipUploadReporter implements Reporter {
  private readonly runtime: QlipRuntimeConfig;
  private readonly upload: QlipUploadOptions | undefined;

  constructor(opts: IQlipUploadReporterOptions) {
    this.runtime = opts.runtime;
    this.upload = opts.upload;
  }

  // onTestRunEnd fires once after every test module has reported.
  async onTestRunEnd(): Promise<void> {
    // Step 1: always merge fragments. Without this, manifest.json
    // contains only entries from the last test file (each browser
    // context writes its own fragment; this consolidates them).
    const merged = await mergeManifestFragments(this.runtime.buildDir);
    if (!merged) {
      // No fragments → no captures happened. Probably a misconfigured
      // run (qlip plugin loaded but the storybook project didn't
      // execute any stories). Bail silently — there's nothing to do.
      return;
    }

    // Step 2: optional upload.
    if (!this.upload || this.upload.disabled === true) return;

    const branch = this.upload.branch ?? autodetectBranch();
    const commit = this.upload.commit ?? autodetectCommit();

    const resolved: QlipUploadOptions = {
      ...this.upload,
      ...(branch !== undefined ? { branch } : {}),
      ...(commit !== undefined ? { commit } : {}),
    };

    try {
      const result = await uploadBuild({
        buildDir: this.runtime.buildDir,
        options: resolved,
      });
      // Single-line success log so CI output stays tidy.
      // eslint-disable-next-line no-console
      console.log(
        `[qlip] uploaded build ${result.buildId} (${String(merged.fragmentCount)} fragment${merged.fragmentCount === 1 ? '' : 's'}, ${String(merged.manifest.entries.length)} entries) → ${this.upload.serverUrl}`,
      );
    } catch (err) {
      const message =
        err instanceof QlipUploadError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // eslint-disable-next-line no-console
      console.error(`[qlip] upload failed: ${message}`);
      if (this.upload.failOnUploadError === true) throw err;
    }
  }
}

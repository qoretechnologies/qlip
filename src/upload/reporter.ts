/**
 * Vitest reporter that posts the finished build to qlip-server after
 * all tests have completed.
 *
 * Wired up by `qlipVitestPlugin` when `options.upload` is provided.
 * Logs a single line to stdout on success; on failure either throws
 * (when `upload.failOnUploadError` is set) or logs to stderr.
 */

import type { Reporter } from 'vitest/reporters';
import type { QlipRuntimeConfig, QlipUploadOptions } from '../types.js';
import { autodetectBranch, autodetectCommit } from './autodetect.js';
import { QlipUploadError, uploadBuild } from './upload.js';

export interface IQlipUploadReporterOptions {
  runtime: QlipRuntimeConfig;
  upload: QlipUploadOptions;
}

export class QlipUploadReporter implements Reporter {
  private readonly runtime: QlipRuntimeConfig;
  private readonly upload: QlipUploadOptions;

  constructor(opts: IQlipUploadReporterOptions) {
    this.runtime = opts.runtime;
    this.upload = opts.upload;
  }

  // onTestRunEnd fires once after every test module has reported.
  async onTestRunEnd(): Promise<void> {
    if (this.upload.disabled === true) return;

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
        `[qlip] uploaded build ${result.buildId} → ${this.upload.serverUrl}`,
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

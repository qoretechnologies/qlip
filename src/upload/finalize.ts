/**
 * Shared end-of-run pipeline: merge manifest fragments, optionally
 * upload to qlip-server. Called from two places:
 *
 * 1. `QlipUploadReporter.onFinished` / `onTestRunEnd` — the Vitest
 *    reporter lifecycle. Works on Vitest 4 in single-project mode,
 *    and on any Vitest version when the user mounts the plugin
 *    outside a workspace project.
 *
 * 2. `runtime/global-setup` teardown — the Vitest globalSetup
 *    lifecycle. Works on Vitest 2 / 3 in workspace mode, where the
 *    reporter scope is project-local but `globalSetup` teardown
 *    fires reliably for whichever project hosts qlip's plugin.
 *
 * Both call paths share this module so the merge + upload logic
 * lives in one place. A process-global flag (`__QLIP_FINALIZED__`)
 * dedupes — if both paths fire in the same run, only the first
 * actually does the work.
 */

import type { QlipRuntimeConfig, QlipUploadOptions } from '../types.js';
import {
  autodetectAncestorCommits,
  autodetectBaseBranch,
  autodetectBranch,
  autodetectCommit,
  autodetectPullRequestUrl,
} from './autodetect.js';
import {
  buildCaptureReport,
  describeCollisions,
  describePartialBuild,
  writeCaptureReport,
} from './capture-report.js';
import { mergeManifestFragments } from './manifest.js';
import type { MergeResult } from './manifest.js';
import { QlipUploadError, uploadBuild, resolveServerUrl } from './upload.js';

/**
 * Thrown when a build is partial and the caller opted into
 * `failOnPartialBuild`. Distinct from `QlipUploadError` — the upload
 * may have been fine; the *capture* was not.
 */
export class QlipPartialBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QlipPartialBuildError';
  }
}

/**
 * Entry + context counts rather than a raw fragment count: a fragment
 * is now one capture, so "142 fragments" no longer says how many
 * contexts ran — and the context count is exactly what tells you
 * whether `isolate: false` is packing many story files into one.
 */
const summarizeBuild = (merged: MergeResult, buildId?: string): string => {
  const { stats } = merged.manifest;
  return `build ${buildId ?? merged.manifest.buildId}: ${String(merged.manifest.entries.length)} entries from ${String(merged.contextCount)} context${merged.contextCount === 1 ? '' : 's'} (${String(stats.capturedAuto)} auto, ${String(stats.capturedManual)} manual, ${String(stats.failed)} failed, ${String(stats.skipped)} skipped)`;
};

const FINALIZE_FLAG = Symbol.for('@qoretechnologies/qlip/__finalized__');

interface FinalizeFlagHolder {
  [FINALIZE_FLAG]?: boolean;
}

const isAlreadyFinalized = (): boolean => {
  const holder = globalThis as FinalizeFlagHolder;
  return holder[FINALIZE_FLAG] === true;
};

const markFinalized = (): void => {
  const holder = globalThis as FinalizeFlagHolder;
  holder[FINALIZE_FLAG] = true;
};

export interface IFinalizeBuildOptions {
  runtime: QlipRuntimeConfig;
  upload?: QlipUploadOptions;
}

export const finalizeBuild = async (
  opts: IFinalizeBuildOptions,
): Promise<void> => {
  // Process-global dedup. Both the reporter hook AND globalSetup
  // teardown can fire in the same run (e.g. Vitest 4 workspace where
  // both lifecycles activate); we only want to merge + upload once.
  if (isAlreadyFinalized()) return;
  markFinalized();

  // Step 1: always merge fragments. Without this, manifest.json
  // contains only entries from the last test file (each capture writes
  // its own fragment; this consolidates them).
  const merged = await mergeManifestFragments(opts.runtime.buildDir);
  if (!merged) {
    // No fragments → no captures happened. Probably a misconfigured
    // run (qlip plugin loaded but the storybook project didn't
    // execute any stories). Bail silently — there's nothing to do.
    return;
  }

  // Step 2: audit what landed. A build that lost captures used to be
  // indistinguishable from a smaller suite; now it says so.
  const report = await buildCaptureReport(opts.runtime.buildDir, merged);
  await writeCaptureReport(opts.runtime.buildDir, report);
  const partial = describePartialBuild(report);
  if (partial) {
    // eslint-disable-next-line no-console
    console.warn(`[qlip] ${partial}`);
  }
  const collisions = describeCollisions(report);
  if (collisions) {
    // eslint-disable-next-line no-console
    console.warn(`[qlip] ${collisions}`);
  }

  // A partial build still uploads: seeing which stories DID capture is
  // how you diagnose one. The opt-in failure is raised at the end, so
  // it never costs the user the evidence.
  const partialError =
    partial && opts.upload?.failOnPartialBuild === true
      ? new QlipPartialBuildError(partial)
      : null;

  // Step 3: optional upload.
  if (!opts.upload || opts.upload.disabled === true) {
    // Without an upload there is no other end-of-run line, so a local
    // run would otherwise finish with no indication of what it caught.
    // eslint-disable-next-line no-console
    console.log(`[qlip] ${summarizeBuild(merged)} → ${opts.runtime.buildDir}`);
    if (partialError) throw partialError;
    return;
  }

  const branch = opts.upload.branch ?? autodetectBranch();
  const commit = opts.upload.commit ?? autodetectCommit();
  const baseBranch = opts.upload.baseBranch ?? autodetectBaseBranch();
  const ancestorCommits =
    opts.upload.ancestorCommits ?? autodetectAncestorCommits();
  const pullRequestUrl =
    opts.upload.pullRequestUrl ?? autodetectPullRequestUrl();

  const resolved: QlipUploadOptions = {
    ...opts.upload,
    ...(branch !== undefined ? { branch } : {}),
    ...(commit !== undefined ? { commit } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(ancestorCommits !== undefined ? { ancestorCommits } : {}),
    ...(pullRequestUrl !== undefined ? { pullRequestUrl } : {}),
  };

  try {
    const result = await uploadBuild({
      buildDir: opts.runtime.buildDir,
      options: resolved,
    });
    const detail =
      result.protocol === 'v2'
        ? `${String(result.blobsUploaded ?? 0)}/${String(result.blobsTotal ?? 0)} screenshots uploaded${result.blobsUploaded === 0 ? ' (all unchanged)' : ''}`
        : `${String(merged.manifest.entries.length)} entries, legacy protocol`;
    // eslint-disable-next-line no-console
    console.log(
      `[qlip] uploaded ${summarizeBuild(merged, result.buildId)}, ${detail} → ${resolveServerUrl(resolved)}`,
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
    if (opts.upload.failOnUploadError === true) throw err;
  }

  if (partialError) throw partialError;
};

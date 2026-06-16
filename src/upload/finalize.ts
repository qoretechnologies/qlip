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
} from './autodetect.js';
import { mergeManifestFragments } from './manifest.js';
import { QlipUploadError, uploadBuild, resolveServerUrl } from './upload.js';

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
  // contains only entries from the last test file (each browser
  // context writes its own fragment; this consolidates them).
  const merged = await mergeManifestFragments(opts.runtime.buildDir);
  if (!merged) {
    // No fragments → no captures happened. Probably a misconfigured
    // run (qlip plugin loaded but the storybook project didn't
    // execute any stories). Bail silently — there's nothing to do.
    return;
  }

  // Step 2: optional upload.
  if (!opts.upload || opts.upload.disabled === true) return;

  const branch = opts.upload.branch ?? autodetectBranch();
  const commit = opts.upload.commit ?? autodetectCommit();
  const baseBranch = opts.upload.baseBranch ?? autodetectBaseBranch();
  const ancestorCommits =
    opts.upload.ancestorCommits ?? autodetectAncestorCommits();

  const resolved: QlipUploadOptions = {
    ...opts.upload,
    ...(branch !== undefined ? { branch } : {}),
    ...(commit !== undefined ? { commit } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(ancestorCommits !== undefined ? { ancestorCommits } : {}),
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
      `[qlip] uploaded build ${result.buildId} (${String(merged.fragmentCount)} fragment${merged.fragmentCount === 1 ? '' : 's'}, ${detail}) → ${resolveServerUrl(resolved)}`,
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
};

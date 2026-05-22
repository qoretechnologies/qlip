/**
 * Node-side helper that merges per-browser-context manifest fragments
 * into the final `manifest.json`.
 *
 * Why this exists: in Vitest browser-mode every `*.stories.tsx` runs
 * in its own browser context (its own iframe + module graph). Each
 * context initializes a fresh `QlipRuntimeState` with an empty
 * manifest, then writes the full manifest to disk after every capture.
 * If they all wrote to the same `manifest.json` the writes would
 * clobber each other — the last test file to finish would win, and
 * earlier files' entries would be stranded on disk and never reach
 * the upload reporter.
 *
 * Fix: each context writes its in-memory manifest to a unique fragment
 * file under `manifest-fragments/`. This merger reads them all back
 * once Vitest signals end-of-run and produces the canonical
 * `manifest.json` from the union.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FRAGMENT_DIR } from '../fs/output.js';
import type { QlipManifest } from '../types.js';

export { MANIFEST_FRAGMENT_DIR };

const sumStats = (
  a: QlipManifest['stats'],
  b: QlipManifest['stats'],
): QlipManifest['stats'] => ({
  storiesTotal: a.storiesTotal + b.storiesTotal,
  capturedAuto: a.capturedAuto + b.capturedAuto,
  capturedManual: a.capturedManual + b.capturedManual,
  skipped: a.skipped + b.skipped,
  failed: a.failed + b.failed,
  // Each fragment's durationMs is "ms since that context's runtime
  // initialized." The longest of those is the closest analogue to
  // build wall-clock time. (Cross-context start jitter is small
  // enough not to bother computing min-start/max-end.)
  durationMs: Math.max(a.durationMs, b.durationMs),
});

export interface MergeResult {
  manifest: QlipManifest;
  /** How many fragment files contributed to the merge. */
  fragmentCount: number;
}

/**
 * Read every `<buildDir>/manifest-fragments/*.json`, merge into one
 * manifest, write `<buildDir>/manifest.json`.
 *
 * Returns `null` when the fragments directory is missing or empty —
 * that typically means qlip never captured anything (e.g. a test run
 * with no Storybook stories). The caller decides whether that's a
 * warning or fine.
 *
 * Fragments are left in place after the merge for debugging; they're
 * tiny JSON files and re-running the merge is a useful escape hatch.
 */
export const mergeManifestFragments = async (
  buildDir: string,
): Promise<MergeResult | null> => {
  const fragmentsDir = path.join(buildDir, MANIFEST_FRAGMENT_DIR);
  let files: string[];
  try {
    files = await readdir(fragmentsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) return null;

  // Each fragment is a full QlipManifest captured by one browser
  // context. The build-level fields (tool/buildId/outputDir/defaults)
  // are identical across them because every context reads the same
  // runtime config; we can pick any one as the skeleton.
  const fragments: QlipManifest[] = [];
  for (const file of jsonFiles) {
    const text = await readFile(path.join(fragmentsDir, file), 'utf-8');
    fragments.push(JSON.parse(text) as QlipManifest);
  }

  // Sort by createdAt so entry order is deterministic across runs.
  // (Within a fragment, entries are already in capture order.)
  fragments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // jsonFiles.length > 0 above guarantees fragments[0] exists; qlip's
  // tsconfig doesn't set noUncheckedIndexedAccess so the type is
  // already QlipManifest rather than QlipManifest | undefined.
  const skeleton = fragments[0];
  const merged: QlipManifest = {
    tool: skeleton.tool,
    buildId: skeleton.buildId,
    createdAt: skeleton.createdAt,
    outputDir: skeleton.outputDir,
    defaults: skeleton.defaults,
    stats: {
      storiesTotal: 0,
      capturedAuto: 0,
      capturedManual: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    },
    entries: [],
  };
  for (const frag of fragments) {
    merged.stats = sumStats(merged.stats, frag.stats);
    merged.entries.push(...frag.entries);
  }

  await writeFile(
    path.join(buildDir, 'manifest.json'),
    JSON.stringify(merged, null, 2),
    'utf-8',
  );
  return { manifest: merged, fragmentCount: fragments.length };
};

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
import type { QlipManifest, QlipManifestEntry } from '../types.js';

export { MANIFEST_FRAGMENT_DIR };

/**
 * Deduplicate manifest entries by `(storyId, kind)`, keeping the LAST
 * occurrence of each key. The "last" rule is intentional: when vite's
 * dep-optimization re-runs a story file mid-build (a known Storybook
 * addon-vitest interaction — see Storybook #33067), qlip writes a
 * second manifest entry for the same `(storyId, kind)`. The PNG path
 * is deterministic so both entries reference the same file on disk,
 * but the SECOND capture is the more accurate one (it ran with warm
 * deps, after any prior failure recovered). The server-side
 * `snapshots` table enforces `(buildId, storyId, kind)` as the
 * primary key, so without this dedupe the upload pipeline rejects
 * the entire build with `duplicate key value violates unique
 * constraint snapshots_pkey`.
 *
 * Stats are recomputed from the deduped set so storiesTotal /
 * capturedAuto / failed reflect actual unique story captures rather
 * than counting duplicates.
 */
const dedupeEntries = (
  entries: QlipManifestEntry[],
): QlipManifestEntry[] => {
  const byKey = new Map<string, QlipManifestEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.storyId}::${entry.kind}`, entry);
  }
  return [...byKey.values()];
};

const computeStats = (
  entries: QlipManifestEntry[],
  durationMs: number,
): QlipManifest['stats'] => {
  let storiesTotal = 0;
  let capturedAuto = 0;
  let capturedManual = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of entries) {
    if (e.kind === 'auto') {
      storiesTotal += 1;
      if (e.status === 'captured') capturedAuto += 1;
      if (e.status === 'failed') failed += 1;
      if (e.status === 'skipped') skipped += 1;
    } else if (e.kind === 'manual') {
      if (e.status === 'captured') capturedManual += 1;
      if (e.status === 'failed') failed += 1;
      if (e.status === 'skipped') skipped += 1;
    } else if (e.kind === 'error') {
      // Error entries don't count toward storiesTotal (their matching
      // auto entry already did) and don't count toward capturedManual.
      // They DO bump `failed` because each one marks a real test
      // failure.
      failed += 1;
    }
  }
  return {
    storiesTotal,
    capturedAuto,
    capturedManual,
    skipped,
    failed,
    durationMs,
  };
};

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
  // Concatenate all fragment entries in chronological order, then
  // dedupe by (storyId, kind). The deterministic sort + last-wins
  // semantics keep the SECOND/LATEST capture of each story when
  // vite-reopt or the addon-vitest re-runs a file mid-build.
  const allEntries: QlipManifestEntry[] = [];
  let maxDurationMs = 0;
  for (const frag of fragments) {
    allEntries.push(...frag.entries);
    maxDurationMs = Math.max(maxDurationMs, frag.stats.durationMs);
  }
  const dedupedEntries = dedupeEntries(allEntries);

  const merged: QlipManifest = {
    tool: skeleton.tool,
    buildId: skeleton.buildId,
    createdAt: skeleton.createdAt,
    outputDir: skeleton.outputDir,
    defaults: skeleton.defaults,
    // Recompute stats from the deduped entry set; summing the
    // fragments' reported stats would overcount whenever vite-reopt
    // produced a duplicate. Entry-derived stats are the canonical
    // truth.
    stats: computeStats(dedupedEntries, maxDurationMs),
    entries: dedupedEntries,
  };

  await writeFile(
    path.join(buildDir, 'manifest.json'),
    JSON.stringify(merged, null, 2),
    'utf-8',
  );
  return { manifest: merged, fragmentCount: fragments.length };
};

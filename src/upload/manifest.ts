/**
 * Node-side helper that merges per-capture manifest fragments into the
 * final `manifest.json`.
 *
 * Why this exists: captures happen in the browser, concurrently, in
 * however many contexts Vitest decides to use — and, when CI shards a
 * suite across several `vitest run` invocations pinned to one
 * `--build-dir`, in several processes too. None of them can safely
 * share a mutable `manifest.json`.
 *
 * So each capture writes its own append-only fragment under
 * `manifest-fragments/` (see `design/MANIFEST_FRAGMENTS.md`), and this
 * merger reads them all back at end-of-run and produces the canonical
 * `manifest.json` from the union.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FRAGMENT_DIR } from '../fs/output.js';
import type {
  QlipManifest,
  QlipManifestEntry,
  QlipManifestFragment,
} from '../types.js';

export { MANIFEST_FRAGMENT_DIR };

/**
 * How many fragment files to read at once. A ~1700-story run writes
 * ~1700 fragments, and a shared build dir across ~10 CI shards can
 * hold ~17k; reading them one at a time is needlessly slow, and
 * unbounded `Promise.all` exhausts file descriptors.
 */
const READ_CONCURRENCY = 64;

const readFragments = async (
  fragmentsDir: string,
  files: string[],
): Promise<{ file: string; fragment: QlipManifestFragment }[]> => {
  const out: { file: string; fragment: QlipManifestFragment }[] = [];
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    const batch = files.slice(i, i + READ_CONCURRENCY);
    const parsed = await Promise.all(
      batch.map(async (file) => {
        const text = await readFile(path.join(fragmentsDir, file), 'utf-8');
        return { file, fragment: JSON.parse(text) as QlipManifestFragment };
      }),
    );
    out.push(...parsed);
  }
  return out;
};

const tombstoneKey = (storyId: string, kind: string): string =>
  `${storyId}::${kind}`;

/**
 * Two captures of the same story that qlip-server would store as ONE
 * snapshot because they share a `screenshotName` — e.g. a manual
 * `screenshot(ctx, 'auto')` alongside the story's auto capture. Only
 * one image can survive; the run reports which, so the author can
 * rename instead of wondering where a screenshot went.
 */
export interface ISnapshotIdCollision {
  storyId: string;
  screenshotName: string;
  /** Relative path of the capture that reached the manifest. */
  keptPath: string;
  /** Relative path of the capture it displaced. */
  droppedPath: string;
}

/**
 * Deduplicate manifest entries by the identity the SERVER gives a
 * snapshot: `(storyId, screenshotName)`. qlip-server derives a
 * snapshot's primary key as `${buildId}-${storyId}-${screenshotName}`
 * (`qlip-server/src/utils/transforms.ts`), so any two entries sharing
 * that pair are one row there — whatever their `kind` — and sending
 * both gets the whole build rejected with `duplicate key value
 * violates unique constraint snapshots_pkey`.
 *
 * Keeping the LAST occurrence is intentional: when vite's
 * dep-optimization re-runs a story file mid-build (a known Storybook
 * addon-vitest interaction — see Storybook #33067), qlip writes a
 * second entry for the same capture. The PNG path is deterministic so
 * both reference the same file, and the SECOND capture is the more
 * accurate one (warm deps, after any prior failure recovered).
 *
 * This used to key on `(storyId, kind)`, which was wrong in both
 * directions: it collapsed captures the server stores separately — a
 * story's second `screenshot()` call, and every error capture after
 * the first on a retried story — while still letting a manual
 * screenshot named `auto` collide with the story's auto capture and
 * take the build down. Collapsing only what the server actually
 * merges keeps the manifest and the snapshots table in agreement by
 * construction.
 *
 * Losers that pointed at a DIFFERENT image are reported: they are two
 * real captures competing for one snapshot id, and renaming one is the
 * only fix — so the run says so rather than dropping an image quietly.
 *
 * Stats are recomputed from the deduped set so storiesTotal /
 * capturedAuto / failed reflect actual unique story captures rather
 * than counting duplicates.
 */
const dedupeEntries = (
  entries: QlipManifestEntry[],
): { entries: QlipManifestEntry[]; collisions: ISnapshotIdCollision[] } => {
  const byKey = new Map<string, QlipManifestEntry>();
  const collisions: ISnapshotIdCollision[] = [];
  for (const entry of entries) {
    const key = `${entry.storyId}::${entry.screenshotName}`;
    const previous = byKey.get(key);
    if (previous && previous.path !== entry.path) {
      collisions.push({
        storyId: entry.storyId,
        screenshotName: entry.screenshotName,
        keptPath: entry.path,
        droppedPath: previous.path,
      });
    }
    byKey.set(key, entry);
  }
  return { entries: [...byKey.values()], collisions };
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
  /**
   * How many fragment files contributed to the merge — one per capture
   * since the append-only change, so NOT a count of browser contexts.
   * Use `contextCount` for that.
   */
  fragmentCount: number;
  /** Distinct browser contexts / processes that captured anything. */
  contextCount: number;
  /** Entries per context, keyed by `fragmentId`. For diagnostics. */
  entriesByContext: Record<string, number>;
  /** Entries retracted by a tombstone (the retry-mask prune). */
  retractedCount: number;
  /**
   * Captures dropped because another capture of the same story claimed
   * the same snapshot id. Empty in a healthy build.
   */
  collisions: ISnapshotIdCollision[];
  /**
   * Screenshot paths belonging to retracted entries. Their PNGs may
   * still be on disk — deleting them is best-effort and no-ops on
   * Vitest versions without a `removeFile` command — so the partial-
   * build audit must not mistake them for lost captures.
   */
  retractedPaths: string[];
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

  // Each fragment carries the capture it recorded plus the build-level
  // fields (tool/buildId/outputDir/defaults), which are identical
  // across them because every context reads the same runtime config;
  // we can pick any one as the skeleton.
  const fragments = await readFragments(fragmentsDir, jsonFiles);

  // Deterministic order across runs — `readdir` order is not. Fragments
  // written before the append-only change carry no fragmentId/Seq, so
  // fall back to the file name, which was `<fragmentId>.json` then.
  fragments.sort((a, b) => {
    const byCreatedAt = a.fragment.createdAt.localeCompare(
      b.fragment.createdAt,
    );
    if (byCreatedAt !== 0) return byCreatedAt;
    const byContext = (a.fragment.fragmentId ?? a.file).localeCompare(
      b.fragment.fragmentId ?? b.file,
    );
    if (byContext !== 0) return byContext;
    return (a.fragment.fragmentSeq ?? 0) - (b.fragment.fragmentSeq ?? 0);
  });

  // jsonFiles.length > 0 above guarantees fragments[0] exists; qlip's
  // tsconfig doesn't set noUncheckedIndexedAccess so the type is
  // already QlipManifestFragment rather than `| undefined`.
  const skeleton = fragments[0].fragment;
  // Concatenate all fragment entries in capture order, then dedupe by
  // the server's snapshot identity, `(storyId, screenshotName)` — see
  // dedupeEntries. The deterministic sort + last-wins semantics keep
  // the SECOND/LATEST capture of each story when vite-reopt or the
  // addon-vitest re-runs a file mid-build.
  const allEntries: QlipManifestEntry[] = [];
  const entriesByContext: Record<string, number> = {};
  const retracted = new Set<string>();
  let maxDurationMs = 0;
  for (const { file, fragment } of fragments) {
    allEntries.push(...fragment.entries);
    const contextId = fragment.fragmentId ?? file;
    entriesByContext[contextId] =
      (entriesByContext[contextId] ?? 0) + fragment.entries.length;
    for (const tombstone of fragment.tombstones ?? []) {
      retracted.add(tombstoneKey(tombstone.storyId, tombstone.kind));
    }
    maxDurationMs = Math.max(maxDurationMs, fragment.stats.durationMs);
  }
  // Tombstones apply regardless of merge order — see
  // QlipManifestTombstone. Track what they actually removed so the
  // caller can report it rather than silently shrinking the build.
  const liveEntries: QlipManifestEntry[] = [];
  const retractedPaths: string[] = [];
  for (const e of allEntries) {
    if (retracted.size && retracted.has(tombstoneKey(e.storyId, e.kind))) {
      retractedPaths.push(e.path);
      continue;
    }
    liveEntries.push(e);
  }
  const { entries: dedupedEntries, collisions } = dedupeEntries(liveEntries);

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
  return {
    manifest: merged,
    fragmentCount: fragments.length,
    contextCount: Object.keys(entriesByContext).length,
    entriesByContext,
    retractedCount: retractedPaths.length,
    retractedPaths,
    collisions,
  };
};

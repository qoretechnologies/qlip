/**
 * Unit tests for `mergeManifestFragments` — the Node-side step that
 * collapses per-browser-context fragments into a single manifest.json
 * before the upload reporter reads it.
 *
 * Each fragment represents what one browser context (one
 * `*.stories.tsx`) would have written under the new
 * fragment-per-context scheme. The merge must:
 *   - return all entries from every fragment (no loss)
 *   - sum the stats counters
 *   - keep entry order deterministic across runs
 *   - tolerate a missing/empty fragments directory
 */

import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_FRAGMENT_DIR,
  mergeManifestFragments,
} from '../../src/upload/manifest.js';
import { fragmentFileName } from '../../src/fs/output.js';
import type {
  QlipManifest,
  QlipManifestEntry,
  QlipManifestFragment,
  QlipResolvedDefaults,
} from '../../src/types.js';

let buildDir: string;

const defaults: QlipResolvedDefaults = {
  outputDir: './qlip/screenshots',
  viewport: { width: 1280, height: 720 },
  skip: false,
  disableAnimations: true,
  pauseAnimationsAtEnd: false,
  captureOnError: true,
  waitForIdleMs: 100,
  maxWaitForIdleMs: 500,
  ignoreElements: [],
  auto: true,
  manual: true,
  error: true,
  captureConsole: true,
  captureConsoleLevels: ['error'],
  maxConsoleLogs: 50,
  consoleLogExcludePatterns: [],
};

const entry = (
  id: string,
  overrides: Partial<QlipManifestEntry> = {},
): QlipManifestEntry => ({
  kind: 'auto',
  storyId: id,
  storyName: id,
  screenshotName: 'auto',
  path: `stories/auto/${id}.png`,
  viewport: { width: 1280, height: 720 },
  status: 'captured',
  error: null,
  timings: { ms: 10 },
  ...overrides,
});

const fragment = (
  createdAt: string,
  entries: QlipManifestEntry[],
  stats: Partial<QlipManifest['stats']> = {},
): QlipManifest => ({
  tool: { name: 'qlip', version: '0.1.0' },
  buildId: 'shared-build',
  createdAt,
  outputDir: '/tmp/qlip',
  defaults,
  stats: {
    storiesTotal: entries.length,
    capturedAuto: entries.filter((e) => e.kind === 'auto').length,
    capturedManual: entries.filter((e) => e.kind === 'manual').length,
    skipped: 0,
    failed: 0,
    durationMs: 100,
    ...stats,
  },
  entries,
});

const writeFragment = async (name: string, m: QlipManifest): Promise<void> => {
  await writeFile(
    path.join(buildDir, MANIFEST_FRAGMENT_DIR, `${name}.json`),
    JSON.stringify(m),
  );
};

beforeEach(async () => {
  buildDir = await mkdtemp(path.join(tmpdir(), 'qlip-merge-test-'));
  await mkdir(path.join(buildDir, MANIFEST_FRAGMENT_DIR), { recursive: true });
});

afterEach(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

describe('mergeManifestFragments', () => {
  it('returns null when the fragments directory is missing', async () => {
    // Start fresh — no fragments dir.
    await rm(buildDir, { recursive: true });
    await mkdir(buildDir);
    const result = await mergeManifestFragments(buildDir);
    expect(result).toBeNull();
  });

  it('returns null when fragments directory exists but is empty', async () => {
    const result = await mergeManifestFragments(buildDir);
    expect(result).toBeNull();
  });

  it('merges two fragments — entries concatenated, stats summed', async () => {
    await writeFragment(
      'frag-a',
      fragment('2026-05-22T10:00:00.000Z', [entry('a1'), entry('a2')], {
        storiesTotal: 2,
        capturedAuto: 2,
        durationMs: 500,
      }),
    );
    await writeFragment(
      'frag-b',
      fragment('2026-05-22T10:00:01.000Z', [entry('b1')], {
        storiesTotal: 1,
        capturedAuto: 1,
        durationMs: 200,
      }),
    );

    const result = await mergeManifestFragments(buildDir);
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected merge result');

    expect(result.fragmentCount).toBe(2);
    expect(result.manifest.entries.map((e) => e.storyId)).toEqual([
      'a1',
      'a2',
      'b1',
    ]);
    expect(result.manifest.stats.storiesTotal).toBe(3);
    expect(result.manifest.stats.capturedAuto).toBe(3);
    // durationMs takes the max — best wall-clock proxy.
    expect(result.manifest.stats.durationMs).toBe(500);
  });

  it('sorts fragments by createdAt so entry order is deterministic', async () => {
    // Write in reverse-chronological filename order to confirm the
    // sort isn't relying on readdir order.
    await writeFragment(
      'z-last',
      fragment('2026-05-22T10:00:02.000Z', [entry('z1')]),
    );
    await writeFragment(
      'a-first',
      fragment('2026-05-22T10:00:00.000Z', [entry('a1')]),
    );
    await writeFragment(
      'm-middle',
      fragment('2026-05-22T10:00:01.000Z', [entry('m1')]),
    );

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries.map((e) => e.storyId)).toEqual([
      'a1',
      'm1',
      'z1',
    ]);
  });

  it('writes the merged manifest to <buildDir>/manifest.json', async () => {
    await writeFragment(
      'frag-only',
      fragment('2026-05-22T10:00:00.000Z', [entry('only')]),
    );
    await mergeManifestFragments(buildDir);
    const written = JSON.parse(
      await readFile(path.join(buildDir, 'manifest.json'), 'utf-8'),
    ) as QlipManifest;
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0]?.storyId).toBe('only');
  });

  it('computes skipped + failed across fragments from entries', async () => {
    // Stats are derived from the deduped entry set, not summed from
    // the fragments' self-reported counts. Use real entries to
    // drive the totals.
    await writeFragment(
      'a',
      fragment('2026-05-22T10:00:00.000Z', [
        entry('a-skipped-1', { status: 'skipped' }),
        entry('a-skipped-2', { status: 'skipped' }),
        entry('a-failed-1', { status: 'failed' }),
      ]),
    );
    await writeFragment(
      'b',
      fragment('2026-05-22T10:00:01.000Z', [
        entry('b-skipped-1', { status: 'skipped' }),
      ]),
    );
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.stats.skipped).toBe(3);
    expect(result.manifest.stats.failed).toBe(1);
    // storiesTotal counts auto-kind entries regardless of status
    expect(result.manifest.stats.storiesTotal).toBe(4);
  });

  // 2026-05-25 — vite dep-optimization re-runs sometimes execute the
  // same .stories.tsx file twice in one build, producing two entries
  // pointing at the same PNG. qlip-server keys a snapshot on
  // `${buildId}-${storyId}-${screenshotName}` and rejects the upload
  // if duplicates land in the manifest. The merger MUST dedupe —
  // keeping the LATER entry because that's the post-reopt capture.
  it('dedupes entries with identical (storyId, screenshotName) keeping the LAST seen', async () => {
    const oldEntry = entry('components-guide--default', {
      timings: { ms: 100 },
      storyName: 'Default',
    });
    const newerEntry = entry('components-guide--default', {
      timings: { ms: 200 },
      // Mid-run re-run picked up a fresher storyName (e.g. after
      // hot-reload of meta). Keep this one.
      storyName: 'DefaultV2',
    });
    await writeFragment(
      'first',
      fragment('2026-05-22T10:00:00.000Z', [oldEntry]),
    );
    await writeFragment(
      'second',
      fragment('2026-05-22T10:00:01.000Z', [newerEntry]),
    );
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries).toHaveLength(1);
    expect(result.manifest.entries[0]?.storyName).toBe('DefaultV2');
    expect(result.manifest.entries[0]?.timings.ms).toBe(200);
  });

  it('dedupes entries inside a single fragment too (defense in depth)', async () => {
    // A buggy runtime could conceivably write the same entry twice in
    // one fragment. The merger should still produce one row per
    // snapshot id.
    await writeFragment(
      'single',
      fragment('2026-05-22T10:00:00.000Z', [
        entry('a'),
        entry('a'),
        entry('a'),
      ]),
    );
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries).toHaveLength(1);
  });

  it('keeps auto and error entries for the same storyId as separate rows', async () => {
    // Their screenshot names differ ('auto' vs the error base), so
    // they are two distinct snapshots server-side. A story that
    // produced both an auto capture and an error capture must yield
    // TWO rows so the FailureCollection surface can show the error
    // alongside the regular grid entry.
    await writeFragment(
      'frag',
      fragment('2026-05-22T10:00:00.000Z', [
        entry('comp--err', { kind: 'auto' }),
        entry('comp--err', { kind: 'error', screenshotName: 'qlip-auto-error-capture' }),
      ]),
    );
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries).toHaveLength(2);
    expect(result.manifest.entries.map((e) => e.kind).sort()).toEqual([
      'auto',
      'error',
    ]);
  });

  it('keeps every manual screenshot of a story — they are separate snapshots', async () => {
    // The dedupe key used to be (storyId, kind), which silently kept
    // only the LAST manual capture of a story: a play function taking
    // three screenshots uploaded one. qlip-server keys on the
    // screenshot name, so all three are real, distinct snapshots.
    await writeFragment(
      'frag',
      fragment('2026-08-15T10:00:00.000Z', [
        entry('page--flow', { kind: 'auto' }),
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'step-1',
          path: 'stories/manual/page--flow--step-1.png',
        }),
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'step-2',
          path: 'stories/manual/page--flow--step-2.png',
        }),
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'step-3',
          path: 'stories/manual/page--flow--step-3.png',
        }),
      ]),
    );

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries.map((e) => e.screenshotName)).toEqual([
      'auto',
      'step-1',
      'step-2',
      'step-3',
    ]);
    expect(result.manifest.stats.capturedManual).toBe(3);
    expect(result.collisions).toEqual([]);
  });

  it('keeps every error capture of a retried story', async () => {
    // Three failed attempts produce three error captures with
    // distinct names (pickUniqueErrorName). Under the old key they
    // collapsed to one, so the Failures surface showed a single
    // attempt.
    await writeFragment(
      'frag',
      fragment('2026-08-15T10:00:00.000Z', [
        entry('flaky--story', {
          kind: 'error',
          screenshotName: 'qlip-auto-error-capture',
          path: 'stories/error/flaky--story--qlip-auto-error-capture.png',
        }),
        entry('flaky--story', {
          kind: 'error',
          screenshotName: 'qlip-auto-error-capture-2',
          path: 'stories/error/flaky--story--qlip-auto-error-capture-2.png',
        }),
      ]),
    );

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries).toHaveLength(2);
    expect(result.manifest.stats.failed).toBe(2);
  });

  it('collapses two captures that would claim one snapshot id, and reports it', async () => {
    // `screenshot(ctx, 'auto')` collides with the story's own auto
    // capture: same storyId, same screenshot name, different image.
    // The old key kept both because the kinds differed — and the
    // server then rejected the ENTIRE build on its primary key.
    await writeFragment(
      'frag',
      fragment('2026-08-15T10:00:00.000Z', [
        entry('clash--story', { kind: 'auto' }),
        entry('clash--story', {
          kind: 'manual',
          screenshotName: 'auto',
          path: 'stories/manual/clash--story--auto.png',
        }),
      ]),
    );

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries).toHaveLength(1);
    // Last wins, as everywhere else in the merge.
    expect(result.manifest.entries[0].path).toBe(
      'stories/manual/clash--story--auto.png',
    );
    // Losing an image is worth saying out loud — it is fixable by
    // renaming, but only if the author hears about it.
    expect(result.collisions).toEqual([
      {
        storyId: 'clash--story',
        screenshotName: 'auto',
        keptPath: 'stories/manual/clash--story--auto.png',
        droppedPath: 'stories/auto/clash--story.png',
      },
    ]);
  });

  it('recomputes storiesTotal / capturedAuto / failed from the deduped entry set', async () => {
    // The fragments' self-reported stats are intentionally wrong here
    // (they came from a build with vite-reopt duplicates); the merger
    // must ignore those and derive truth from entries.
    await writeFragment(
      'a',
      fragment(
        '2026-05-22T10:00:00.000Z',
        [
          entry('s1'),
          entry('s2'),
          entry('s3', { status: 'failed' }),
          // Duplicate of s1 — should collapse.
          entry('s1'),
        ],
        // Misleading reported stats from the buggy runtime.
        { storiesTotal: 4, capturedAuto: 4, failed: 1 },
      ),
    );
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries).toHaveLength(3);
    expect(result.manifest.stats.storiesTotal).toBe(3);
    expect(result.manifest.stats.capturedAuto).toBe(2);
    expect(result.manifest.stats.failed).toBe(1);
  });

  it('ignores non-JSON files in the fragments directory', async () => {
    await writeFragment(
      'real',
      fragment('2026-05-22T10:00:00.000Z', [entry('only')]),
    );
    await writeFile(
      path.join(buildDir, MANIFEST_FRAGMENT_DIR, 'README.txt'),
      'human note',
    );
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.fragmentCount).toBe(1);
  });

  it('preserves build-level fields from the earliest fragment', async () => {
    // Both fragments share these in practice (they're computed from
    // the runtime config injected at plugin-config time), but verify
    // the merger picks them up rather than zeroing them.
    await writeFragment(
      'a',
      fragment('2026-05-22T10:00:00.000Z', [entry('a')]),
    );
    await writeFragment(
      'b',
      fragment('2026-05-22T10:00:01.000Z', [entry('b')]),
    );
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.buildId).toBe('shared-build');
    expect(result.manifest.tool.name).toBe('qlip');
    expect(result.manifest.defaults.viewport).toEqual({
      width: 1280,
      height: 720,
    });
  });
});

/**
 * Append-only fragments — issues #25 / #26. One file per capture, so
 * the merge is where a run's captures actually become a build.
 */
describe('mergeManifestFragments — append-only fragments', () => {
  const captureFragment = (
    fragmentId: string,
    seq: number,
    entries: QlipManifestEntry[],
    createdAt = '2026-08-15T10:00:00.000Z',
  ): QlipManifestFragment => ({
    ...fragment(createdAt, entries),
    fragmentId,
    fragmentSeq: seq,
  });

  const writeCaptureFragment = async (
    f: QlipManifestFragment,
  ): Promise<void> => {
    await writeFile(
      path.join(
        buildDir,
        MANIFEST_FRAGMENT_DIR,
        fragmentFileName(f.fragmentId as string, f.fragmentSeq as number),
      ),
      JSON.stringify(f),
    );
  };

  it('merges every capture and reports contexts, not file count', async () => {
    // Two contexts of one process, plus a third from a second CI shard
    // sharing the same --build-dir (issue #25's shape).
    await writeCaptureFragment(captureFragment('ctx-a', 1, [entry('a1')]));
    await writeCaptureFragment(captureFragment('ctx-a', 2, [entry('a2')]));
    await writeCaptureFragment(captureFragment('ctx-b', 1, [entry('b1')]));
    await writeCaptureFragment(
      captureFragment('ctx-c', 1, [entry('c1')], '2026-08-15T11:00:00.000Z'),
    );

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');

    expect(result.manifest.entries.map((e) => e.storyId)).toEqual([
      'a1',
      'a2',
      'b1',
      'c1',
    ]);
    expect(result.fragmentCount).toBe(4);
    expect(result.contextCount).toBe(3);
    expect(result.entriesByContext).toEqual({ 'ctx-a': 2, 'ctx-b': 1, 'ctx-c': 1 });
    expect(result.manifest.stats.capturedAuto).toBe(4);
  });

  it('orders a context by fragmentSeq, not by file listing order', async () => {
    // Sequence numbers past 9 are where a naive lexicographic sort
    // breaks; write them out of order to prove the merge does not
    // depend on readdir order.
    for (const seq of [11, 2, 9, 1, 10]) {
      await writeCaptureFragment(
        captureFragment('ctx-a', seq, [entry(`s${String(seq)}`)]),
      );
    }

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries.map((e) => e.storyId)).toEqual([
      's1',
      's2',
      's9',
      's10',
      's11',
    ]);
  });

  it('drops entries retracted by a tombstone, whatever order it merges in', async () => {
    // The error capture is written BEFORE the tombstone that retracts
    // it (attempt 1 failed, the retry passed)...
    await writeCaptureFragment(
      captureFragment('ctx-a', 1, [
        entry('flaky--story', { kind: 'error', screenshotName: 'qlip-auto-error-capture' }),
      ]),
    );
    await writeCaptureFragment({
      ...captureFragment('ctx-a', 2, []),
      tombstones: [{ storyId: 'flaky--story', kind: 'error' }],
    });
    // ...and a second context retracts an error it wrote afterwards,
    // so ordering cannot be what makes this work.
    await writeCaptureFragment({
      ...captureFragment('ctx-b', 1, []),
      tombstones: [{ storyId: 'other--story', kind: 'error' }],
    });
    await writeCaptureFragment(
      captureFragment('ctx-b', 2, [
        entry('other--story', { kind: 'error', screenshotName: 'qlip-auto-error-capture' }),
      ]),
    );
    await writeCaptureFragment(captureFragment('ctx-b', 3, [entry('other--story')]));

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');

    expect(result.manifest.entries.map((e) => e.storyId)).toEqual([
      'other--story',
    ]);
    expect(result.manifest.entries[0].kind).toBe('auto');
    expect(result.retractedCount).toBe(2);
    // Their PNGs may survive on disk (deletion is best-effort), so the
    // paths travel with the result for the partial-build audit.
    expect(result.retractedPaths.sort()).toEqual([
      'stories/auto/flaky--story.png',
      'stories/auto/other--story.png',
    ]);
    // A retracted error must not leave the build looking failed.
    expect(result.manifest.stats.failed).toBe(0);
  });

  it('merges fragments written by an older qlip alongside new ones', async () => {
    // Pre-fix fragments hold a whole manifest and carry no
    // fragmentId/fragmentSeq — a shared build dir can hold both when
    // CI shards run different qlip versions.
    await writeFragment(
      'legacy-context',
      fragment('2026-08-15T09:00:00.000Z', [entry('old1'), entry('old2')]),
    );
    await writeCaptureFragment(captureFragment('ctx-new', 1, [entry('new1')]));

    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries.map((e) => e.storyId)).toEqual([
      'old1',
      'old2',
      'new1',
    ]);
    expect(result.contextCount).toBe(2);
  });

  it('merges a fragment set larger than the read batch size', async () => {
    // A ~1700-story suite writes ~1700 fragments; reads are batched, so
    // cover more than one batch.
    const total = 300;
    for (let i = 0; i < total; i += 1) {
      await writeCaptureFragment(
        captureFragment('ctx-a', i + 1, [entry(`story-${String(i)}`)]),
      );
    }
    const result = await mergeManifestFragments(buildDir);
    if (!result) throw new Error('expected merge result');
    expect(result.manifest.entries).toHaveLength(total);
    expect(result.manifest.stats.capturedAuto).toBe(total);
    expect(result.fragmentCount).toBe(total);
    expect(result.contextCount).toBe(1);
  });
});

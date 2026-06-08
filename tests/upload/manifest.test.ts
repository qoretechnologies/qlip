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
import type {
  QlipManifest,
  QlipManifestEntry,
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
  // same .stories.tsx file twice in one build, producing two
  // (storyId, kind) entries pointing at the same PNG. The server's
  // snapshots table has a unique constraint on (buildId, storyId,
  // kind) and rejects the upload with HTTP 500 if duplicates land in
  // the manifest. The merger MUST dedupe — keeping the LATER entry
  // because that's the post-reopt capture.
  it('dedupes entries with identical (storyId, kind) keeping the LAST seen', async () => {
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
    // (storyId, kind).
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
    // (storyId, kind) is the dedupe key. A story that produced both
    // an auto capture and an error capture must yield TWO rows so
    // the FailureCollection surface can show the error alongside
    // the regular grid entry.
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

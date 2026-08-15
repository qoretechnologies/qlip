/**
 * Post-merge audit of a build directory.
 *
 * A build used to be able to come out partial in total silence: a
 * capture's PNG landed on disk, its manifest record was lost, and the
 * run reported `failed: 0`, so reviewers approved a build believing
 * they had seen the whole suite (issues #25, #26). The append-only
 * fragment scheme removes the mechanism that caused that; this module
 * removes the *silence*, which is the part that let it run for weeks.
 *
 * Two outputs, both cheap enough to run unconditionally:
 *
 * - `capture-report.json` in the build dir — per-context and
 *   per-story-file capture counts, orphans, retractions. The thing you
 *   want when CI has already gone home.
 * - An orphan list — PNGs on disk that no manifest entry references.
 *   Path-independent: it works for the Vitest plugin, the test-runner
 *   and standalone `qlip-upload` alike, because it compares two facts
 *   on disk rather than trusting either producer.
 */

import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { QlipEntryKind, QlipManifest } from '../types.js';
import { censusStoryIds, readStoryCensus } from './census.js';
import type { IQlipStoryCensus } from './census.js';
import type { ISnapshotIdCollision, MergeResult } from './manifest.js';

export const CAPTURE_REPORT_FILE = 'capture-report.json';

/**
 * Two captures of one story that qlip-server resolves to the SAME
 * baseline, because it keys baselines on `(projectId, storyId, kind,
 * viewportKey, branch)` while keying snapshots on `(buildId, storyId,
 * screenshotName)`. The screenshot name is missing from the baseline
 * key, so two `screenshot()` captures of one story at one viewport —
 * both `kind: interaction` — are separate snapshots sharing one
 * baseline image: accepting one sets the baseline for the other, which
 * then diffs against a picture of a different moment.
 *
 * `kind` IS in the baseline key, so a story's auto capture and its
 * `screenshot()` captures do not collide — only same-kind captures do.
 *
 * Distinct from `ISnapshotIdCollision`, which is two captures the
 * server stores as one ROW. This is two rows sharing one BASELINE.
 *
 * qlip cannot fix this from the client — the index lives in
 * qlip-server — so it reports it rather than shipping meaningless
 * diffs in silence.
 */
export interface IBaselineCollision {
  storyId: string;
  /** The capture kind these share — part of the server's baseline key. */
  kind: QlipEntryKind;
  /** `<width>x<height>`, also part of the server's baseline key. */
  viewportKey: string;
  /** Screenshot names competing for that baseline, in capture order. */
  screenshotNames: string[];
}

const SCREENSHOT_ROOT = 'stories';

export interface IQlipCaptureReport {
  buildId: string;
  /** Manifest entries that survived the merge. */
  entries: number;
  /** Fragment files read (one per capture). */
  fragments: number;
  /** Distinct browser contexts / processes that captured anything. */
  contexts: number;
  entriesByContext: Record<string, number>;
  entriesByStoryFile: Record<string, number>;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  /** Entries retracted by the retry-mask prune. */
  retracted: number;
  /**
   * PNGs on disk that no manifest entry points at, and that no
   * tombstone explains. Non-empty means a capture whose manifest
   * record was lost — the bug this audit guards against.
   */
  orphanScreenshots: string[];
  /**
   * PNGs left behind by retracted entries. Expected, not a defect:
   * deleting them is best-effort and no-ops on Vitest versions
   * without a `removeFile` command.
   */
  retractedScreenshots: string[];
  /**
   * Captures that lost a snapshot-id collision — two images of one
   * story competing for one row on the server. Actionable: rename one
   * of the two `screenshot()` calls.
   */
  collisions: ISnapshotIdCollision[];
  /**
   * Captures that will share a baseline server-side. See
   * `IBaselineCollision` — a qlip-server limitation, reported so the
   * diffs it produces are not mistaken for real visual change.
   */
  baselineCollisions: IBaselineCollision[];
  /**
   * Story tests Vitest reported running, or `null` when no census was
   * collected. `null` means UNKNOWN, never zero — see
   * `src/upload/census.ts`.
   */
  storyTestsExecuted: number | null;
  /**
   * Stories that ran and produced no capture of any kind. Only the
   * test runner can see these: they leave no entry and no PNG.
   */
  missingStoryIds: string[];
  /** `missingStoryIds` grouped by the story file that ran them. */
  missingByStoryFile: Record<string, string[]>;
}

/** Recursively collect `stories/**\/*.png`, build-dir-relative, posix. */
const collectScreenshots = async (
  buildDir: string,
  relativeDir: string,
): Promise<string[]> => {
  let dirents;
  try {
    dirents = await readdir(path.join(buildDir, relativeDir), {
      withFileTypes: true,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const found: string[] = [];
  for (const dirent of dirents) {
    const relative = `${relativeDir}/${dirent.name}`;
    if (dirent.isDirectory()) {
      found.push(...(await collectScreenshots(buildDir, relative)));
    } else if (dirent.name.endsWith('.png')) {
      found.push(relative);
    }
  }
  return found;
};

const countBy = <T extends string>(values: T[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

/**
 * Group captured entries by the part of the server's BASELINE identity
 * a single build can vary: `(storyId, kind, viewportKey)`. The server
 * also keys on branch, which is fixed for one build. Any group with
 * more than one member shares a single baseline image there.
 *
 * In practice this only ever flags multiple `screenshot()` captures of
 * one story at one viewport — an auto capture is alone in its kind.
 *
 * `error` captures are excluded: the server skips baseline lookup and
 * diffing for them entirely (see `design/UPLOAD.md`), so they never
 * compete. Non-captured entries have no image and cannot either.
 */
const findBaselineCollisions = (
  manifest: QlipManifest,
): IBaselineCollision[] => {
  const groups = new Map<string, IBaselineCollision>();
  for (const entry of manifest.entries) {
    if (entry.status !== 'captured' || entry.kind === 'error') continue;
    const viewportKey = `${String(entry.viewport.width)}x${String(entry.viewport.height)}`;
    const key = `${entry.storyId}::${entry.kind}::${viewportKey}`;
    const group = groups.get(key);
    if (group) {
      group.screenshotNames.push(entry.screenshotName);
    } else {
      groups.set(key, {
        storyId: entry.storyId,
        kind: entry.kind,
        viewportKey,
        screenshotNames: [entry.screenshotName],
      });
    }
  }
  return [...groups.values()].filter((g) => g.screenshotNames.length > 1);
};

/**
 * Diff the census against the captures. Only `auto` entries count: a
 * story test produces exactly one auto entry (captured, skipped or
 * failed), while manual and error entries are extras that would
 * otherwise mask a gap.
 */
const diffCensus = (
  manifest: QlipManifest,
  census: IQlipStoryCensus | undefined,
): Pick<
  IQlipCaptureReport,
  'storyTestsExecuted' | 'missingStoryIds' | 'missingByStoryFile'
> => {
  if (!census) {
    return {
      storyTestsExecuted: null,
      missingStoryIds: [],
      missingByStoryFile: {},
    };
  }
  const executed = censusStoryIds(census);
  const captured = new Set(
    manifest.entries.filter((e) => e.kind === 'auto').map((e) => e.storyId),
  );
  const missingByStoryFile: Record<string, string[]> = {};
  const missingStoryIds: string[] = [];
  for (const [moduleId, storyIds] of Object.entries(census.byModule)) {
    const missing = storyIds.filter((id) => !captured.has(id)).sort();
    if (missing.length === 0) continue;
    missingByStoryFile[moduleId] = missing;
    missingStoryIds.push(...missing);
  }
  return {
    storyTestsExecuted: executed.size,
    missingStoryIds: missingStoryIds.sort(),
    missingByStoryFile,
  };
};

export const buildCaptureReport = async (
  buildDir: string,
  merged: MergeResult,
  census: IQlipStoryCensus | undefined = readStoryCensus(),
): Promise<IQlipCaptureReport> => {
  const manifest: QlipManifest = merged.manifest;
  const referenced = new Set(manifest.entries.map((entry) => entry.path));
  const retracted = new Set(merged.retractedPaths);
  // A collision loser is unreferenced too, but it is not a LOST
  // capture — it is a named conflict with its own message.
  const collided = new Set(merged.collisions.map((c) => c.droppedPath));
  const onDisk = await collectScreenshots(buildDir, SCREENSHOT_ROOT);

  const byStoryFile: Record<string, number> = {};
  for (const entry of manifest.entries) {
    const key = entry.storyFilePath ?? '<unknown>';
    byStoryFile[key] = (byStoryFile[key] ?? 0) + 1;
  }

  return {
    buildId: manifest.buildId,
    entries: manifest.entries.length,
    fragments: merged.fragmentCount,
    contexts: merged.contextCount,
    entriesByContext: merged.entriesByContext,
    entriesByStoryFile: byStoryFile,
    byKind: countBy(manifest.entries.map((entry) => entry.kind)),
    byStatus: countBy(manifest.entries.map((entry) => entry.status)),
    retracted: merged.retractedCount,
    orphanScreenshots: onDisk
      .filter(
        (file) =>
          !referenced.has(file) && !retracted.has(file) && !collided.has(file),
      )
      .sort(),
    retractedScreenshots: onDisk.filter((file) => retracted.has(file)).sort(),
    collisions: merged.collisions,
    baselineCollisions: findBaselineCollisions(manifest),
    ...diffCensus(manifest, census),
  };
};

export const writeCaptureReport = async (
  buildDir: string,
  report: IQlipCaptureReport,
): Promise<void> => {
  await writeFile(
    path.join(buildDir, CAPTURE_REPORT_FILE),
    JSON.stringify(report, null, 2),
    'utf-8',
  );
};

/**
 * One-line human summary of captures that will share a baseline, or
 * `null` when none do.
 *
 * Reported once per build rather than per story: it is one upstream
 * limitation, not N defects, and a per-story warning would fire for
 * every story that takes a `screenshot()` — the exact crying-wolf that
 * makes a warning worth ignoring.
 */
export const describeBaselineCollisions = (
  report: IQlipCaptureReport,
  exampleCount = 3,
): string | null => {
  const { baselineCollisions: groups } = report;
  if (groups.length === 0) return null;
  const captures = groups.reduce((n, g) => n + g.screenshotNames.length, 0);
  const examples = groups
    .slice(0, exampleCount)
    .map((g) => `${g.storyId} ${g.kind}@${g.viewportKey} (${g.screenshotNames.join(', ')})`)
    .join('; ');
  const more =
    groups.length > exampleCount
      ? `; +${String(groups.length - exampleCount)} more`
      : '';
  return `${String(captures)} captures across ${String(groups.length)} stor${groups.length === 1 ? 'y' : 'ies'} will share a baseline on the server, which keys baselines by (story, kind, viewport) and not by screenshot name — their diffs are not meaningful until that is fixed server-side. Affected: ${examples}${more}.`;
};

/**
 * One-line human summary of stories that ran without capturing, or
 * `null` when there are none — or when no census was collected, which
 * is not the same thing and must never read as total loss.
 *
 * Advisory by design: a story can legitimately disable its own auto
 * capture with `parameters.qlip.auto = false`, and that override is
 * invisible from the runner's side, so this names names and leaves the
 * judgement to a human.
 */
export const describeMissingCaptures = (
  report: IQlipCaptureReport,
  exampleCount = 5,
): string | null => {
  const { missingStoryIds, storyTestsExecuted } = report;
  if (storyTestsExecuted === null || missingStoryIds.length === 0) return null;
  const examples = missingStoryIds.slice(0, exampleCount).join(', ');
  const more =
    missingStoryIds.length > exampleCount
      ? `, +${String(missingStoryIds.length - exampleCount)} more`
      : '';
  const files = Object.keys(report.missingByStoryFile).length;
  return `${String(missingStoryIds.length)} of ${String(storyTestsExecuted)} story tests produced no capture, across ${String(files)} story file${files === 1 ? '' : 's'} (${examples}${more}). Expected if those stories set qlip.auto = false; otherwise they were lost. See ${CAPTURE_REPORT_FILE} in the build dir.`;
};

/**
 * One-line human summary of snapshot-id collisions, or `null` when
 * there are none. Distinct from a partial build: nothing was lost to a
 * bug, two captures simply cannot share one snapshot id.
 */
export const describeCollisions = (
  report: IQlipCaptureReport,
  exampleCount = 3,
): string | null => {
  const { collisions } = report;
  if (collisions.length === 0) return null;
  const examples = collisions
    .slice(0, exampleCount)
    .map((c) => `${c.storyId} "${c.screenshotName}" (dropped ${c.droppedPath})`)
    .join(', ');
  const more =
    collisions.length > exampleCount
      ? `, +${String(collisions.length - exampleCount)} more`
      : '';
  return `${String(collisions.length)} capture${collisions.length === 1 ? '' : 's'} dropped — two captures of one story share a screenshot name, and qlip-server stores one snapshot per (story, screenshot name). Rename one: ${examples}${more}.`;
};

/**
 * One-line human summary of a partial build, or `null` when every PNG
 * on disk is accounted for. Names a few examples — "3 screenshots are
 * missing" without saying which is a bug report nobody can action.
 */
export const describePartialBuild = (
  report: IQlipCaptureReport,
  exampleCount = 3,
): string | null => {
  const orphans = report.orphanScreenshots;
  if (orphans.length === 0) return null;
  const examples = orphans.slice(0, exampleCount).join(', ');
  const more =
    orphans.length > exampleCount
      ? `, +${String(orphans.length - exampleCount)} more`
      : '';
  return `${String(orphans.length)} screenshot${orphans.length === 1 ? '' : 's'} on disk ${orphans.length === 1 ? 'is' : 'are'} missing from the manifest — this build is PARTIAL (${examples}${more}). See ${CAPTURE_REPORT_FILE} in the build dir.`;
};

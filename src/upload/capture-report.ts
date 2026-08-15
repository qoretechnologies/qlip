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
import type { QlipManifest } from '../types.js';
import type { MergeResult } from './manifest.js';

export const CAPTURE_REPORT_FILE = 'capture-report.json';

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

export const buildCaptureReport = async (
  buildDir: string,
  merged: MergeResult,
): Promise<IQlipCaptureReport> => {
  const manifest: QlipManifest = merged.manifest;
  const referenced = new Set(manifest.entries.map((entry) => entry.path));
  const retracted = new Set(merged.retractedPaths);
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
      .filter((file) => !referenced.has(file) && !retracted.has(file))
      .sort(),
    retractedScreenshots: onDisk.filter((file) => retracted.has(file)).sort(),
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

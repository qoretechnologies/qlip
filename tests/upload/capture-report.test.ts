/**
 * Unit tests for the post-merge build audit.
 *
 * The bug behind issues #25 / #26 ran for weeks because a build that
 * lost captures was indistinguishable from a smaller suite: no error,
 * no warning, `failed: 0`. These tests cover the check that makes that
 * impossible — comparing the PNGs on disk against the manifest that
 * claims to describe them.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_REPORT_FILE,
  buildCaptureReport,
  describeBaselineCollisions,
  describeCollisions,
  describeMissingCaptures,
  describePartialBuild,
  writeCaptureReport,
} from '../../src/upload/capture-report.js';
import type { IQlipStoryCensus } from '../../src/upload/census.js';
import type {
  ISnapshotIdCollision,
  MergeResult,
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
  storyFilePath: 'src/components/Button.stories.tsx',
  screenshotName: 'auto',
  path: `stories/auto/${id}.png`,
  viewport: { width: 1280, height: 720 },
  status: 'captured',
  error: null,
  timings: { ms: 10 },
  ...overrides,
});

const mergeResult = (
  entries: QlipManifestEntry[],
  retractedPaths: string[] = [],
  collisions: ISnapshotIdCollision[] = [],
): MergeResult => {
  const manifest: QlipManifest = {
    tool: { name: 'qlip', version: '0.1.0' },
    buildId: 'build-1',
    createdAt: '2026-08-15T10:00:00.000Z',
    outputDir: buildDir,
    defaults,
    stats: {
      storiesTotal: entries.length,
      capturedAuto: entries.filter((e) => e.kind === 'auto').length,
      capturedManual: entries.filter((e) => e.kind === 'manual').length,
      skipped: 0,
      failed: 0,
      durationMs: 100,
    },
    entries,
  };
  return {
    manifest,
    fragmentCount: entries.length,
    contextCount: 1,
    entriesByContext: { 'ctx-a': entries.length },
    retractedCount: retractedPaths.length,
    retractedPaths,
    collisions,
  };
};

const writePng = async (relative: string): Promise<void> => {
  const target = path.join(buildDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'not-really-a-png');
};

beforeEach(async () => {
  buildDir = await mkdtemp(path.join(tmpdir(), 'qlip-report-test-'));
});

afterEach(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

describe('buildCaptureReport', () => {
  it('flags screenshots on disk that no manifest entry references', async () => {
    // What a lost manifest record looks like from the outside: the PNG
    // is there, nothing points at it.
    await writePng('stories/auto/kept--story.png');
    await writePng('stories/auto/lost--story.png');
    await writePng('stories/error/lost--story--qlip-auto-error-capture.png');

    const report = await buildCaptureReport(
      buildDir,
      mergeResult([entry('kept--story')]),
    );

    expect(report.orphanScreenshots).toEqual([
      'stories/auto/lost--story.png',
      'stories/error/lost--story--qlip-auto-error-capture.png',
    ]);
    expect(describePartialBuild(report)).toContain('PARTIAL');
    expect(describePartialBuild(report)).toContain('stories/auto/lost--story.png');
  });

  it('stays quiet when every screenshot is accounted for', async () => {
    await writePng('stories/auto/a--one.png');
    await writePng('stories/manual/a--one--step-1.png');

    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
        entry('a--one'),
        entry('a--one', {
          kind: 'manual',
          screenshotName: 'step-1',
          path: 'stories/manual/a--one--step-1.png',
        }),
      ]),
    );

    expect(report.orphanScreenshots).toEqual([]);
    expect(describePartialBuild(report)).toBeNull();
  });

  it('reports per-context and per-story-file counts for diagnosis', async () => {
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
        entry('a--one'),
        entry('b--two', { storyFilePath: 'src/views/Page.stories.tsx' }),
        entry('c--three', { kind: 'error', status: 'failed' }),
      ]),
    );

    expect(report.entriesByContext).toEqual({ 'ctx-a': 3 });
    expect(report.entriesByStoryFile).toEqual({
      'src/components/Button.stories.tsx': 2,
      'src/views/Page.stories.tsx': 1,
    });
    expect(report.byKind).toEqual({ auto: 2, error: 1 });
    expect(report.byStatus).toEqual({ captured: 2, failed: 1 });
  });

  it('does not call a retracted error capture an orphan', async () => {
    // The retry-mask prune retracts the error entry and deletes its
    // PNG best-effort — a no-op on Vitest versions with no removeFile
    // command. Treating the leftover as a lost capture would make
    // every retry-flaky suite warn that its build is partial.
    await writePng('stories/auto/flaky--story.png');
    await writePng('stories/error/flaky--story--qlip-auto-error-capture.png');

    const report = await buildCaptureReport(
      buildDir,
      mergeResult(
        [entry('flaky--story')],
        ['stories/error/flaky--story--qlip-auto-error-capture.png'],
      ),
    );

    expect(report.orphanScreenshots).toEqual([]);
    expect(report.retractedScreenshots).toEqual([
      'stories/error/flaky--story--qlip-auto-error-capture.png',
    ]);
    expect(describePartialBuild(report)).toBeNull();
  });

  it('treats a build with no screenshot directory as complete, not partial', async () => {
    // A skip-only run captures nothing; that is not a lost capture.
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([entry('a--one', { status: 'skipped' })]),
    );
    expect(report.orphanScreenshots).toEqual([]);
    expect(describePartialBuild(report)).toBeNull();
  });

  it('reports a snapshot-id collision instead of calling it a lost capture', async () => {
    // A manual screenshot named "auto" lands on the same server
    // snapshot id as the story's auto capture, so only one image can
    // survive. That is a naming conflict the author can fix — not the
    // silent loss the partial-build warning is about.
    await writePng('stories/auto/clash--story.png');
    await writePng('stories/manual/clash--story--auto.png');

    const report = await buildCaptureReport(
      buildDir,
      mergeResult([entry('clash--story')], [], [
        {
          storyId: 'clash--story',
          screenshotName: 'auto',
          keptPath: 'stories/auto/clash--story.png',
          droppedPath: 'stories/manual/clash--story--auto.png',
        },
      ]),
    );

    expect(report.orphanScreenshots).toEqual([]);
    expect(describePartialBuild(report)).toBeNull();
    const message = describeCollisions(report);
    expect(message).toContain('clash--story');
    expect(message).toContain('stories/manual/clash--story--auto.png');
  });

  it('names stories that ran and captured nothing', async () => {
    // The only loss no other signal can see: no entry, no PNG, so the
    // orphan check has nothing to compare and the manifest simply
    // looks shorter.
    const census: IQlipStoryCensus = {
      byModule: {
        '/src/Button.stories.ts': ['button--primary', 'button--ghost'],
        '/src/Page.stories.tsx': ['page--home'],
      },
    };

    const report = await buildCaptureReport(
      buildDir,
      mergeResult([entry('button--primary'), entry('page--home')]),
      census,
    );

    expect(report.storyTestsExecuted).toBe(3);
    expect(report.missingStoryIds).toEqual(['button--ghost']);
    expect(report.missingByStoryFile).toEqual({
      '/src/Button.stories.ts': ['button--ghost'],
    });
    const message = describeMissingCaptures(report);
    expect(message).toContain('1 of 3 story tests produced no capture');
    expect(message).toContain('button--ghost');
  });

  it('does not let a manual capture stand in for a missing auto capture', async () => {
    // A story test yields exactly one auto entry; counting manual or
    // error entries as proof of capture would hide the gap.
    const census: IQlipStoryCensus = {
      byModule: { '/src/Page.stories.tsx': ['page--flow'] },
    };

    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'step-1',
          path: 'stories/manual/page--flow--step-1.png',
        }),
      ]),
      census,
    );

    expect(report.missingStoryIds).toEqual(['page--flow']);
  });

  it('counts a skipped story as captured — it was recorded, not lost', async () => {
    const census: IQlipStoryCensus = {
      byModule: { '/src/Page.stories.tsx': ['page--skipped'] },
    };

    const report = await buildCaptureReport(
      buildDir,
      mergeResult([entry('page--skipped', { status: 'skipped' })]),
      census,
    );

    expect(report.missingStoryIds).toEqual([]);
    expect(describeMissingCaptures(report)).toBeNull();
  });

  it('reports UNKNOWN rather than total loss when no census was collected', async () => {
    // On Vitest 2 in workspace mode the reporter can be lifecycle-dead
    // and the globalSetup teardown finalizes instead. Reading that as
    // "every story is missing" would make the warning worthless.
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([entry('a--one')]),
      undefined,
    );

    expect(report.storyTestsExecuted).toBeNull();
    expect(report.missingStoryIds).toEqual([]);
    expect(describeMissingCaptures(report)).toBeNull();
  });

  it('reports same-kind captures that will share a baseline on the server', async () => {
    // qlip-server keys snapshots by (story, screenshotName) but
    // baselines by (story, kind, viewport, branch) — the screenshot
    // name is missing there, so two screenshot() captures of one story
    // are separate rows sharing one baseline image.
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
        entry('page--flow'),
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
        entry('quiet--story'),
      ]),
    );

    // The auto capture is NOT in the group: `kind` is part of the
    // server's baseline key, so it has a baseline of its own.
    expect(report.baselineCollisions).toEqual([
      {
        storyId: 'page--flow',
        kind: 'manual',
        viewportKey: '1280x720',
        screenshotNames: ['step-1', 'step-2'],
      },
    ]);
    const message = describeBaselineCollisions(report);
    expect(message).toContain('2 captures across 1 story');
    expect(message).toContain('page--flow manual@1280x720');
  });

  it('does not flag a story that has one auto and one manual capture', async () => {
    // The common shape for anyone using screenshot(). The server keys
    // baselines by kind, so these two do not compete — flagging them
    // would fire on nearly every consumer that takes a manual capture.
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
        entry('page--flow'),
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'after-login',
          path: 'stories/manual/page--flow--after-login.png',
        }),
      ]),
    );

    expect(report.baselineCollisions).toEqual([]);
    expect(describeBaselineCollisions(report)).toBeNull();
  });

  it('does not count captures at different viewports as sharing a baseline', async () => {
    // The viewport IS part of the server's baseline key, so a story
    // captured at two sizes legitimately has two baselines.
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'desktop',
          path: 'stories/manual/page--flow--desktop.png',
        }),
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'mobile',
          path: 'stories/manual/page--flow--mobile.png',
          viewport: { width: 390, height: 844 },
        }),
      ]),
    );

    expect(report.baselineCollisions).toEqual([]);
    expect(describeBaselineCollisions(report)).toBeNull();
  });

  it('ignores error captures, which the server never diffs', async () => {
    // Error snapshots skip baseline lookup entirely (design/UPLOAD.md),
    // so even two of them for one story never compete for a baseline.
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
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

    expect(report.baselineCollisions).toEqual([]);
    expect(describeBaselineCollisions(report)).toBeNull();
  });

  it('ignores skipped captures, which have no image to compare', async () => {
    const report = await buildCaptureReport(
      buildDir,
      mergeResult([
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'step-1',
          path: 'stories/manual/page--flow--step-1.png',
        }),
        entry('page--flow', {
          kind: 'manual',
          screenshotName: 'step-2',
          path: 'stories/manual/page--flow--step-2.png',
          status: 'skipped',
        }),
      ]),
    );

    expect(report.baselineCollisions).toEqual([]);
  });

  it('writes the report next to the manifest', async () => {
    const report = await buildCaptureReport(buildDir, mergeResult([entry('a--one')]));
    await writeCaptureReport(buildDir, report);

    const written = JSON.parse(
      await readFile(path.join(buildDir, CAPTURE_REPORT_FILE), 'utf-8'),
    ) as typeof report;
    expect(written.buildId).toBe('build-1');
    expect(written.entries).toBe(1);
    expect(written.contexts).toBe(1);
  });
});

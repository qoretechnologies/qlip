import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const e2e = test.runIf(process.env.QLIP_E2E === '1');

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

e2e('captures auto and manual screenshots with manifest entries', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qlip-e2e-'));
  const vitestEntry = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

  await execFileAsync(
    process.execPath,
    [
      vitestEntry,
      'run',
      '--config',
      'vitest.config.ts',
      '--project',
      'storybook',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        QLIP_OUTPUT_DIR: outputRoot,
        QLIP_E2E: '0',
      },
    },
  );

  const buildDirs = (await fs.readdir(outputRoot)).filter(
    (entry) => !entry.startsWith('.'),
  );
  expect(buildDirs.length).toBeGreaterThan(0);

  buildDirs.sort();
  const buildId = buildDirs[buildDirs.length - 1];
  const buildDir = path.join(outputRoot, buildId);
  const manifestPath = path.join(buildDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  const autoEntry = manifest.entries.find(
    (entry: { kind: string; status: string }) =>
      entry.kind === 'auto' && entry.status === 'captured',
  );
  const manualEntry = manifest.entries.find(
    (entry: { kind: string; status: string }) =>
      entry.kind === 'manual' && entry.status === 'captured',
  );

  expect(autoEntry).toBeTruthy();
  expect(manualEntry).toBeTruthy();
  if (!autoEntry || !manualEntry) {
    throw new Error('Expected auto and manual screenshot entries.');
  }

  await fs.access(path.join(buildDir, autoEntry.path));
  await fs.access(path.join(buildDir, manualEntry.path));

  // Capture sizes, read from the PNGs. The headless browser window is
  // 1280×720 and Vitest scales the test iframe down to fit it, so without
  // `fullSizeCaptures` a larger viewport comes back shrunk — the size such
  // captures have always had, kept by default so no baseline moves. With it,
  // the window grows and the capture is exactly the viewport. `fullPage`
  // (Example/TallPage: the column scrolls ~2,900px of sections behind a phone
  // viewport) always grows the window, and captures the whole column at 1:1.
  // The manifest keeps the pinned viewport as the baseline key throughout.
  const pngSize = async (relativePath: string) => {
    const header = await fs.readFile(path.join(buildDir, relativePath));
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  };
  const entryFor = (storyId: string) => {
    const entry = manifest.entries.find(
      (candidate: { storyId: string; kind: string }) =>
        candidate.storyId === storyId && candidate.kind === 'auto',
    );
    if (!entry) throw new Error(`no auto entry for ${storyId}`);
    return entry as { path: string; status: string; viewport: { width: number; height: number } };
  };
  const fullPage = entryFor('example-tallpage--scrolls-an-inner-box');
  const oneScreen = entryFor('example-tallpage--one-screen');
  const oneScreenFullSize = entryFor('example-tallpage--one-screen-full-size');
  const desktopFullSize = entryFor('example-page--desktop-full-size');
  expect(fullPage.status).toBe('captured');
  expect(fullPage.viewport).toEqual({ width: 390, height: 844 });
  expect(oneScreen.viewport).toEqual({ width: 390, height: 844 });
  expect(await pngSize(oneScreen.path)).toEqual({ width: 333, height: 720 });
  expect(oneScreenFullSize.viewport).toEqual({ width: 390, height: 844 });
  expect(await pngSize(oneScreenFullSize.path)).toEqual({ width: 390, height: 844 });
  expect(desktopFullSize.viewport).toEqual({ width: 1920, height: 1080 });
  expect(await pngSize(desktopFullSize.path)).toEqual({ width: 1920, height: 1080 });
  const grown = await pngSize(fullPage.path);
  expect(grown.width).toBe(390);
  expect(grown.height).toBeGreaterThanOrEqual(56 + 12 * 240);
  expect(grown.height).toBeLessThan(56 + 12 * 240 + 100);
  // A fixed-height box (a code block) never grows with the viewport, so the
  // growth it asked for is given back: one screen, not a strip of blank.
  expect(await pngSize(entryFor('example-tallpage--fixed-height-box').path)).toEqual({
    width: 390,
    height: 844,
  });
});

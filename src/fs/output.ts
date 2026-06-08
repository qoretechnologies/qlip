import { QlipManifest, QlipResolvedDefaults } from '../types.js';

export const TOOL_NAME = 'qlip';

export const DEFAULT_OUTPUT_DIR = './qlip/screenshots';
export const AUTO_ERROR_SCREENSHOT_BASE = 'qlip-auto-error-capture';
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
/**
 * Per-browser-context manifest fragments live in this subdirectory of
 * the build dir. The Node-side merger in `src/upload/manifest.ts`
 * consolidates them into the final `manifest.json` once tests are
 * done. Defined here (not in upload/) so the browser runtime can
 * reference it without pulling node:fs/path into the browser bundle.
 */
export const MANIFEST_FRAGMENT_DIR = 'manifest-fragments';

export const generateBuildId = (date: Date = new Date()): string => {
  const pad = (num: number): string => String(num).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
};

export const sanitizeSegment = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9_.-]/g, '_');

export const joinPath = (...parts: string[]): string => {
  const normalized = parts
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/\\/g, '/'));

  if (normalized.length === 0) {
    return '';
  }

  let result = normalized[0];
  for (let index = 1; index < normalized.length; index += 1) {
    const part = normalized[index].replace(/^\/+/, '');
    result = result.replace(/\/+$/, '');
    result = `${result}/${part}`;
  }
  return result;
};

const splitStoryId = (storyId: string) => {
  const [titlePart, namePart] = storyId.split('--');
  return {
    titlePart: titlePart || storyId,
    namePart: namePart || undefined,
  };
};

const buildStoryBaseName = ({
  storyTitle,
  storyName,
  storyId,
}: {
  storyTitle?: string;
  storyName?: string;
  storyId: string;
}) => {
  const { titlePart, namePart } = splitStoryId(storyId);
  const resolvedTitle = storyTitle ?? titlePart;
  const resolvedName =
    storyName && storyName !== 'storyFn' ? storyName : namePart ?? storyId;
  const safeTitle = sanitizeSegment(resolvedTitle);
  const safeName = sanitizeSegment(resolvedName);
  return `${safeTitle}--${safeName}`;
};

const buildKindDir = (kind: 'auto' | 'manual' | 'error') =>
  joinPath('stories', kind);

export const buildAutoScreenshotPath = ({
  buildDir,
  storyId,
  storyTitle,
  storyName,
}: {
  buildDir: string;
  storyId: string;
  storyTitle?: string;
  storyName?: string;
}) => {
  const baseName = buildStoryBaseName({ storyTitle, storyName, storyId });
  const relativePath = `${buildKindDir('auto')}/${baseName}.png`;
  return {
    relativePath,
    absolutePath: joinPath(buildDir, relativePath),
  };
};

export const buildManualScreenshotPath = ({
  buildDir,
  storyId,
  storyTitle,
  storyName,
  screenshotName,
}: {
  buildDir: string;
  storyId: string;
  storyTitle?: string;
  storyName?: string;
  screenshotName: string;
}) => {
  const baseName = buildStoryBaseName({ storyTitle, storyName, storyId });
  const safeName = sanitizeSegment(screenshotName);
  const kind = safeName.startsWith(AUTO_ERROR_SCREENSHOT_BASE)
    ? 'error'
    : 'manual';
  const relativePath = `${buildKindDir(kind)}/${baseName}--${safeName}.png`;
  return {
    safeName,
    relativePath,
    absolutePath: joinPath(buildDir, relativePath),
  };
};

const buildLogKindDir = (kind: 'auto' | 'manual' | 'error') =>
  joinPath('logs', kind);

export const buildAutoLogPath = ({
  buildDir,
  storyId,
  storyTitle,
  storyName,
}: {
  buildDir: string;
  storyId: string;
  storyTitle?: string;
  storyName?: string;
}) => {
  const baseName = buildStoryBaseName({ storyTitle, storyName, storyId });
  const relativePath = `${buildLogKindDir('auto')}/${baseName}.json`;
  return {
    relativePath,
    absolutePath: joinPath(buildDir, relativePath),
  };
};

export const buildManualLogPath = ({
  buildDir,
  storyId,
  storyTitle,
  storyName,
  screenshotName,
}: {
  buildDir: string;
  storyId: string;
  storyTitle?: string;
  storyName?: string;
  screenshotName: string;
}) => {
  const baseName = buildStoryBaseName({ storyTitle, storyName, storyId });
  const safeName = sanitizeSegment(screenshotName);
  const kind = safeName.startsWith(AUTO_ERROR_SCREENSHOT_BASE)
    ? 'error'
    : 'manual';
  const relativePath = `${buildLogKindDir(kind)}/${baseName}--${safeName}.json`;
  return {
    relativePath,
    absolutePath: joinPath(buildDir, relativePath),
  };
};

export const createManifest = ({
  buildId,
  outputDir,
  defaults,
  tool,
  createdAt = new Date(),
}: {
  buildId: string;
  outputDir: string;
  defaults: QlipResolvedDefaults;
  tool: { name: string; version: string };
  createdAt?: Date;
}): QlipManifest => ({
  tool,
  buildId,
  createdAt: createdAt.toISOString(),
  outputDir,
  defaults,
  stats: {
    storiesTotal: 0,
    capturedAuto: 0,
    capturedManual: 0,
    skipped: 0,
    failed: 0,
    durationMs: 0,
  },
  entries: [],
});

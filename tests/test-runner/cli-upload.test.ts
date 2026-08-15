/**
 * Unit tests for `qlip-upload` CLI's `runUpload` programmatic API.
 *
 * Strategy: build a tmp directory shaped like a real qlip build
 * (manifest-fragments/*.json + stories/auto/*.png), then call
 * `runUpload([])` with env vars pointing at it + a mock fetch as
 * the upload sink. Assert on the exit code, the recorded POST,
 * and the merged manifest.json that lands on disk after merge.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runUpload } from '../../src/test-runner/cli/upload.js';
import { MANIFEST_FRAGMENT_DIR } from '../../src/fs/output.js';
import type { QlipManifest } from '../../src/types.js';

let tmpRoot: string;
let originalFetch: typeof globalThis.fetch;
let recordedRequests: Array<{ url: string; method: string; bodyText: string }>;
/**
 * When set, the mock returns this for EVERY request (used by the
 * failure tests to make the create phase fail). When null, the mock
 * plays the real v2 server: create echoes the manifest's missing
 * blob keys, blob PUTs + finalize succeed.
 */
let forcedResponse: Response | null;

/** Stub fetch so the v2 upload flow is served locally. */
const installFetch = (): void => {
  recordedRequests = [];
  forcedResponse = null;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? 'GET';
    const bodyText =
      init?.body instanceof FormData
        ? '[form-data]'
        : typeof init?.body === 'string'
          ? init.body
          : '';
    recordedRequests.push({ url, method, bodyText });

    if (forcedResponse) return Promise.resolve(forcedResponse.clone());

    const pathname = new URL(url).pathname;
    // Phase 1: create — echo buildId + every captured entry's hash.
    if (method === 'POST' && pathname === '/api/builds') {
      const parsed = JSON.parse(bodyText) as { manifest: QlipManifest };
      const missing = parsed.manifest.entries
        .filter((e) => e.status === 'captured')
        .map((e) => e.sha256 ?? '');
      return Promise.resolve(
        new Response(
          JSON.stringify({ buildId: parsed.manifest.buildId, missing }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    // Phase 2: blob PUT.
    if (method === 'PUT' && pathname.includes('/blobs/')) {
      return Promise.resolve(
        new Response(JSON.stringify({ result: 'stored' }), { status: 201 }),
      );
    }
    // Phase 3: finalize.
    if (method === 'POST' && pathname.endsWith('/finalize')) {
      return Promise.resolve(
        new Response(JSON.stringify({ build: { id: 'ok' }, snapshots: [] }), {
          status: 201,
        }),
      );
    }
    return Promise.resolve(new Response('unrouted', { status: 404 }));
  }) as typeof globalThis.fetch;
};

const restoreFetch = (): void => {
  globalThis.fetch = originalFetch;
};

/** Reset the process-global finalize flag between tests so each
 * run goes through finalize again (otherwise idempotent guard
 * skips the second test). */
const resetFinalizeFlag = (): void => {
  const FINALIZE_FLAG = Symbol.for(
    '@qoretechnologies/qlip/__finalized__',
  );
  delete (globalThis as Record<symbol, boolean | undefined>)[FINALIZE_FLAG];
};

/**
 * Lay down a fake build directory with one fragment + the PNG it
 * references. Mirrors what `qlipCapture` writes during a real run.
 */
const seedBuildDir = async (root: string, buildId: string): Promise<string> => {
  const buildDir = path.join(root, buildId);
  await mkdir(path.join(buildDir, MANIFEST_FRAGMENT_DIR), { recursive: true });
  await mkdir(path.join(buildDir, 'stories', 'auto'), { recursive: true });

  const fragment: QlipManifest = {
    tool: { name: 'qlip', version: '0.1.0' },
    buildId,
    createdAt: new Date().toISOString(),
    outputDir: buildDir,
    defaults: {
      outputDir: './qlip/screenshots',
      viewport: { width: 1280, height: 720 },
      skip: false,
      disableAnimations: false,
      pauseAnimationsAtEnd: false,
      captureOnError: false,
      waitForIdleMs: 300,
      maxWaitForIdleMs: 2000,
      ignoreElements: [],
      auto: true,
      manual: true,
      error: true,
      captureConsole: false,
      captureConsoleLevels: ['error'],
      maxConsoleLogs: 50,
      consoleLogExcludePatterns: [],
    },
    stats: {
      storiesTotal: 1,
      capturedAuto: 1,
      capturedManual: 0,
      skipped: 0,
      failed: 0,
      durationMs: 500,
    },
    entries: [
      {
        kind: 'auto',
        storyId: 'button--primary',
        storyTitle: 'Button',
        storyName: 'Primary',
        screenshotName: 'auto',
        path: 'stories/auto/Button--Primary.png',
        viewport: { width: 1280, height: 720 },
        status: 'captured',
        error: null,
        timings: { ms: 100 },
      },
    ],
  };
  await writeFile(
    path.join(buildDir, MANIFEST_FRAGMENT_DIR, 'frag-1.json'),
    JSON.stringify(fragment),
    'utf-8',
  );
  // 1x1 transparent PNG body — bytes are not what we're testing,
  // we just need the file to exist for uploadBuild to read.
  await writeFile(
    path.join(buildDir, 'stories', 'auto', 'Button--Primary.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return buildDir;
};

beforeEach(async () => {
  resetFinalizeFlag();
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'qlip-upload-cli-'));
  originalFetch = globalThis.fetch;
  installFetch();
});

afterEach(async () => {
  restoreFetch();
  resetFinalizeFlag();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('runUpload', () => {
  it('falls back to the hosted default when --server-url is missing', async () => {
    const buildDir = await seedBuildDir(tmpRoot, '20991231-235959');
    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(
      [],
      { QLIP_OUTPUT_DIR: tmpRoot },
      { log, error },
    );
    expect(result.exitCode).toBe(0);
    expect(result.buildDir).toBe(buildDir);
    // v2: first request is create at the hosted instance, last is finalize.
    expect(recordedRequests[0].url).toBe(
      'https://qlip.qoretechnologies.com/api/builds',
    );
    expect(recordedRequests.at(-1)?.url).toMatch(/\/finalize$/);
  });

  it('shows help with exit 0 on --help', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(['--help'], {}, { log, error });
    expect(result.exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('qlip-upload'),
    );
  });

  it('rejects unknown flags with exit 1', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(['--bogus'], {}, { log, error });
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown option'),
    );
  });

  it('rejects with exit 1 when output dir does not exist', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(
      [],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: '/nonexistent/qlip/screenshots',
      },
      { log, error },
    );
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('No builds found'),
    );
  });

  it('rejects with exit 1 when output dir is empty (no builds)', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(
      [],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: tmpRoot,
      },
      { log, error },
    );
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('No builds found'),
    );
  });

  it('merges fragments + POSTs to the right URL on the happy path', async () => {
    const buildDir = await seedBuildDir(tmpRoot, '20991231-235959');
    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(
      [],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: tmpRoot,
        QLIP_PROJECT: 'unit-test-project',
      },
      { log, error },
    );

    expect(result.exitCode).toBe(0);
    expect(result.buildDir).toBe(buildDir);

    // v2 three-phase flow: create → blob PUT → finalize.
    expect(recordedRequests[0].url).toBe('http://localhost:3100/api/builds');
    expect(recordedRequests[0].method).toBe('POST');
    expect(recordedRequests.some((r) => r.url.includes('/blobs/'))).toBe(true);
    expect(recordedRequests.at(-1)?.url).toMatch(/\/finalize$/);

    // The merge writes manifest.json to the buildDir.
    const manifestText = await readFile(
      path.join(buildDir, 'manifest.json'),
      'utf-8',
    );
    const manifest = JSON.parse(manifestText) as QlipManifest;
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].storyId).toBe('button--primary');

    // Success log is emitted.
    expect(log).not.toHaveBeenCalled(); // finalize uses console directly
  });

  it('picks the latest build directory by mtime', async () => {
    await seedBuildDir(tmpRoot, '20240101-000000');
    // Bump mtime by writing the second build after a measurable delay.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newerBuildDir = await seedBuildDir(tmpRoot, '20991231-000000');

    const result = await runUpload(
      [],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: tmpRoot,
      },
      { log: vi.fn(), error: vi.fn() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.buildDir).toBe(newerBuildDir);
  });

  it('honours --build-dir over auto-pick', async () => {
    const oldBuild = await seedBuildDir(tmpRoot, '20240101-000000');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await seedBuildDir(tmpRoot, '20991231-000000');

    const result = await runUpload(
      ['--build-dir', oldBuild],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: tmpRoot,
      },
      { log: vi.fn(), error: vi.fn() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.buildDir).toBe(oldBuild);
  });

  it('CLI flags override env vars', async () => {
    await seedBuildDir(tmpRoot, '20991231-000000');

    await runUpload(
      [
        '--server-url',
        'http://override.example.com',
        '--project',
        'flag-project',
      ],
      {
        QLIP_UPLOAD_URL: 'http://from-env.example.com',
        QLIP_OUTPUT_DIR: tmpRoot,
        QLIP_PROJECT: 'env-project',
      },
      { log: vi.fn(), error: vi.fn() },
    );

    expect(recordedRequests[0].url).toBe(
      'http://override.example.com/api/builds',
    );
  });

  it('exit 0 by default when upload fails (logs but doesn\'t fail)', async () => {
    await seedBuildDir(tmpRoot, '20991231-000000');
    forcedResponse = new Response('boom', { status: 500 });

    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(
      [],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: tmpRoot,
      },
      { log, error },
    );

    // Default behaviour: log + exit 0 (finalize wrote to stderr,
    // not to our captured `error` mock, since `failOnUploadError`
    // is false).
    expect(result.exitCode).toBe(0);
  });

  it('exit 2 with --fail-on-upload-error when upload fails', async () => {
    await seedBuildDir(tmpRoot, '20991231-000000');
    forcedResponse = new Response('boom', { status: 500 });

    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(
      ['--fail-on-upload-error'],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: tmpRoot,
      },
      { log, error },
    );

    expect(result.exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('qlip-upload'),
    );
  });

  it('silent no-op (exit 0) when buildDir has no fragments', async () => {
    const buildDir = path.join(tmpRoot, '20991231-000000');
    await mkdir(buildDir, { recursive: true });
    // No manifest-fragments/ at all.

    const log = vi.fn();
    const error = vi.fn();
    const result = await runUpload(
      [],
      {
        QLIP_UPLOAD_URL: 'http://localhost:3100',
        QLIP_OUTPUT_DIR: tmpRoot,
      },
      { log, error },
    );

    expect(result.exitCode).toBe(0);
    expect(recordedRequests).toHaveLength(0);
  });
});

/**
 * Partial-build detection — issues #25 / #26. A CI run that lost
 * manifest records used to upload and exit 0, so nobody found out
 * until a reviewer noticed the build was small.
 */
describe('runUpload — partial builds', () => {
  /** Add a PNG that no manifest entry references. */
  const orphanScreenshot = async (buildDir: string): Promise<void> => {
    await writeFile(
      path.join(buildDir, 'stories', 'auto', 'Lost--Story.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  };

  it('warns and still uploads when screenshots are missing from the manifest', async () => {
    const buildDir = await seedBuildDir(tmpRoot, '20991231-235959');
    await orphanScreenshot(buildDir);
    const log = vi.fn();
    const error = vi.fn();

    const result = await runUpload(
      ['--build-dir', buildDir, '--server-url', 'http://localhost:3100'],
      {},
      { log, error },
    );

    // Uploading anyway is deliberate: seeing which stories DID land is
    // how a partial build gets diagnosed.
    expect(result.exitCode).toBe(0);
    expect(
      recordedRequests.some((r) => r.url.endsWith('/api/builds')),
    ).toBe(true);
    const report = JSON.parse(
      await readFile(path.join(buildDir, 'capture-report.json'), 'utf-8'),
    ) as { orphanScreenshots: string[] };
    expect(report.orphanScreenshots).toEqual(['stories/auto/Lost--Story.png']);
  });

  it('exits 2 with --fail-on-partial-build when screenshots are missing', async () => {
    const buildDir = await seedBuildDir(tmpRoot, '20991231-235959');
    await orphanScreenshot(buildDir);

    const result = await runUpload(
      [
        '--build-dir',
        buildDir,
        '--server-url',
        'http://localhost:3100',
        '--fail-on-partial-build',
      ],
      {},
      { log: vi.fn(), error: vi.fn() },
    );

    expect(result.exitCode).toBe(2);
  });

  it('exits 0 with --fail-on-partial-build when nothing is missing', async () => {
    const buildDir = await seedBuildDir(tmpRoot, '20991231-235959');

    const result = await runUpload(
      [
        '--build-dir',
        buildDir,
        '--server-url',
        'http://localhost:3100',
        '--fail-on-partial-build',
      ],
      {},
      { log: vi.fn(), error: vi.fn() },
    );

    expect(result.exitCode).toBe(0);
  });
});

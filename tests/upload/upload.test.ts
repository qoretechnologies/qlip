/**
 * Unit tests for uploadBuild — the three-phase v2 protocol
 * (create → blob PUTs → finalize), plus the legacy multipart
 * fallback when the server lacks the v2 routes. Driven against a
 * scripted mock fetch; no real qlip-server.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QlipUploadError, uploadBuild } from '../../src/upload/upload.js';
import type { QlipManifest } from '../../src/types.js';

let workDir: string;

// A minimal but valid PNG body (8-byte signature + filler). Distinct
// content per call so different stories get different hashes.
const pngBytes = (seed: number): Buffer =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed & 0xff]);

const sha256 = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex');

interface IRecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Mock fetch that routes by method+path to scripted responses and
 * records every call. Bodies are kept raw (FormData | string |
 * Uint8Array) so individual tests can assert on whichever shape they
 * care about.
 */
const scriptedFetch = (
  routes: {
    create?: (req: IRecordedRequest) => Response | Promise<Response>;
    blob?: (
      req: IRecordedRequest,
      key: string,
    ) => Response | Promise<Response>;
    finalize?: (req: IRecordedRequest) => Response | Promise<Response>;
    legacy?: (req: IRecordedRequest) => Response | Promise<Response>;
  },
): { fetchImpl: typeof fetch; calls: IRecordedRequest[] } => {
  const calls: IRecordedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers as Record<string, string> | undefined;
    if (initHeaders) {
      for (const [k, v] of Object.entries(initHeaders)) headers[k] = v;
    }
    const method = init?.method ?? 'GET';
    const recorded: IRecordedRequest = {
      url,
      method,
      headers,
      body: init?.body,
    };
    calls.push(recorded);

    const u = new URL(url);
    // Filtered segments: ['api', 'builds', <buildId>, 'blobs'|'finalize', <key>?]
    const segments = u.pathname.split('/').filter(Boolean);
    if (method === 'POST' && u.pathname === '/api/builds/upload') {
      if (!routes.legacy) throw new Error('unexpected legacy POST');
      return Promise.resolve(routes.legacy(recorded));
    }
    if (method === 'POST' && u.pathname === '/api/builds') {
      if (!routes.create) return Promise.resolve(new Response('no route', { status: 404 }));
      return Promise.resolve(routes.create(recorded));
    }
    if (method === 'PUT' && segments[1] === 'builds' && segments[3] === 'blobs') {
      const key = segments[4] ?? '';
      if (!routes.blob) throw new Error('unexpected blob PUT');
      return Promise.resolve(routes.blob(recorded, key));
    }
    if (method === 'POST' && segments[1] === 'builds' && segments[3] === 'finalize') {
      if (!routes.finalize) throw new Error('unexpected finalize');
      return Promise.resolve(routes.finalize(recorded));
    }
    throw new Error(`unrouted ${method} ${url}`);
  };
  return { fetchImpl, calls };
};

const manifest = (over: Partial<QlipManifest> = {}): QlipManifest => ({
  tool: { name: 'qlip', version: '0.2.0' },
  buildId: 'test-build-001',
  createdAt: '2026-06-11T10:00:00.000Z',
  outputDir: './qlip',
  defaults: {
    outputDir: './qlip',
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
  },
  stats: {
    storiesTotal: 1,
    capturedAuto: 1,
    capturedManual: 0,
    skipped: 0,
    failed: 0,
    durationMs: 100,
  },
  entries: [
    {
      kind: 'auto',
      storyId: 'button--primary',
      storyTitle: 'Example/Button',
      storyName: 'Primary',
      screenshotName: 'auto',
      path: 'stories/auto/Example_Button--Primary.png',
      viewport: { width: 1280, height: 720 },
      status: 'captured',
      error: null,
      timings: { ms: 25 },
    },
  ],
  ...over,
});

/**
 * Write a build dir: manifest.json + a PNG per captured entry. The
 * PNG bytes are seeded by entry index so each entry hashes distinctly.
 * Returns a `{ path → bytes }` map so tests can assert on hashes.
 */
const seedBuildDir = async (
  m: QlipManifest,
): Promise<{ dir: string; bytesByPath: Map<string, Buffer> }> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qlip-upload-test-'));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  const bytesByPath = new Map<string, Buffer>();
  let i = 0;
  for (const entry of m.entries) {
    if (entry.status !== 'captured') continue;
    const bytes = pngBytes(i++);
    bytesByPath.set(entry.path, bytes);
    const absPath = path.join(dir, entry.path);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, bytes);
  }
  return { dir, bytesByPath };
};

/** create responder that echoes the manifest's buildId + a missing list. */
const createOk =
  (missing: (m: QlipManifest) => string[]) =>
  (req: IRecordedRequest): Response => {
    const parsed = JSON.parse(req.body as string) as {
      manifest: QlipManifest;
    };
    return new Response(
      JSON.stringify({
        buildId: parsed.manifest.buildId,
        missing: missing(parsed.manifest),
      }),
      { status: 201 },
    );
  };

const finalizeOk = (): Response =>
  new Response(
    JSON.stringify({ build: { id: 'test-build-001' }, snapshots: [] }),
    { status: 201 },
  );

beforeEach(() => {
  workDir = '';
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('uploadBuild — v2 happy path', () => {
  it('creates with per-entry sha256, PUTs only missing blobs, then finalizes', async () => {
    const seeded = await seedBuildDir(manifest());
    workDir = seeded.dir;
    const expectedKey = sha256(
      seeded.bytesByPath.get('stories/auto/Example_Button--Primary.png')!,
    );

    const { fetchImpl, calls } = scriptedFetch({
      create: createOk((m) => m.entries.map((e) => e.sha256!)),
      blob: (_req, key) =>
        new Response(JSON.stringify({ key, result: 'stored' }), {
          status: 201,
        }),
      finalize: () => finalizeOk(),
    });

    const result = await uploadBuild({
      buildDir: workDir,
      options: {
        serverUrl: 'http://localhost:3100',
        project: 'smoke',
        branch: 'main',
        commit: 'abc1234',
      },
      fetchImpl,
    });

    expect(result.protocol).toBe('v2');
    expect(result.buildId).toBe('test-build-001');
    expect(result.status).toBe(201);
    expect(result.blobsUploaded).toBe(1);
    expect(result.blobsTotal).toBe(1);

    // Phase 1: create with manifest carrying the content hash + fields.
    const create = calls[0];
    expect(create.method).toBe('POST');
    expect(create.url).toBe('http://localhost:3100/api/builds');
    const createBody = JSON.parse(create.body as string) as {
      manifest: QlipManifest;
      project: string;
      branch: string;
      commit: string;
    };
    expect(createBody.project).toBe('smoke');
    expect(createBody.branch).toBe('main');
    expect(createBody.commit).toBe('abc1234');
    expect(createBody.manifest.entries[0].sha256).toBe(expectedKey);
    expect(createBody.manifest.entries[0].sizeBytes).toBe(
      seeded.bytesByPath.get('stories/auto/Example_Button--Primary.png')!
        .byteLength,
    );

    // Phase 2: PUT the missing blob at its content-addressed URL.
    const put = calls[1];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(
      `http://localhost:3100/api/builds/test-build-001/blobs/${expectedKey}`,
    );
    expect((put.headers['Content-Type'] ?? '').toString()).toBe('image/png');

    // Phase 3: finalize.
    const finalize = calls[2];
    expect(finalize.method).toBe('POST');
    expect(finalize.url).toBe(
      'http://localhost:3100/api/builds/test-build-001/finalize',
    );
  });

  it('skips the transfer phase entirely on a warm cache (missing: [])', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk(() => []),
      finalize: () => finalizeOk(),
    });

    const result = await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });

    expect(result.blobsUploaded).toBe(0);
    expect(result.blobsTotal).toBe(1);
    // Only create + finalize — no PUTs.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('uploads one blob for screenshots that share identical content (dedup by key)', async () => {
    const dup = manifest({
      entries: [
        {
          kind: 'auto',
          storyId: 'a--one',
          storyName: 'One',
          screenshotName: 'auto',
          path: 'stories/auto/a--one.png',
          viewport: { width: 1280, height: 720 },
          status: 'captured',
          error: null,
          timings: { ms: 10 },
        },
        {
          kind: 'auto',
          storyId: 'b--two',
          storyName: 'Two',
          screenshotName: 'auto',
          path: 'stories/auto/b--two.png',
          viewport: { width: 1280, height: 720 },
          status: 'captured',
          error: null,
          timings: { ms: 10 },
        },
      ],
    });
    // Seed both files with identical bytes so they hash the same.
    const dir = await mkdtemp(path.join(tmpdir(), 'qlip-upload-dup-'));
    workDir = dir;
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(dup));
    const shared = pngBytes(7);
    for (const e of dup.entries) {
      const abs = path.join(dir, e.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, shared);
    }

    const { fetchImpl, calls } = scriptedFetch({
      // Server dedups: even though two entries reference the key, it
      // lists the single key once.
      create: createOk((m) => [...new Set(m.entries.map((e) => e.sha256!))]),
      blob: (_req, key) =>
        new Response(JSON.stringify({ key, result: 'stored' }), {
          status: 201,
        }),
      finalize: () => finalizeOk(),
    });

    const result = await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });

    expect(result.blobsTotal).toBe(1); // one distinct content key
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain(`/blobs/${sha256(shared)}`);
  });

  it('attaches the bearer token to every phase', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk((m) => m.entries.map((e) => e.sha256!)),
      blob: (_req, key) =>
        new Response(JSON.stringify({ key, result: 'stored' }), {
          status: 201,
        }),
      finalize: () => finalizeOk(),
    });
    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100', uploadToken: 'secret' },
      fetchImpl,
    });
    for (const call of calls) {
      expect(call.headers['Authorization']).toBe('Bearer secret');
    }
  });

  it('defaults project to "default" and omits Authorization when no token', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk(() => []),
      finalize: () => finalizeOk(),
    });
    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });
    const createBody = JSON.parse(calls[0].body as string) as {
      project: string;
    };
    expect(createBody.project).toBe('default');
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });

  it('uses the hosted instance when serverUrl is omitted', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk(() => []),
      finalize: () => finalizeOk(),
    });
    await uploadBuild({ buildDir: workDir, options: {}, fetchImpl });
    expect(calls[0].url).toBe('https://qlip.qoretechnologies.com/api/builds');
  });

  it('includes baseBranch + ancestorCommits as native JSON when present', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk(() => []),
      finalize: () => finalizeOk(),
    });
    await uploadBuild({
      buildDir: workDir,
      options: {
        serverUrl: 'http://localhost:3100',
        baseBranch: 'develop',
        ancestorCommits: ['aaa111', 'bbb222'],
      },
      fetchImpl,
    });
    const createBody = JSON.parse(calls[0].body as string) as {
      baseBranch: string;
      ancestorCommits: string[];
    };
    expect(createBody.baseBranch).toBe('develop');
    expect(createBody.ancestorCommits).toEqual(['aaa111', 'bbb222']);
  });

  it('includes pullRequestUrl in the create body when present', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk(() => []),
      finalize: () => finalizeOk(),
    });
    await uploadBuild({
      buildDir: workDir,
      options: {
        serverUrl: 'http://localhost:3100',
        pullRequestUrl: 'https://github.com/owner/repo/pull/123',
      },
      fetchImpl,
    });
    const createBody = JSON.parse(calls[0].body as string) as {
      pullRequestUrl: string;
    };
    expect(createBody.pullRequestUrl).toBe(
      'https://github.com/owner/repo/pull/123',
    );
  });

  it('omits baseBranch + ancestorCommits + pullRequestUrl from the create body when absent', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk(() => []),
      finalize: () => finalizeOk(),
    });
    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });
    const createBody = JSON.parse(calls[0].body as string) as Record<
      string,
      unknown
    >;
    expect('baseBranch' in createBody).toBe(false);
    expect('ancestorCommits' in createBody).toBe(false);
    expect('pullRequestUrl' in createBody).toBe(false);
  });
});

describe('uploadBuild — retry + error handling', () => {
  it('retries a blob on a 5xx and succeeds', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    let attempts = 0;
    const { fetchImpl, calls } = scriptedFetch({
      create: createOk((m) => m.entries.map((e) => e.sha256!)),
      blob: (_req, key) => {
        attempts += 1;
        if (attempts === 1) return new Response('boom', { status: 503 });
        return new Response(JSON.stringify({ key, result: 'stored' }), {
          status: 201,
        });
      },
      finalize: () => finalizeOk(),
    });

    const result = await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
      retryBaseDelayMs: 0,
    });

    expect(result.protocol).toBe('v2');
    expect(attempts).toBe(2);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('does NOT retry a blob on a 4xx (deterministic) and throws', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    let attempts = 0;
    const { fetchImpl } = scriptedFetch({
      create: createOk((m) => m.entries.map((e) => e.sha256!)),
      blob: () => {
        attempts += 1;
        return new Response(
          JSON.stringify({ error: { code: 'BLOB_HASH_MISMATCH' } }),
          { status: 400, statusText: 'Bad Request' },
        );
      },
      finalize: () => finalizeOk(),
    });

    await expect(
      uploadBuild({
        buildDir: workDir,
        options: { serverUrl: 'http://localhost:3100' },
        fetchImpl,
        retryBaseDelayMs: 0,
      }),
    ).rejects.toMatchObject({ phase: 'blob', status: 400 });
    expect(attempts).toBe(1);
  });

  it('throws a create-phase QlipUploadError on a non-2xx create', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl } = scriptedFetch({
      create: () =>
        new Response(
          JSON.stringify({ error: { code: 'DUPLICATE_BUILD' } }),
          { status: 409, statusText: 'Conflict' },
        ),
    });
    await expect(
      uploadBuild({
        buildDir: workDir,
        options: { serverUrl: 'http://localhost:3100' },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ phase: 'create', status: 409 });
  });

  it('throws a finalize-phase error when finalize reports incomplete', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    const { fetchImpl } = scriptedFetch({
      create: createOk(() => []),
      finalize: () =>
        new Response(
          JSON.stringify({ error: { code: 'UPLOAD_INCOMPLETE', missing: [] } }),
          { status: 409, statusText: 'Conflict' },
        ),
    });
    await expect(
      uploadBuild({
        buildDir: workDir,
        options: { serverUrl: 'http://localhost:3100' },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ phase: 'finalize', status: 409 });
  });
});

describe('uploadBuild — legacy fallback', () => {
  it('falls back to multipart POST /api/builds/upload when create 404s', async () => {
    const seeded = await seedBuildDir(manifest());
    workDir = seeded.dir;
    let legacyBody: FormData | undefined;

    const { fetchImpl, calls } = scriptedFetch({
      // No `create` route → mock returns 404, triggering fallback.
      legacy: (req) => {
        legacyBody = req.body as FormData;
        return new Response('{}', { status: 201 });
      },
    });

    const result = await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100', project: 'legacy-proj' },
      fetchImpl,
    });

    expect(result.protocol).toBe('legacy');
    expect(result.buildId).toBe('test-build-001');
    // create attempt (404) then the legacy multipart POST.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/builds',
      'POST /api/builds/upload',
    ]);
    const names = Array.from(legacyBody!.entries()).map(([k]) => k);
    expect(names).toContain('manifest');
    expect(names).toContain(
      'screenshots[stories/auto/Example_Button--Primary.png]',
    );
    expect(legacyBody!.get('project')).toBe('legacy-proj');
  });

  it('sends baseBranch as a plain field and ancestorCommits as a JSON string', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    let legacyBody: FormData | undefined;

    const { fetchImpl } = scriptedFetch({
      legacy: (req) => {
        legacyBody = req.body as FormData;
        return new Response('{}', { status: 201 });
      },
    });

    await uploadBuild({
      buildDir: workDir,
      options: {
        serverUrl: 'http://localhost:3100',
        baseBranch: 'develop',
        ancestorCommits: ['aaa111', 'bbb222'],
      },
      fetchImpl,
    });

    expect(legacyBody!.get('baseBranch')).toBe('develop');
    const raw = legacyBody!.get('ancestorCommits');
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw as string)).toEqual(['aaa111', 'bbb222']);
  });

  it('omits baseBranch + ancestorCommits from the legacy form when absent', async () => {
    workDir = (await seedBuildDir(manifest())).dir;
    let legacyBody: FormData | undefined;

    const { fetchImpl } = scriptedFetch({
      legacy: (req) => {
        legacyBody = req.body as FormData;
        return new Response('{}', { status: 201 });
      },
    });

    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });

    expect(legacyBody!.has('baseBranch')).toBe(false);
    expect(legacyBody!.has('ancestorCommits')).toBe(false);
  });
});

describe('QlipUploadError', () => {
  it('is exported and carries status + phase', () => {
    const err = new QlipUploadError(413, 'Payload Too Large', 'big', 'blob');
    expect(err).toBeInstanceOf(QlipUploadError);
    expect(err.status).toBe(413);
    expect(err.phase).toBe('blob');
    expect(err.message).toContain('MAX_FILE_SIZE_MB');
  });
});

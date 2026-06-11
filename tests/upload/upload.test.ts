/**
 * Unit tests for uploadBuild — exercises the multipart construction
 * + fetch invocation against a recording mock fetch. We don't need a
 * real qlip-server here; we assert on the request shape.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QlipUploadError,
  uploadBuild,
  type QlipUploadInput,
} from '../../src/upload/upload.js';
import type { QlipManifest } from '../../src/types.js';

let workDir: string;

interface IRecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: FormData;
}

const recordingFetch = (
  responder: (req: IRecordedRequest) => Response | Promise<Response>,
): {
  fetchImpl: typeof fetch;
  calls: IRecordedRequest[];
} => {
  const calls: IRecordedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;

    const headers: Record<string, string> = {};
    const initHeaders = init?.headers as Record<string, string> | undefined;
    if (initHeaders) {
      for (const [k, v] of Object.entries(initHeaders)) headers[k] = v;
    }
    const body = init?.body;
    if (!(body instanceof FormData)) {
      throw new Error('Expected body to be FormData');
    }
    const recorded: IRecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
    };
    calls.push(recorded);
    return Promise.resolve(responder(recorded));
  };
  return { fetchImpl, calls };
};

const manifest = (over: Partial<QlipManifest> = {}): QlipManifest => ({
  tool: { name: 'qlip', version: '0.1.0' },
  buildId: 'test-build-001',
  createdAt: '2026-05-22T10:00:00.000Z',
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

const seedBuildDir = async (m: QlipManifest): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qlip-upload-test-'));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  for (const entry of m.entries) {
    if (entry.status !== 'captured') continue;
    const absPath = path.join(dir, entry.path);
    await mkdir(path.dirname(absPath), { recursive: true });
    // Tiny PNG header (the server validates magic bytes; this content
    // doesn't have to be a real PNG since we never feed it through a
    // real qlip-server in this test).
    await writeFile(absPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return dir;
};

beforeEach(() => {
  workDir = '';
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('uploadBuild', () => {
  it('POSTs to /api/builds/upload with correctly-formed multipart', async () => {
    workDir = await seedBuildDir(manifest());

    const { fetchImpl, calls } = recordingFetch(() => {
      return new Response(
        JSON.stringify({ build: { id: 'test-build-001' }, snapshots: [] }),
        { status: 201 },
      );
    });

    const input: QlipUploadInput = {
      buildDir: workDir,
      options: {
        serverUrl: 'http://localhost:3100',
        project: 'smoke',
        branch: 'main',
        commit: 'abc1234',
      },
      fetchImpl,
    };
    const result = await uploadBuild(input);

    expect(result.buildId).toBe('test-build-001');
    expect(result.status).toBe(201);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected one recorded call');
    expect(call.url).toBe('http://localhost:3100/api/builds/upload');
    expect(call.method).toBe('POST');

    // Multipart shape.
    const fields = Array.from(call.body.entries());
    const fieldNames = fields.map(([k]) => k);
    expect(fieldNames).toContain('manifest');
    expect(fieldNames).toContain(
      'screenshots[stories/auto/Example_Button--Primary.png]',
    );
    expect(fieldNames).toContain('project');
    expect(fieldNames).toContain('branch');
    expect(fieldNames).toContain('commit');

    // Text-field values.
    expect(call.body.get('project')).toBe('smoke');
    expect(call.body.get('branch')).toBe('main');
    expect(call.body.get('commit')).toBe('abc1234');
  });

  it('attaches the bearer token when uploadToken is set', async () => {
    workDir = await seedBuildDir(manifest());
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('{}', { status: 201 }),
    );
    await uploadBuild({
      buildDir: workDir,
      options: {
        serverUrl: 'http://localhost:3100',
        uploadToken: 'secret-token',
      },
      fetchImpl,
    });
    expect(calls[0]?.headers['Authorization']).toBe('Bearer secret-token');
  });

  it('omits the Authorization header when uploadToken is empty', async () => {
    workDir = await seedBuildDir(manifest());
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('{}', { status: 201 }),
    );
    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });
    expect(calls[0]?.headers['Authorization']).toBeUndefined();
  });

  it('defaults project to "default"', async () => {
    workDir = await seedBuildDir(manifest());
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('{}', { status: 201 }),
    );
    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });
    expect(calls[0]?.body.get('project')).toBe('default');
  });

  it('skips failed/skipped entries in the multipart body', async () => {
    workDir = await seedBuildDir(
      manifest({
        entries: [
          {
            kind: 'auto',
            storyId: 'a--ok',
            storyName: 'OK',
            screenshotName: 'auto',
            path: 'stories/auto/a--ok.png',
            viewport: { width: 1280, height: 720 },
            status: 'captured',
            error: null,
            timings: { ms: 10 },
          },
          {
            kind: 'auto',
            storyId: 'b--bad',
            storyName: 'Bad',
            screenshotName: 'auto',
            path: 'stories/auto/b--bad.png',
            viewport: { width: 1280, height: 720 },
            status: 'failed',
            error: { message: 'boom' },
            timings: { ms: 5 },
          },
        ],
      }),
    );

    const { fetchImpl, calls } = recordingFetch(
      () => new Response('{}', { status: 201 }),
    );
    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100' },
      fetchImpl,
    });

    const call = calls[0];
    if (!call) throw new Error('expected one recorded call');
    const fieldNames = Array.from(call.body.entries()).map(([k]) => k);
    expect(fieldNames).toContain('screenshots[stories/auto/a--ok.png]');
    expect(fieldNames).not.toContain('screenshots[stories/auto/b--bad.png]');
  });

  it('throws QlipUploadError on non-2xx', async () => {
    workDir = await seedBuildDir(manifest());
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'DUPLICATE_BUILD', message: 'exists' } }),
          { status: 409, statusText: 'Conflict' },
        ),
    );
    await expect(
      uploadBuild({
        buildDir: workDir,
        options: { serverUrl: 'http://localhost:3100' },
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(QlipUploadError);
  });

  it('strips a trailing slash from serverUrl', async () => {
    workDir = await seedBuildDir(manifest());
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('{}', { status: 201 }),
    );
    await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: 'http://localhost:3100/' },
      fetchImpl,
    });
    expect(calls[0]?.url).toBe('http://localhost:3100/api/builds/upload');
  });
});

describe('default server URL', () => {
  it('uploads to the hosted instance when serverUrl is omitted', async () => {
    workDir = await seedBuildDir(manifest());
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('{}', { status: 201 }),
    );
    await uploadBuild({
      buildDir: workDir,
      options: {},
      fetchImpl,
    });
    expect(calls[0]?.url).toBe(
      'https://qlip.qoretechnologies.com/api/builds/upload',
    );
  });
});

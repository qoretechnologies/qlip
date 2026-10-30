/**
 * Tests for the node:http transport behind finalize / legacy upload, and
 * for uploadBuild's default wiring onto it — driven against a real local
 * HTTP server, since the point of the transport is how it behaves on the
 * wire.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchAwaitingProcessing } from '../../src/upload/processing-request.js';
import { uploadBuild } from '../../src/upload/upload.js';
import type { QlipManifest } from '../../src/types.js';

interface IReceived {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

type THandler = (
  req: IncomingMessage,
  res: ServerResponse,
  received: IReceived,
) => void;

let server: Server | undefined;
let workDir = '';

/** Start a server that buffers each request body, then calls `handler`. */
const serve = async (
  handler: THandler,
): Promise<{ baseUrl: string; received: IReceived[] }> => {
  const received: IReceived[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const entry: IReceived = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      received.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(port)}`, received };
};

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
  }
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = '';
  }
});

/** Resolves once the server has received `count` requests. */
const requestsReceived = (
  received: IReceived[],
  count: number,
): Promise<void> =>
  new Promise((resolve) => {
    const check = (): void => {
      if (received.length >= count) {
        server?.off('request', onRequest);
        resolve();
      }
    };
    const onRequest = (req: IncomingMessage): void => {
      req.on('end', () => {
        setImmediate(check);
      });
    };
    server?.on('request', onRequest);
    check();
  });

describe('fetchAwaitingProcessing', () => {
  it('POSTs headers with an empty body and returns the response status, text, headers and body', async () => {
    const { baseUrl, received } = await serve((_req, res) => {
      res.writeHead(201, 'Created', {
        'content-type': 'application/json',
        'set-cookie': ['a=1', 'b=2'],
      });
      res.end(JSON.stringify({ build: { id: 'b1' }, snapshots: [] }));
    });

    const response = await fetchAwaitingProcessing(
      `${baseUrl}/api/builds/b1/finalize`,
      { method: 'POST', headers: { Authorization: 'Bearer test-token' } },
    );

    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.json()).toEqual({
      build: { id: 'b1' },
      snapshots: [],
    });

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('POST');
    expect(received[0].url).toBe('/api/builds/b1/finalize');
    expect(received[0].headers['authorization']).toBe('Bearer test-token');
    expect(received[0].headers['content-length']).toBe('0');
    expect(received[0].headers['transfer-encoding']).toBeUndefined();
    expect(received[0].body.byteLength).toBe(0);
  });

  it('waits for a response the server sends only after it finishes processing', async () => {
    let release: (() => void) | undefined;
    const { baseUrl, received } = await serve((_req, res) => {
      release = () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"done":true}');
      };
    });

    const pending = fetchAwaitingProcessing(`${baseUrl}/finalize`, {
      method: 'POST',
    });
    await requestsReceived(received, 1);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    release?.();
    const response = await pending;
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"done":true}');
  });

  it('passes an error status and body through without throwing', async () => {
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(409, 'Conflict', { 'content-type': 'application/json' });
      res.end('{"error":{"code":"BUILD_ALREADY_FINALIZED"}}');
    });
    const response = await fetchAwaitingProcessing(`${baseUrl}/finalize`, {
      method: 'POST',
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(409);
    expect(response.statusText).toBe('Conflict');
    expect(await response.text()).toContain('BUILD_ALREADY_FINALIZED');
  });

  it('returns a null body for a 204', async () => {
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const response = await fetchAwaitingProcessing(`${baseUrl}/x`, {
      method: 'POST',
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('serializes a FormData body as multipart with its boundary', async () => {
    const { baseUrl, received } = await serve((_req, res) => {
      res.writeHead(201);
      res.end('{}');
    });
    const form = new FormData();
    form.append('project', 'p1');
    form.append(
      'screenshots[stories/auto/A--B.png]',
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
        type: 'image/png',
      }),
      'A--B.png',
    );

    await fetchAwaitingProcessing(`${baseUrl}/api/builds/upload`, {
      method: 'POST',
      body: form,
    });

    const contentType = received[0].headers['content-type'] ?? '';
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(received[0].headers['content-length']).toBe(
      String(received[0].body.byteLength),
    );
    // Parse it back the way a server would.
    const parsed = await new Response(new Uint8Array(received[0].body), {
      headers: { 'content-type': contentType },
    }).formData();
    expect(parsed.get('project')).toBe('p1');
    const file = parsed.get('screenshots[stories/auto/A--B.png]');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('A--B.png');
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('keeps an explicit content-type over the one the body encoding implies', async () => {
    const { baseUrl, received } = await serve((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await fetchAwaitingProcessing(`${baseUrl}/x`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(received[0].method).toBe('PUT');
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].body.toString('utf-8')).toBe('{"a":1}');
  });

  it('rejects with the abort reason when the signal fires before the response', async () => {
    const { baseUrl, received } = await serve(() => {
      // Never answer.
    });
    const controller = new AbortController();
    const pending = fetchAwaitingProcessing(`${baseUrl}/finalize`, {
      method: 'POST',
      signal: controller.signal,
    });
    await requestsReceived(received, 1);
    controller.abort(new Error('deadline'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects without sending when the signal has already fired', async () => {
    const { baseUrl, received } = await serve((_req, res) => {
      res.end();
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchAwaitingProcessing(`${baseUrl}/finalize`, {
        method: 'POST',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toHaveLength(0);
  });

  it('rejects when the server drops the connection without answering', async () => {
    const { baseUrl } = await serve((req) => {
      req.socket.destroy();
    });
    await expect(
      fetchAwaitingProcessing(`${baseUrl}/finalize`, { method: 'POST' }),
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('rejects when the connection drops part-way through the body', async () => {
    const { baseUrl } = await serve((req, res) => {
      res.writeHead(201, { 'content-length': '100' });
      res.write('{"partial":', () => {
        req.socket.destroy();
      });
    });
    await expect(
      fetchAwaitingProcessing(`${baseUrl}/finalize`, { method: 'POST' }),
    ).rejects.toThrow();
  });

  it('rejects when nothing listens at the URL', async () => {
    const { baseUrl } = await serve(() => undefined);
    server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
    await expect(
      fetchAwaitingProcessing(`${baseUrl}/finalize`, { method: 'POST' }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('speaks TLS for an https URL', async () => {
    // A plain-HTTP listener can't complete a TLS handshake, so reaching
    // it over https proves the https transport was chosen.
    const { baseUrl } = await serve((_req, res) => {
      res.end();
    });
    await expect(
      fetchAwaitingProcessing(baseUrl.replace('http:', 'https:'), {
        method: 'POST',
      }),
    ).rejects.toThrow();
  });

  it('rejects an unsupported protocol', async () => {
    await expect(
      fetchAwaitingProcessing('ftp://example.com/finalize', {
        method: 'POST',
      }),
    ).rejects.toThrow('unsupported protocol: ftp:');
  });

  it('rejects an invalid URL', async () => {
    await expect(
      fetchAwaitingProcessing('not a url', { method: 'POST' }),
    ).rejects.toThrow(TypeError);
  });
});

const seedBuild = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qlip-processing-test-'));
  const entryPath = 'stories/auto/Example_Button--Primary.png';
  const m = {
    tool: { name: 'qlip', version: '0.2.0' },
    buildId: 'wire-build-001',
    createdAt: '2026-10-30T10:00:00.000Z',
    outputDir: './qlip',
    stats: {
      storiesTotal: 1,
      capturedAuto: 1,
      capturedManual: 0,
      skipped: 0,
      failed: 0,
      durationMs: 1,
    },
    entries: [
      {
        kind: 'auto',
        storyId: 'button--primary',
        storyTitle: 'Example/Button',
        storyName: 'Primary',
        screenshotName: 'auto',
        path: entryPath,
        viewport: { width: 1280, height: 720 },
        status: 'captured',
        error: null,
        timings: { ms: 1 },
      },
    ],
  } as unknown as QlipManifest;
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
  await mkdir(path.join(dir, 'stories', 'auto'), { recursive: true });
  await writeFile(
    path.join(dir, entryPath),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  );
  return dir;
};

describe('uploadBuild — default transport against a real server', () => {
  it('runs create + blob over fetch and waits on finalize over node:http', async () => {
    workDir = await seedBuild();
    let releaseFinalize: (() => void) | undefined;
    const { baseUrl, received } = await serve((req, res, entry) => {
      if (req.url === '/api/builds') {
        const body = JSON.parse(entry.body.toString('utf-8')) as {
          manifest: QlipManifest;
        };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            buildId: body.manifest.buildId,
            missing: body.manifest.entries.map((e) => e.sha256),
          }),
        );
        return;
      }
      if (req.url?.includes('/blobs/') === true) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"result":"stored"}');
        return;
      }
      releaseFinalize = () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"build":{"id":"wire-build-001"},"snapshots":[]}');
      };
    });

    const upload = uploadBuild({
      buildDir: workDir,
      options: { serverUrl: baseUrl, uploadToken: 'test-token' },
    });
    await requestsReceived(received, 3);
    releaseFinalize?.();
    const result = await upload;

    expect(result).toMatchObject({
      buildId: 'wire-build-001',
      status: 201,
      protocol: 'v2',
      blobsUploaded: 1,
    });
    expect(
      received.map((r) => `${r.method} ${r.url.split('/blobs/')[0]}`),
    ).toEqual([
      'POST /api/builds',
      'PUT /api/builds/wire-build-001',
      'POST /api/builds/wire-build-001/finalize',
    ]);
    const finalize = received[2];
    expect(finalize.headers['authorization']).toBe('Bearer test-token');
    expect(finalize.headers['content-length']).toBe('0');
  });

  it('sends the legacy multipart upload over node:http when the server lacks v2', async () => {
    workDir = await seedBuild();
    const { baseUrl, received } = await serve((req, res) => {
      if (req.url === '/api/builds') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"build":{"id":"wire-build-001"},"snapshots":[]}');
    });

    const result = await uploadBuild({
      buildDir: workDir,
      options: { serverUrl: baseUrl, project: 'legacy-proj' },
    });

    expect(result.protocol).toBe('legacy');
    const legacy = received[1];
    expect(legacy.url).toBe('/api/builds/upload');
    const form = await new Response(new Uint8Array(legacy.body), {
      headers: { 'content-type': legacy.headers['content-type'] ?? '' },
    }).formData();
    expect(form.get('project')).toBe('legacy-proj');
    expect(form.has('manifest')).toBe(true);
    expect(
      form.has('screenshots[stories/auto/Example_Button--Primary.png]'),
    ).toBe(true);
  });

  it('turns an unanswered finalize into a finalize-phase error at the deadline', async () => {
    workDir = await seedBuild();
    const { baseUrl } = await serve((req, res) => {
      if (req.url === '/api/builds') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"buildId":"wire-build-001","missing":[]}');
      }
      // finalize: never answered.
    });
    await expect(
      uploadBuild({
        buildDir: workDir,
        options: { serverUrl: baseUrl, processingTimeoutMs: 50 },
      }),
    ).rejects.toMatchObject({
      name: 'QlipUploadNetworkError',
      phase: 'finalize',
      message: expect.stringContaining('no response within 0.05 s') as unknown,
    });
  });
});

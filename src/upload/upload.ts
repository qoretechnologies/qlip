/**
 * Upload a finished build to qlip-server.
 * Wire contract: `qlip-server/design/UPLOAD.md §0`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { QlipManifest, QlipUploadOptions } from '../types.js';
import { hashFile } from './hash.js';

export interface QlipUploadResult {
  /** Build ID echoed by the server (matches the manifest's buildId). */
  buildId: string;
  /** Status code of the final request (finalize, or the legacy POST). */
  status: number;
  /** Which wire protocol actually ran. */
  protocol: 'v2' | 'legacy';
  /** v2 only: how many blobs were transferred (the rest were deduped). */
  blobsUploaded?: number;
  /** v2 only: how many distinct screenshots the build contained. */
  blobsTotal?: number;
}

export interface QlipUploadInput {
  /** Absolute path to the build directory containing manifest.json. */
  buildDir: string;
  /** Resolved upload options (branch/commit already auto-detected). */
  options: QlipUploadOptions;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Base backoff (ms) between blob-PUT retries; test seam, attempt N waits N×. */
  retryBaseDelayMs?: number;
}

/** Default server when `upload.serverUrl` is omitted: the hosted instance. */
export const DEFAULT_SERVER_URL = 'https://qlip.qoretechnologies.com';

const TRANSFER_CONCURRENCY = 10;
const BLOB_RETRIES = 2;
const BLOB_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

export type TUploadPhase = 'create' | 'blob' | 'finalize' | 'legacy';

/**
 * Resolve the effective server base URL (default applied, trailing slash
 * stripped). Exported so log lines report the URL the upload actually hits.
 */
export const resolveServerUrl = (
  options: Pick<QlipUploadOptions, 'serverUrl'>,
): string => (options.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/$/, '');

export class QlipUploadError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly phase: TUploadPhase;

  constructor(
    status: number,
    statusText: string,
    body: string,
    phase: TUploadPhase = 'legacy',
  ) {
    super(
      `qlip upload failed [${phase}]: ${String(status)} ${statusText} — ${body}${hintFor(status, phase)}`,
    );
    this.name = 'QlipUploadError';
    this.status = status;
    this.responseBody = body;
    this.phase = phase;
  }
}

/** Contextual hint appended to 413s, tailored to the phase that hit it. */
const hintFor = (status: number, phase: TUploadPhase): string => {
  if (status !== 413) return '';
  if (phase === 'legacy') {
    return ' (the legacy upload sends every screenshot in one multipart request; a 413 usually means the reverse proxy in front of qlip-server caps the request body — e.g. nginx defaults to `client_max_body_size 1m`. Raise it, or upgrade the server to the v2 upload protocol.)';
  }
  if (phase === 'blob') {
    return ' (a single screenshot exceeded a per-request size limit — qlip-server caps each blob at MAX_FILE_SIZE_MB, default 50MB; a reverse proxy may cap lower.)';
  }
  return '';
};

const readManifest = async (buildDir: string): Promise<QlipManifest> => {
  const manifestPath = path.join(buildDir, 'manifest.json');
  const text = await readFile(manifestPath, 'utf-8');
  return JSON.parse(text) as QlipManifest;
};

const authHeaders = (options: QlipUploadOptions): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (options.uploadToken !== undefined && options.uploadToken !== '') {
    headers['Authorization'] = `Bearer ${options.uploadToken}`;
  }
  return headers;
};

const errorFromResponse = async (
  response: Response,
  phase: TUploadPhase,
): Promise<QlipUploadError> => {
  const body = await response.text();
  return new QlipUploadError(response.status, response.statusText, body, phase);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` over `items` with at most `limit` in flight at once. */
const mapWithConcurrency = async <T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
};

/** PUT one blob, retrying 5xx/network errors but not deterministic 4xx. */
const putBlob = async (
  fetchImpl: typeof fetch,
  url: string,
  bytes: Buffer,
  baseHeaders: Record<string, string>,
  retryBaseDelayMs: number,
): Promise<void> => {
  // A fresh Uint8Array view avoids SharedArrayBuffer-backed-Buffer
  // rejections in Blob/fetch on some Node versions.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);

  let lastError: unknown;
  for (let attempt = 0; attempt <= BLOB_RETRIES; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: { ...baseHeaders, 'Content-Type': 'image/png' },
        body: view,
        signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
      });
      if (response.ok) return;
      const error = await errorFromResponse(response, 'blob');
      if (response.status >= 400 && response.status < 500) throw error;
      lastError = error;
    } catch (err) {
      if (err instanceof QlipUploadError) throw err;
      lastError = err;
    }
    if (attempt < BLOB_RETRIES) await delay(retryBaseDelayMs * (attempt + 1));
  }
  throw lastError;
};

/** Pre-v2 single-multipart upload; fallback when the server lacks v2 routes. */
const uploadBuildLegacy = async (
  fetchImpl: typeof fetch,
  baseUrl: string,
  buildDir: string,
  options: QlipUploadOptions,
  manifest: QlipManifest,
): Promise<QlipUploadResult> => {
  const form = new FormData();
  form.append(
    'manifest',
    new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    'manifest.json',
  );

  const captured = manifest.entries.filter((e) => e.status === 'captured');
  for (const entry of captured) {
    const png = await readFile(path.join(buildDir, entry.path));
    const view = new Uint8Array(png.byteLength);
    view.set(png);
    form.append(
      `screenshots[${entry.path}]`,
      new Blob([view], { type: 'image/png' }),
      path.basename(entry.path),
    );
  }

  form.append('project', options.project ?? 'default');
  if (options.branch !== undefined) form.append('branch', options.branch);
  if (options.commit !== undefined) form.append('commit', options.commit);
  if (options.baseBranch !== undefined) {
    form.append('baseBranch', options.baseBranch);
  }
  if (options.ancestorCommits !== undefined) {
    // Multipart fields are strings; the server JSON-parses this one.
    form.append('ancestorCommits', JSON.stringify(options.ancestorCommits));
  }
  if (options.pullRequestUrl !== undefined) {
    form.append('pullRequestUrl', options.pullRequestUrl);
  }

  const response = await fetchImpl(`${baseUrl}/api/builds/upload`, {
    method: 'POST',
    body: form,
    headers: authHeaders(options),
  });
  if (!response.ok) throw await errorFromResponse(response, 'legacy');

  return { buildId: manifest.buildId, status: response.status, protocol: 'legacy' };
};

interface ICreateBuildResponse {
  buildId: string;
  missing: string[];
}

export const uploadBuild = async (
  input: QlipUploadInput,
): Promise<QlipUploadResult> => {
  const { buildDir, options } = input;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const retryBaseDelayMs =
    input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const baseUrl = resolveServerUrl(options);
  const headers = authHeaders(options);

  const manifest = await readManifest(buildDir);
  const captured = manifest.entries.filter((e) => e.status === 'captured');

  // Hash streams from disk so a large PNG never sits fully in memory.
  await mapWithConcurrency(captured, TRANSFER_CONCURRENCY, async (entry) => {
    const { sha256, sizeBytes } = await hashFile(
      path.join(buildDir, entry.path),
    );
    entry.sha256 = sha256;
    entry.sizeBytes = sizeBytes;
  });

  const createResponse = await fetchImpl(`${baseUrl}/api/builds`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      manifest,
      project: options.project ?? 'default',
      ...(options.branch !== undefined ? { branch: options.branch } : {}),
      ...(options.commit !== undefined ? { commit: options.commit } : {}),
      ...(options.baseBranch !== undefined
        ? { baseBranch: options.baseBranch }
        : {}),
      ...(options.ancestorCommits !== undefined
        ? { ancestorCommits: options.ancestorCommits }
        : {}),
      ...(options.pullRequestUrl !== undefined
        ? { pullRequestUrl: options.pullRequestUrl }
        : {}),
    }),
  });

  // 404 ⇒ server predates the v2 routes; fall back to legacy multipart.
  if (createResponse.status === 404) {
    return uploadBuildLegacy(fetchImpl, baseUrl, buildDir, options, manifest);
  }
  if (!createResponse.ok) throw await errorFromResponse(createResponse, 'create');

  const { buildId, missing } =
    (await createResponse.json()) as ICreateBuildResponse;
  const buildPath = encodeURIComponent(buildId);

  const pathByKey = new Map<string, string>();
  for (const entry of captured) {
    if (entry.sha256 !== undefined && !pathByKey.has(entry.sha256)) {
      pathByKey.set(entry.sha256, entry.path);
    }
  }

  await mapWithConcurrency(missing, TRANSFER_CONCURRENCY, async (key) => {
    const relPath = pathByKey.get(key);
    if (relPath === undefined) {
      throw new QlipUploadError(
        0,
        'client',
        `server requested an unknown blob: ${key}`,
        'blob',
      );
    }
    const bytes = await readFile(path.join(buildDir, relPath));
    await putBlob(
      fetchImpl,
      `${baseUrl}/api/builds/${buildPath}/blobs/${key}`,
      bytes,
      headers,
      retryBaseDelayMs,
    );
  });

  const finalizeResponse = await fetchImpl(
    `${baseUrl}/api/builds/${buildPath}/finalize`,
    { method: 'POST', headers },
  );
  if (!finalizeResponse.ok) {
    throw await errorFromResponse(finalizeResponse, 'finalize');
  }

  return {
    buildId,
    status: finalizeResponse.status,
    protocol: 'v2',
    blobsUploaded: missing.length,
    blobsTotal: pathByKey.size,
  };
};

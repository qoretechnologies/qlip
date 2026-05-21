/**
 * Build the multipart/form-data payload + POST it to qlip-server.
 *
 * Field-name convention is dictated by the server route's docstring
 * (qlip-server/src/routes/upload.ts):
 *
 *   - manifest:                 the qlip manifest.json (file part)
 *   - screenshots[<entry.path>]: one file part per captured entry,
 *                                with the manifest entry path encoded
 *                                in the field name brackets (Fastify
 *                                strips path separators from filenames
 *                                for security, so we encode the path
 *                                in the field name instead).
 *   - project, branch, commit:  plain text form fields.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { QlipManifest, QlipUploadOptions } from '../types.js';

export interface QlipUploadResult {
  /** Build ID echoed by the server (matches the manifest's buildId). */
  buildId: string;
  /** Response status code. */
  status: number;
}

export interface QlipUploadInput {
  /** Absolute path to the build directory containing manifest.json. */
  buildDir: string;
  /** Resolved upload options (branch/commit already auto-detected). */
  options: QlipUploadOptions;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class QlipUploadError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, statusText: string, body: string) {
    super(`qlip upload failed: ${String(status)} ${statusText} — ${body}`);
    this.name = 'QlipUploadError';
    this.status = status;
    this.responseBody = body;
  }
}

const readManifest = async (buildDir: string): Promise<QlipManifest> => {
  const manifestPath = path.join(buildDir, 'manifest.json');
  const text = await readFile(manifestPath, 'utf-8');
  return JSON.parse(text) as QlipManifest;
};

export const uploadBuild = async (
  input: QlipUploadInput,
): Promise<QlipUploadResult> => {
  const { buildDir, options } = input;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const manifest = await readManifest(buildDir);
  const manifestText = JSON.stringify(manifest);

  const form = new FormData();
  form.append(
    'manifest',
    new Blob([manifestText], { type: 'application/json' }),
    'manifest.json',
  );

  // One file part per captured entry, with the entry path encoded
  // into the field name (the server matches by this path).
  const captured = manifest.entries.filter((e) => e.status === 'captured');
  for (const entry of captured) {
    const png = await readFile(path.join(buildDir, entry.path));
    // Construct an ArrayBuffer slice for Blob (Buffer is Uint8Array, but
    // some Node versions reject SharedArrayBuffer-backed slices in Blob).
    const view = new Uint8Array(png.byteLength);
    view.set(png);
    form.append(
      `screenshots[${entry.path}]`,
      new Blob([view], { type: 'image/png' }),
      path.basename(entry.path),
    );
  }

  // Text fields.
  form.append('project', options.project ?? 'default');
  if (options.branch !== undefined) form.append('branch', options.branch);
  if (options.commit !== undefined) form.append('commit', options.commit);

  const url = `${options.serverUrl.replace(/\/$/, '')}/api/builds/upload`;
  const headers: Record<string, string> = {};
  if (options.uploadToken !== undefined && options.uploadToken !== '') {
    headers['Authorization'] = `Bearer ${options.uploadToken}`;
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    body: form,
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new QlipUploadError(response.status, response.statusText, body);
  }

  return { buildId: manifest.buildId, status: response.status };
};

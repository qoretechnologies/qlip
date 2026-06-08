/**
 * Tiny static-file server for `qlip-serve-and-test`.
 *
 * Why we don't shell out to `http-server` (or similar): every
 * npm-shipped static-file CLI is another dependency the consumer
 * needs installed. Node's `node:http` + `node:fs/promises` cover
 * everything we need in ~70 lines and zero deps.
 *
 * Scope (deliberately minimal):
 *  - Serves files from a single root directory
 *  - Auto-picks a free port (binds 0 → reads `address().port`)
 *  - Default to `iframe.html` when path resolves to a directory
 *    (Storybook's static build serves both `index.html` and
 *    `iframe.html`; test-runner only needs `iframe.html`)
 *  - Path traversal protection (`..` resolves outside root → 403)
 *  - Sets Content-Type for the file types Storybook static bundles
 *    use; everything else falls back to `application/octet-stream`
 *
 * NOT in scope: caching headers, range requests, CORS (test-runner
 * navigates same-origin), gzip — all unnecessary for our use case.
 */

import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export interface IStaticServerHandle {
  /** The bound `http://localhost:<port>` URL. */
  url: string;
  /** The chosen port. */
  port: number;
  /** Close the server. Resolves once listener is closed. */
  close: () => Promise<void>;
}

const sendStatus = (
  res: ServerResponse,
  status: number,
  message: string,
): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
};

/**
 * Start a static-file server bound to `127.0.0.1`. Returns once it's
 * listening — no extra wait-on dance needed.
 */
export const startStaticServer = async (opts: {
  rootDir: string;
  /** Override port. 0 (default) → kernel picks a free one. */
  port?: number;
}): Promise<IStaticServerHandle> => {
  const root = path.resolve(opts.rootDir);

  // Sanity-check the root exists + is a directory. Failing here is
  // a much clearer error than getting 404s for every request.
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Storybook static dir is not a directory: ${root}`);
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, root);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('static server did not bind to a TCP port');
  }
  const port = address.port;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() waits for inflight requests; force-close idle
        // connections so test-runner shutdowns are snappy.
        server.closeIdleConnections();
      }),
  };
};

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<void> => {
  // URL parsing handles query strings + decoding for us.
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    sendStatus(res, 400, 'invalid URL');
    return;
  }
  // Trim leading slash for path.join, but make sure we don't allow
  // .. components to escape the root. `path.resolve` collapses ..
  // and then we re-check the prefix.
  const rel = urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    sendStatus(res, 403, 'forbidden');
    return;
  }

  let target = resolved;
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(target);
  } catch {
    sendStatus(res, 404, 'not found');
    return;
  }

  if (stat.isDirectory()) {
    // Storybook's static build always has index.html. test-runner
    // navigates to iframe.html?id=...; both must resolve.
    target = path.join(target, 'index.html');
    try {
      stat = await fs.stat(target);
    } catch {
      sendStatus(res, 404, 'not found');
      return;
    }
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', String(stat.size));

  // Stream the body — keeps memory bounded for big bundles.
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(target);
  stream.on('error', () => {
    if (!res.headersSent) sendStatus(res, 500, 'read error');
    else res.end();
  });
  stream.pipe(res);
};

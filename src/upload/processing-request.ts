/**
 * HTTP transport for the upload requests qlip-server answers only once it
 * has processed the whole build: `finalize` and the legacy multipart POST.
 *
 * Node's global `fetch` (undici) fails any request whose response headers
 * take longer than 300 s (`headersTimeout`) with a bare "fetch failed", and
 * the limit can't be raised without depending on the `undici` package. A
 * large build's diff runs longer than that, so these requests go through
 * `node:http`, which imposes no response deadline: the caller's `signal` is
 * the only one. See design/UPLOAD.md "Long-running requests".
 */

import http from 'node:http';
import https from 'node:https';

/** The subset of `fetch` the upload client uses; `fetch` itself satisfies it. */
export type TFetchLike = (url: string, init: RequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const encodeBody = async (
  body: RequestInit['body'],
): Promise<{ bytes: Uint8Array; contentType: string | null }> => {
  if (body === undefined || body === null) {
    return { bytes: new Uint8Array(0), contentType: null };
  }
  // Response serializes every BodyInit (FormData gets its multipart boundary).
  const encoded = new Response(body);
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get('content-type'),
  };
};

const toResponse = (res: http.IncomingMessage, body: Buffer): Response => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const status = res.statusCode ?? 0;
  return new Response(
    NULL_BODY_STATUSES.has(status) ? null : new Uint8Array(body),
    {
      status,
      statusText: res.statusMessage ?? '',
      headers,
    },
  );
};

export const fetchAwaitingProcessing: TFetchLike = async (url, init) => {
  const target = new URL(url);
  const transport =
    target.protocol === 'https:'
      ? https
      : target.protocol === 'http:'
        ? http
        : undefined;
  if (transport === undefined) {
    throw new TypeError(`unsupported protocol: ${target.protocol}`);
  }

  const { bytes, contentType } = await encodeBody(init.body);
  const headers: Record<string, string> = {};
  if (contentType !== null) headers['content-type'] = contentType;
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  headers['content-length'] = String(bytes.byteLength);

  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: init.method ?? 'GET',
        headers,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('error', reject);
        // A connection dropped mid-body ends the stream without `end`.
        res.on('close', () => {
          if (!res.complete) {
            reject(
              new Error('connection closed before the response completed'),
            );
          }
        });
        res.on('end', () => {
          try {
            resolve(toResponse(res, Buffer.concat(chunks)));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(bytes);
  });
};

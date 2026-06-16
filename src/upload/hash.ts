/** Content-hashing for blob uploads (the sha256 is the blob key). */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export interface QlipFileHash {
  /** Lowercase sha256 hex of the file's bytes. */
  sha256: string;
  sizeBytes: number;
}

/** Stream a file through sha256 — never buffers the whole file in memory. */
export const hashFile = async (filePath: string): Promise<QlipFileHash> => {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  const { size } = await stat(filePath);
  return { sha256: hash.digest('hex'), sizeBytes: size };
};

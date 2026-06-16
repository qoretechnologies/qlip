/**
 * Unit tests for hashFile — streaming sha256 + byte size of a file.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashFile } from '../../src/upload/hash.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qlip-hash-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('returns the sha256 hex and byte size of the file', async () => {
    const bytes = Buffer.from('a real-ish png payload of some length');
    const file = path.join(dir, 'shot.png');
    await writeFile(file, bytes);

    const result = await hashFile(file);

    expect(result.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(result.sizeBytes).toBe(bytes.byteLength);
    // Lowercase 64-char hex.
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known empty-file vector', async () => {
    const file = path.join(dir, 'empty.png');
    await writeFile(file, Buffer.alloc(0));

    const result = await hashFile(file);

    expect(result.sha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(result.sizeBytes).toBe(0);
  });

  it('hashes identical content to the same key (dedup invariant)', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    await writeFile(a, bytes);
    await writeFile(b, bytes);

    const [ha, hb] = await Promise.all([hashFile(a), hashFile(b)]);
    expect(ha.sha256).toBe(hb.sha256);
  });
});

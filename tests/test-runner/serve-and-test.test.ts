/**
 * Unit tests for `runServeAndTest` — covers the arg parsing,
 * mutual-exclusion checks, static-server orchestration, and the
 * upload-trigger decision tree.
 *
 * We don't spawn test-storybook here (would require an integration
 * harness with @storybook/test-runner installed, and would be slow
 * + flaky). Instead we patch `child_process.spawn` so the
 * "test-storybook" call resolves immediately with a known exit
 * code and we assert on the arguments + flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  runServeAndTest,
  type TSpawnFn,
} from '../../src/test-runner/cli/serve-and-test.js';

// Each test gets a fresh spawn stub via dependency injection.
// (Can't use vi.spyOn on Node's ESM `child_process` — bindings
// are read-only. Inject the function instead, cleaner anyway.)
interface ISpawnRecord {
  command: string;
  args: string[];
}

interface ISpawnHarness {
  spawn: TSpawnFn;
  records: ISpawnRecord[];
  setExitCode: (code: number) => void;
  setError: (err: Error) => void;
}

const makeSpawnHarness = (): ISpawnHarness => {
  const records: ISpawnRecord[] = [];
  let nextExitCode = 0;
  let nextError: Error | null = null;

  const spawn: TSpawnFn = (command, args) => {
    records.push({ command, args: args ? [...args] : [] });
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'killed', { value: false, writable: true });
    Object.defineProperty(child, 'kill', { value: () => true });
    setImmediate(() => {
      if (nextError) child.emit('error', nextError);
      else child.emit('close', nextExitCode, null);
    });
    return child;
  };

  return {
    spawn,
    records,
    setExitCode: (code) => {
      nextExitCode = code;
    },
    setError: (err) => {
      nextError = err;
    },
  };
};

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'qlip-sat-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('runServeAndTest — arg parsing', () => {
  it('rejects unknown flags with exit 1', async () => {
    const harness = makeSpawnHarness();
    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--bogus'],
      {},
      { log, error },
      harness.spawn,
    );
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown option'));
  });

  it('rejects invalid --port', async () => {
    const harness = makeSpawnHarness();
    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--port', '999999'],
      {},
      { log, error },
      harness.spawn,
    );
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --port'),
    );
  });

  it('--help exits 0 and prints usage', async () => {
    const harness = makeSpawnHarness();
    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--help'],
      {},
      { log, error },
      harness.spawn,
    );
    expect(result.exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('qlip-serve-and-test'));
  });

  it('rejects --url AND --storybook-static together', async () => {
    const harness = makeSpawnHarness();
    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      [
        '--url',
        'http://localhost:6006',
        '--storybook-static',
        '/tmp/sb',
      ],
      {},
      { log, error },
      harness.spawn,
    );
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('mutually exclusive'),
    );
  });

  it('fails cleanly when --storybook-static does not exist', async () => {
    const harness = makeSpawnHarness();
    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--storybook-static', path.join(tmpRoot, 'missing-dir')],
      {},
      { log, error },
      harness.spawn,
    );
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('failed to serve storybook-static'),
    );
  });
});

describe('runServeAndTest — orchestration', () => {
  it('spawns test-storybook with --url pointing at internal static server', async () => {
    await writeFile(path.join(tmpRoot, 'iframe.html'), '<p>hi</p>');
    const harness = makeSpawnHarness();

    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--storybook-static', tmpRoot, '--no-upload'],
      {},
      { log, error },
      harness.spawn,
    );

    expect(result.exitCode).toBe(0);
    expect(result.testRunnerExitCode).toBe(0);
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0].command).toBe('test-storybook');
    expect(harness.records[0].args[0]).toBe('--url');
    expect(harness.records[0].args[1]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(result.url).toBe(harness.records[0].args[1]);
  });

  it('skips the static server when --url is provided', async () => {
    const harness = makeSpawnHarness();
    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--url', 'http://existing:6006', '--no-upload'],
      {},
      { log, error },
      harness.spawn,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.records[0].args[1]).toBe('http://existing:6006');
    expect(result.url).toBe('http://existing:6006');
  });

  it('forwards args after -- to test-storybook', async () => {
    await writeFile(path.join(tmpRoot, 'iframe.html'), '<p>hi</p>');
    const harness = makeSpawnHarness();

    await runServeAndTest(
      [
        '--storybook-static',
        tmpRoot,
        '--no-upload',
        '--',
        '--shard',
        '1/4',
        '--maxWorkers',
        '2',
      ],
      {},
      { log: vi.fn(), error: vi.fn() },
      harness.spawn,
    );

    const args = harness.records[0].args;
    expect(args).toContain('--shard');
    expect(args).toContain('1/4');
    expect(args).toContain('--maxWorkers');
    expect(args).toContain('2');
  });

  it('propagates test-storybook non-zero exit when upload is skipped', async () => {
    await writeFile(path.join(tmpRoot, 'iframe.html'), '<p>hi</p>');
    const harness = makeSpawnHarness();
    harness.setExitCode(7);

    const result = await runServeAndTest(
      ['--storybook-static', tmpRoot, '--no-upload'],
      {},
      { log: vi.fn(), error: vi.fn() },
      harness.spawn,
    );

    expect(result.exitCode).toBe(7);
    expect(result.testRunnerExitCode).toBe(7);
  });

  it('surfaces spawn errors as exit 1 with a helpful hint', async () => {
    await writeFile(path.join(tmpRoot, 'iframe.html'), '<p>hi</p>');
    const harness = makeSpawnHarness();
    harness.setError(new Error('ENOENT'));

    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--storybook-static', tmpRoot, '--no-upload'],
      {},
      { log, error },
      harness.spawn,
    );

    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/failed to spawn test-storybook.*@storybook\/test-runner/),
    );
  });
});

describe('runServeAndTest — upload trigger logic', () => {
  it('auto-skips upload when QLIP_UPLOAD_URL is not set', async () => {
    await writeFile(path.join(tmpRoot, 'iframe.html'), '<p>hi</p>');
    const harness = makeSpawnHarness();

    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--storybook-static', tmpRoot],
      {},
      { log, error },
      harness.spawn,
    );

    expect(result.exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('skipping upload'),
    );
    // Only one spawn — test-storybook. No upload triggered.
    expect(harness.records).toHaveLength(1);
  });

  it('runs upload in-process when --upload is forced (env unset)', async () => {
    await writeFile(path.join(tmpRoot, 'iframe.html'), '<p>hi</p>');
    const harness = makeSpawnHarness();

    const log = vi.fn();
    const error = vi.fn();
    const result = await runServeAndTest(
      ['--storybook-static', tmpRoot, '--upload'],
      {},
      { log, error },
      harness.spawn,
    );

    // --upload forces, but QLIP_UPLOAD_URL is missing → upload
    // step rejects with exit 1, which becomes the final exit.
    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('--server-url or QLIP_UPLOAD_URL is required'),
    );
  });
});

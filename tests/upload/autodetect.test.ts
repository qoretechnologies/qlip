import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock git so the fallback path is deterministic regardless of the
// ambient checkout. In particular, CI PR builds run on a detached HEAD,
// where `git rev-parse --abbrev-ref HEAD` reports "HEAD" — which the impl
// maps to `undefined`. The previous version called real git and assumed
// the repo was always on a named branch, so it failed under CI.
const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import {
  autodetectBranch,
  autodetectCommit,
} from '../../src/upload/autodetect.js';

// Save + restore env so tests don't pollute each other.
const savedEnv = {
  GITHUB_HEAD_REF: process.env['GITHUB_HEAD_REF'],
  GITHUB_REF_NAME: process.env['GITHUB_REF_NAME'],
  GITHUB_SHA: process.env['GITHUB_SHA'],
};

beforeEach(() => {
  delete process.env['GITHUB_HEAD_REF'];
  delete process.env['GITHUB_REF_NAME'];
  delete process.env['GITHUB_SHA'];
  execFileSyncMock.mockReset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('autodetectBranch', () => {
  it('prefers GITHUB_HEAD_REF (set on PR builds)', () => {
    process.env['GITHUB_HEAD_REF'] = 'feature/foo';
    process.env['GITHUB_REF_NAME'] = 'main'; // should be ignored
    expect(autodetectBranch()).toBe('feature/foo');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to GITHUB_REF_NAME when no PR head ref', () => {
    process.env['GITHUB_REF_NAME'] = 'main';
    expect(autodetectBranch()).toBe('main');
  });

  it('falls back to the git branch when no env vars are set', () => {
    execFileSyncMock.mockReturnValue('feature/foo\n');
    expect(autodetectBranch()).toBe('feature/foo');
  });

  it('returns undefined on a detached HEAD (e.g. CI PR builds)', () => {
    execFileSyncMock.mockReturnValue('HEAD\n');
    expect(autodetectBranch()).toBeUndefined();
  });
});

describe('autodetectCommit', () => {
  it('prefers GITHUB_SHA', () => {
    process.env['GITHUB_SHA'] = 'abc123def456';
    expect(autodetectCommit()).toBe('abc123def456');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to the git commit SHA when env var is not set', () => {
    execFileSyncMock.mockReturnValue(
      '1234567890abcdef1234567890abcdef12345678\n',
    );
    expect(autodetectCommit()).toBe(
      '1234567890abcdef1234567890abcdef12345678',
    );
  });
});

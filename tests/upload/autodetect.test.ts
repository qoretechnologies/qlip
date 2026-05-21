import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  });

  it('falls back to GITHUB_REF_NAME when no PR head ref', () => {
    process.env['GITHUB_REF_NAME'] = 'main';
    expect(autodetectBranch()).toBe('main');
  });

  it('falls back to git when no env vars are set', () => {
    // The qlip repo itself is a git repo, so this returns a real branch
    // (e.g. "feature/mvp"). Don't assert on the exact value — just that
    // something non-empty came back.
    const result = autodetectBranch();
    expect(result).toBeTypeOf('string');
    expect((result ?? '').length).toBeGreaterThan(0);
  });
});

describe('autodetectCommit', () => {
  it('prefers GITHUB_SHA', () => {
    process.env['GITHUB_SHA'] = 'abc123def456';
    expect(autodetectCommit()).toBe('abc123def456');
  });

  it('falls back to git when env var is not set', () => {
    const result = autodetectCommit();
    // 40-char SHA from real git in this repo.
    expect(result).toBeTypeOf('string');
    expect((result ?? '').length).toBeGreaterThanOrEqual(7);
  });
});

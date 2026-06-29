import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  autodetectAncestorCommits,
  autodetectBaseBranch,
  autodetectBranch,
  autodetectCommit,
  autodetectPullRequestUrl,
} from '../../src/upload/autodetect.js';

// Save + restore env so tests don't pollute each other.
const savedEnv = {
  GITHUB_HEAD_REF: process.env['GITHUB_HEAD_REF'],
  GITHUB_REF_NAME: process.env['GITHUB_REF_NAME'],
  GITHUB_SHA: process.env['GITHUB_SHA'],
  GITHUB_BASE_REF: process.env['GITHUB_BASE_REF'],
  GITHUB_REF: process.env['GITHUB_REF'],
  GITHUB_REPOSITORY: process.env['GITHUB_REPOSITORY'],
  GITHUB_SERVER_URL: process.env['GITHUB_SERVER_URL'],
  GITHUB_EVENT_NAME: process.env['GITHUB_EVENT_NAME'],
  GITHUB_EVENT_PATH: process.env['GITHUB_EVENT_PATH'],
};

beforeEach(() => {
  delete process.env['GITHUB_HEAD_REF'];
  delete process.env['GITHUB_REF_NAME'];
  delete process.env['GITHUB_SHA'];
  delete process.env['GITHUB_BASE_REF'];
  delete process.env['GITHUB_REF'];
  delete process.env['GITHUB_REPOSITORY'];
  delete process.env['GITHUB_SERVER_URL'];
  delete process.env['GITHUB_EVENT_NAME'];
  delete process.env['GITHUB_EVENT_PATH'];
  execFileSyncMock.mockReset();
});

/** Write a GitHub Actions event payload to a temp file + point
 *  GITHUB_EVENT_PATH at it; returns the path. */
function writeEventPayload(payload: unknown): string {
  const file = join(
    tmpdir(),
    `qlip-event-${String(process.hrtime.bigint())}.json`,
  );
  writeFileSync(file, JSON.stringify(payload), 'utf-8');
  process.env['GITHUB_EVENT_PATH'] = file;
  return file;
}

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
  it('prefers GITHUB_SHA on non-PR (push) events', () => {
    process.env['GITHUB_SHA'] = 'abc123def456';
    expect(autodetectCommit()).toBe('abc123def456');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('prefers the PR head SHA over GITHUB_SHA on pull_request events', () => {
    // GITHUB_SHA is the ephemeral merge commit on PR events; the event
    // payload's pull_request.head.sha is the real branch commit and
    // must win so the server's ancestry resolution can match it later.
    process.env['GITHUB_EVENT_NAME'] = 'pull_request';
    process.env['GITHUB_SHA'] = 'mergeSHAephemeral';
    writeEventPayload({ pull_request: { head: { sha: 'realHeadSHA123' } } });
    expect(autodetectCommit()).toBe('realHeadSHA123');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('also handles pull_request_target events', () => {
    process.env['GITHUB_EVENT_NAME'] = 'pull_request_target';
    process.env['GITHUB_SHA'] = 'mergeSHA';
    writeEventPayload({ pull_request: { head: { sha: 'targetHeadSHA' } } });
    expect(autodetectCommit()).toBe('targetHeadSHA');
  });

  it('falls back to GITHUB_SHA on a PR event whose payload lacks a head SHA', () => {
    process.env['GITHUB_EVENT_NAME'] = 'pull_request';
    process.env['GITHUB_SHA'] = 'fallbackSHA';
    writeEventPayload({ pull_request: {} });
    expect(autodetectCommit()).toBe('fallbackSHA');
  });

  it('falls back to GITHUB_SHA when the event file is unreadable', () => {
    process.env['GITHUB_EVENT_NAME'] = 'pull_request';
    process.env['GITHUB_EVENT_PATH'] = join(tmpdir(), 'does-not-exist.json');
    process.env['GITHUB_SHA'] = 'fallbackSHA2';
    expect(autodetectCommit()).toBe('fallbackSHA2');
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

describe('autodetectBaseBranch', () => {
  it('reads GITHUB_BASE_REF (set only on PR builds)', () => {
    process.env['GITHUB_BASE_REF'] = 'develop';
    expect(autodetectBaseBranch()).toBe('develop');
    // No git equivalent — must never shell out for a base branch.
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns undefined when GITHUB_BASE_REF is unset (push builds)', () => {
    expect(autodetectBaseBranch()).toBeUndefined();
  });

  it('treats an empty GITHUB_BASE_REF as absent', () => {
    process.env['GITHUB_BASE_REF'] = '';
    expect(autodetectBaseBranch()).toBeUndefined();
  });
});

describe('autodetectPullRequestUrl', () => {
  it('constructs the PR URL from GITHUB_REF + repo + server URL', () => {
    process.env['GITHUB_REF'] = 'refs/pull/123/merge';
    process.env['GITHUB_REPOSITORY'] = 'qoretechnologies/qlip';
    process.env['GITHUB_SERVER_URL'] = 'https://github.com';
    expect(autodetectPullRequestUrl()).toBe(
      'https://github.com/qoretechnologies/qlip/pull/123',
    );
    // Env-only — must never shell out for PR context.
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('defaults the server URL to https://github.com when unset', () => {
    process.env['GITHUB_REF'] = 'refs/pull/7/head';
    process.env['GITHUB_REPOSITORY'] = 'owner/repo';
    expect(autodetectPullRequestUrl()).toBe(
      'https://github.com/owner/repo/pull/7',
    );
  });

  it('honors a self-hosted GITHUB_SERVER_URL (GHES)', () => {
    process.env['GITHUB_REF'] = 'refs/pull/42/merge';
    process.env['GITHUB_REPOSITORY'] = 'team/app';
    process.env['GITHUB_SERVER_URL'] = 'https://ghe.example.com/';
    // Trailing slash on the server URL is trimmed so we never emit `//pull`.
    expect(autodetectPullRequestUrl()).toBe(
      'https://ghe.example.com/team/app/pull/42',
    );
  });

  it('returns undefined for a push build (GITHUB_REF is a branch ref)', () => {
    process.env['GITHUB_REF'] = 'refs/heads/main';
    process.env['GITHUB_REPOSITORY'] = 'owner/repo';
    expect(autodetectPullRequestUrl()).toBeUndefined();
  });

  it('returns undefined for local runs (no GITHUB_REF)', () => {
    expect(autodetectPullRequestUrl()).toBeUndefined();
  });

  it('returns undefined when the repository slug is missing', () => {
    process.env['GITHUB_REF'] = 'refs/pull/123/merge';
    expect(autodetectPullRequestUrl()).toBeUndefined();
  });
});

describe('autodetectAncestorCommits', () => {
  // `git rev-parse --is-shallow-repository` runs first (shallow guard);
  // a non-shallow repo returns "false". Then `git rev-list` runs. This
  // helper scripts the mock to answer both in call order.
  const scriptGit = (revList: string, isShallow = 'false'): void => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--is-shallow-repository')) return `${isShallow}\n`;
      if (args[0] === 'rev-list') return revList;
      return '';
    });
  };

  it('parses rev-list output into a nearest-first SHA array', () => {
    scriptGit('aaa111\nbbb222\nccc333\n');
    expect(autodetectAncestorCommits()).toEqual(['aaa111', 'bbb222', 'ccc333']);
  });

  it('passes --max-count=100 to git so the ancestry is capped', () => {
    scriptGit('aaa111\n');
    autodetectAncestorCommits();
    const revListCall = execFileSyncMock.mock.calls.find(
      (call) => (call[1] as string[])[0] === 'rev-list',
    );
    expect(revListCall?.[1]).toEqual(['rev-list', '--max-count=100', 'HEAD']);
  });

  it('caps the returned list at 100 even if more lines come back', () => {
    // Belt-and-suspenders: git already caps via --max-count, but make
    // sure the parser never lets a longer list through.
    const lines = Array.from({ length: 150 }, (_, i) => `sha${String(i)}`);
    scriptGit(`${lines.join('\n')}\n`);
    const result = autodetectAncestorCommits();
    expect(result).toHaveLength(100);
    expect(result?.[0]).toBe('sha0');
  });

  it('drops blank lines and trims surrounding whitespace', () => {
    scriptGit('  aaa111  \n\n bbb222 \n');
    expect(autodetectAncestorCommits()).toEqual(['aaa111', 'bbb222']);
  });

  it('returns undefined when git is unavailable', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('git: command not found');
    });
    expect(autodetectAncestorCommits()).toBeUndefined();
  });

  it('returns undefined when rev-list yields no commits', () => {
    scriptGit('   \n  \n');
    expect(autodetectAncestorCommits()).toBeUndefined();
  });
});

describe('autodetectAncestorCommits — shallow clone', () => {
  // The shallow warning is one-time per process via a module-level
  // flag, so each test re-imports a fresh module copy to observe it.
  const loadFresh = async (): Promise<
    typeof import('../../src/upload/autodetect.js')
  > => {
    vi.resetModules();
    return import('../../src/upload/autodetect.js');
  };

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns about fetch-depth, still returns the available commits, never throws', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--is-shallow-repository')) return 'true\n';
      if (args[0] === 'rev-list') return 'tip111\n';
      return '';
    });

    const mod = await loadFresh();
    const result = mod.autodetectAncestorCommits();

    expect(result).toEqual(['tip111']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = warnSpy.mock.calls[0]?.[0] as string;
    expect(warning).toContain('fetch-depth: 0');
    expect(warning).toContain('SHALLOW');
  });

  it('warns at most once even across repeated calls', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--is-shallow-repository')) return 'true\n';
      if (args[0] === 'rev-list') return 'tip111\n';
      return '';
    });

    const mod = await loadFresh();
    mod.autodetectAncestorCommits();
    mod.autodetectAncestorCommits();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a full (non-shallow) clone', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--is-shallow-repository')) return 'false\n';
      if (args[0] === 'rev-list') return 'tip111\n';
      return '';
    });

    const mod = await loadFresh();
    mod.autodetectAncestorCommits();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

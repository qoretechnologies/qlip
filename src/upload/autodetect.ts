/**
 * Auto-detect git branch + commit SHA for the build being uploaded.
 *
 * Order of precedence:
 *   - GitHub Actions env vars ($GITHUB_HEAD_REF for PRs, then
 *     $GITHUB_REF_NAME for pushes; $GITHUB_SHA for the commit).
 *   - `git rev-parse` fallbacks.
 *
 * Returns undefined if nothing can be inferred — the caller passes
 * the metadata along to qlip-server which stores it as nullable.
 */

import { execFileSync } from 'node:child_process';

const gitCommand = (args: string[]): string | undefined => {
  try {
    const out = execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
};

export const autodetectBranch = (): string | undefined => {
  // GitHub Actions PR (the head branch).
  const headRef = process.env['GITHUB_HEAD_REF'];
  if (headRef && headRef.length > 0) return headRef;
  // GitHub Actions push / non-PR.
  const refName = process.env['GITHUB_REF_NAME'];
  if (refName && refName.length > 0) return refName;
  // Local git fallback.
  const branch = gitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
  // Detached HEAD reports "HEAD" which isn't useful as a branch name.
  return branch === 'HEAD' ? undefined : branch;
};

export const autodetectCommit = (): string | undefined => {
  const sha = process.env['GITHUB_SHA'];
  if (sha && sha.length > 0) return sha;
  return gitCommand(['rev-parse', 'HEAD']);
};

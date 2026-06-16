/**
 * Auto-detect git metadata for the build being uploaded: the head
 * branch + commit SHA, the PR base branch, and the commit ancestry
 * the server uses to resolve a baseline.
 *
 * Order of precedence (branch/commit):
 *   - GitHub Actions env vars ($GITHUB_HEAD_REF for PRs, then
 *     $GITHUB_REF_NAME for pushes; $GITHUB_SHA for the commit).
 *   - `git rev-parse` fallbacks.
 *
 * Returns undefined when nothing can be inferred — the caller passes
 * the metadata along to qlip-server, which stores it as nullable and
 * treats absence as "old client" (it degrades gracefully). See
 * `qlip-server/design/UPLOAD.md`.
 */

import { execFileSync } from 'node:child_process';

/** Server-side cap on the ancestry list (`qlip-server/design/UPLOAD.md`). */
const MAX_ANCESTOR_COMMITS = 100;

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

/**
 * The PR base branch (e.g. "develop"). GitHub Actions sets
 * $GITHUB_BASE_REF only on `pull_request` events; on push builds it's
 * absent, and the server falls back to the project's default branch.
 * There is no git-local equivalent — a base branch only exists in the
 * context of a PR — so this is env-only by design.
 */
export const autodetectBaseBranch = (): string | undefined => {
  const baseRef = process.env['GITHUB_BASE_REF'];
  return baseRef && baseRef.length > 0 ? baseRef : undefined;
};

let shallowWarningEmitted = false;

/**
 * A shallow clone (CI default for `actions/checkout`) only has the tip
 * commit, so the ancestry list is too short for the server to find a
 * baseline. Warn loudly, once, and tell the user how to fix it. We
 * still return whatever commits exist and never throw — a missing
 * baseline degrades to the default-branch fallback, it doesn't fail
 * the upload.
 */
const warnIfShallowClone = (): void => {
  if (shallowWarningEmitted) return;
  if (gitCommand(['rev-parse', '--is-shallow-repository']) !== 'true') return;
  shallowWarningEmitted = true;
  // eslint-disable-next-line no-console -- one-time operator-facing CI warning
  console.warn(
    '[qlip] This is a SHALLOW git clone, so commit ancestry is truncated. ' +
      'Visual baselines need full history to resolve the nearest prior ' +
      'build; until then, baseline resolution falls back to the project ' +
      "default branch. In GitHub Actions, set actions/checkout's " +
      "`fetch-depth: 0`. See this repo's README.",
  );
};

/**
 * Commit SHAs from HEAD backward, nearest-first, capped at
 * MAX_ANCESTOR_COMMITS. The server walks this list to find the nearest
 * ancestor that already has a baseline (it skips commits with none, so
 * HEAD-first is fine even though HEAD is the build under review).
 * Returns undefined when git is unavailable or reports no commits.
 */
export const autodetectAncestorCommits = (): string[] | undefined => {
  warnIfShallowClone();
  const out = gitCommand([
    'rev-list',
    `--max-count=${String(MAX_ANCESTOR_COMMITS)}`,
    'HEAD',
  ]);
  if (out === undefined) return undefined;
  const commits = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // `--max-count` already bounds git's output; slice is a belt-and-
    // suspenders guard so the wire payload can never exceed the cap.
    .slice(0, MAX_ANCESTOR_COMMITS);
  return commits.length > 0 ? commits : undefined;
};

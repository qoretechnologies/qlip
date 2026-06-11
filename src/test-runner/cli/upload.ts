/**
 * `qlip-upload` — merge per-process manifest fragments + POST the
 * finished build to qlip-server.
 *
 * Lifecycle: run AFTER `test-storybook` completes. Mirrors Argos's
 * `argos upload` pattern.
 *
 * ```bash
 * yarn build-storybook
 * npx http-server storybook-static -p 6006 --silent &
 * npx wait-on tcp:6006
 * QLIP_UPLOAD_URL=https://qlip.example.com \
 * QLIP_PROJECT=my-app \
 * yarn test-storybook --url http://localhost:6006
 * npx qlip-upload
 * ```
 *
 * The CLI is intentionally thin: it picks a build directory (latest
 * by mtime under `outputDir`, or explicit via flag), then delegates
 * to the existing `finalizeBuild()` shared with the Vitest plugin
 * path. Wire protocol is the same `multipart/form-data POST` to
 * `/api/builds/upload` documented in `design/UPLOAD.md`.
 *
 * Exit codes:
 *   0 = upload succeeded (or no fragments → no-op silent exit)
 *   1 = invalid args / build dir not found
 *   2 = upload failed AND `--fail-on-upload-error` was set
 *
 * Default is "log + exit 0" on upload errors so a flaky CI pipe
 * doesn't break the rest of the build. CI users opt in to strict
 * with `--fail-on-upload-error`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_OUTPUT_DIR } from '../../fs/output.js';
import type { QlipUploadOptions } from '../../types.js';
import { finalizeBuild } from '../../upload/finalize.js';

interface IParsedArgs {
  buildDir?: string;
  outputDir?: string;
  serverUrl?: string;
  project?: string;
  token?: string;
  branch?: string;
  commit?: string;
  failOnUploadError: boolean;
  help: boolean;
}

const USAGE = `qlip-upload — merge manifest fragments + upload to qlip-server

Usage:
  qlip-upload [options]

Options:
  --build-dir <path>          Specific build dir to upload. Default:
                              latest subdirectory of --output-dir.
  --output-dir <path>         Root containing build dirs. Default:
                              \$QLIP_OUTPUT_DIR or ./qlip/screenshots
  --server-url <url>          qlip-server base URL. Default:
                              \$QLIP_UPLOAD_URL, falling back to
                              https://qlip.qoretechnologies.com.
  --project <name>            Project name. Default: \$QLIP_PROJECT
                              or "default".
  --token <token>             Bearer token. Default: \$QLIP_UPLOAD_TOKEN.
  --branch <branch>           Override branch detection.
  --commit <sha>              Override commit detection.
  --fail-on-upload-error      Exit non-zero on upload failure (default:
                              log error + exit 0).
  -h, --help                  Show this help.

Env vars override defaults; CLI flags override env vars.
`;

const parseArgs = (argv: string[]): IParsedArgs => {
  const args: IParsedArgs = { failOnUploadError: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--build-dir':
        args.buildDir = next();
        break;
      case '--output-dir':
        args.outputDir = next();
        break;
      case '--server-url':
        args.serverUrl = next();
        break;
      case '--project':
        args.project = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--branch':
        args.branch = next();
        break;
      case '--commit':
        args.commit = next();
        break;
      case '--fail-on-upload-error':
        args.failOnUploadError = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
      // bare positional args ignored; reserved for future use
    }
  }
  return args;
};

/**
 * Pick the most recently modified subdirectory of `outputDir` as
 * the build directory. Matches the "just ran test-storybook" UX:
 * the latest build is the one the user wants to upload.
 */
const pickLatestBuildDir = async (outputDir: string): Promise<string> => {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `No builds found — output dir does not exist: ${outputDir}`,
      );
    }
    throw err;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 0) {
    throw new Error(`No builds found under ${outputDir}`);
  }
  const stats = await Promise.all(
    dirs.map(async (dir) => {
      const full = path.join(outputDir, dir.name);
      const stat = await fs.stat(full);
      return { full, mtime: stat.mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].full;
};

export interface IRunUploadResult {
  /** Process exit code the CLI should return. */
  exitCode: number;
  /** Resolved build directory that was processed (for logging/tests). */
  buildDir?: string;
}

/**
 * Programmatic entry point — exported so tests can drive it directly
 * without spawning the CLI process. Returns the exit code instead of
 * calling process.exit, so the caller decides what to do.
 */
export const runUpload = async (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  logger: { log: (msg: string) => void; error: (msg: string) => void } = console,
): Promise<IRunUploadResult> => {
  let parsed: IParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    logger.error((err as Error).message);
    logger.error(USAGE);
    return { exitCode: 1 };
  }

  if (parsed.help) {
    logger.log(USAGE);
    return { exitCode: 0 };
  }

  // Optional since the hosted-instance default exists; an explicit
  // --server-url / $QLIP_UPLOAD_URL still wins.
  const serverUrl = parsed.serverUrl ?? env['QLIP_UPLOAD_URL'];

  const outputDir = path.resolve(
    parsed.outputDir ?? env['QLIP_OUTPUT_DIR'] ?? DEFAULT_OUTPUT_DIR,
  );

  let buildDir: string;
  try {
    buildDir = parsed.buildDir
      ? path.resolve(parsed.buildDir)
      : await pickLatestBuildDir(outputDir);
  } catch (err) {
    logger.error(`qlip-upload: ${(err as Error).message}`);
    return { exitCode: 1 };
  }

  const project = parsed.project ?? env['QLIP_PROJECT'] ?? 'default';
  const token = parsed.token ?? env['QLIP_UPLOAD_TOKEN'];

  const upload: QlipUploadOptions = {
    ...(serverUrl !== undefined && serverUrl !== '' ? { serverUrl } : {}),
    project,
    ...(token !== undefined && token !== '' ? { uploadToken: token } : {}),
    ...(parsed.branch !== undefined ? { branch: parsed.branch } : {}),
    ...(parsed.commit !== undefined ? { commit: parsed.commit } : {}),
    failOnUploadError: parsed.failOnUploadError,
  };

  // finalizeBuild needs a runtime config but only reads `buildDir`
  // off it. We can synthesize a minimal one — the manifest itself
  // (read from disk after merge) carries everything qlip-server
  // cares about.
  const runtime = {
    buildDir,
    // The rest are unused by finalizeBuild but the type demands them.
    buildId: path.basename(buildDir),
    outputDir,
    defaults: {} as never,
    tool: { name: 'qlip', version: '0.0.0' },
  };

  try {
    await finalizeBuild({ runtime, upload });
  } catch (err) {
    // finalizeBuild only throws if failOnUploadError is set AND
    // upload failed. So if we get here, the CLI should exit non-zero.
    logger.error(`qlip-upload: ${(err as Error).message}`);
    return { exitCode: 2, buildDir };
  }

  return { exitCode: 0, buildDir };
};

// NOTE: this file is the LIBRARY for the upload CLI. The bin
// entry that actually invokes runUpload lives at
// `./upload-bin.ts` — separated so this file stays import-safe
// (no top-level side effects) and so the bin file works in both
// ESM and CJS without needing `import.meta.url`-vs-`require.main`
// branching.

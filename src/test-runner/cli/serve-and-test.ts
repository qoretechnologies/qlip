/**
 * `qlip-serve-and-test` — one-command orchestrator for the
 * test-runner capture path.
 *
 * What it does, in order:
 *   1. Serve `--storybook-static <dir>` on a free local port via an
 *      internal stdlib-only static server (no `http-server` peer
 *      dep — see `./static-server.ts`)
 *   2. Spawn `test-storybook --url http://127.0.0.1:<port>` and
 *      forward stdio so the user sees test output live
 *   3. After test-storybook exits cleanly, run `runUpload()`
 *      in-process (unless `--no-upload` was set or
 *      `QLIP_UPLOAD_URL` is unset)
 *   4. Shut down the static server, propagate the test-storybook
 *      exit code (or upload's exit code if `--fail-on-upload-error`
 *      and upload failed)
 *
 * Signal handling: SIGINT / SIGTERM kill the test-storybook child
 * (so Ctrl-C in the terminal tears everything down cleanly) and
 * close the static server before this process exits.
 *
 * Skip mode: `--url <existing-url>` skips the static-server step.
 * Useful when the consumer already has Storybook running elsewhere
 * (e.g. `yarn storybook` in another terminal).
 *
 * Pass-through: anything after `--` is forwarded verbatim to
 * test-storybook. So `qlip-serve-and-test ... -- --shard 1/4`
 * runs a single shard.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { generateBuildId } from '../../fs/output.js';
import { startStaticServer, type IStaticServerHandle } from './static-server.js';
import { runUpload } from './upload.js';

/**
 * Resolve the `test-storybook` binary path. Looks up
 * `node_modules/.bin/test-storybook` relative to the current
 * working directory first — that's where yarn/npm install it.
 * Falls back to the bare command name (PATH lookup), which works
 * when the user invokes us via `yarn qlip-serve-and-test` or
 * `npx qlip-serve-and-test` since both put .bin on PATH.
 *
 * The fallback is also what production looks like when consumers
 * run us from npm scripts; the .bin lookup catches the case where
 * a contributor runs the built CLI directly (`node dist/.../serve-and-test.js`)
 * from a project directory.
 */
const resolveTestRunnerBin = (cwd: string): string => {
  const local = path.join(cwd, 'node_modules', '.bin', 'test-storybook');
  if (existsSync(local)) return local;
  return 'test-storybook';
};

/**
 * The minimal spawn-fn shape we depend on. Allows tests to inject
 * a stub without touching Node's read-only ESM `child_process`
 * binding (vi.spyOn doesn't work on ESM imports).
 */
export type TSpawnFn = (
  command: string,
  args?: readonly string[],
  options?: import('node:child_process').SpawnOptions,
) => ChildProcess;

interface IParsedArgs {
  storybookStatic?: string;
  url?: string;
  port?: number;
  upload: 'auto' | 'force' | 'skip';
  failOnUploadError: boolean;
  testRunnerArgs: string[];
  help: boolean;
}

const USAGE = `qlip-serve-and-test — orchestrate storybook static → test-storybook → upload

Usage:
  qlip-serve-and-test [options] [-- <test-storybook args>...]

Options:
  --storybook-static <dir>      Path to built Storybook (default:
                                ./storybook-static). Ignored if --url
                                is given.
  --url <url>                   Skip the static server and run
                                test-storybook against an existing
                                Storybook URL (e.g. http://localhost:6006).
  --port <port>                 Pin the static-server port. Default:
                                kernel-chosen free port.
  --upload                      Force-run qlip-upload after the test
                                run (default: auto — runs when
                                QLIP_UPLOAD_URL is set).
  --no-upload                   Skip qlip-upload entirely.
  --fail-on-upload-error        Forward to qlip-upload — exit non-zero
                                on upload failure.
  -h, --help                    Show this help.

Env vars (passed through to test-storybook + qlip-upload):
  QLIP_UPLOAD_URL               Server base URL (required to upload).
  QLIP_PROJECT                  Project name.
  QLIP_UPLOAD_TOKEN             Bearer token if the server requires it.
  QLIP_BUILD_ID                 Shared build id for sharded CI.
  QLIP_OUTPUT_DIR               Where qlipCapture writes screenshots.

Examples:
  qlip-serve-and-test
  qlip-serve-and-test --storybook-static ./out/storybook
  qlip-serve-and-test -- --shard 1/4
  qlip-serve-and-test --url http://localhost:6006 --no-upload
`;

const parseArgs = (argv: string[]): IParsedArgs => {
  const args: IParsedArgs = {
    upload: 'auto',
    failOnUploadError: false,
    testRunnerArgs: [],
    help: false,
  };
  let passThrough = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passThrough) {
      args.testRunnerArgs.push(arg);
      continue;
    }
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '--':
        passThrough = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--storybook-static':
        args.storybookStatic = next();
        break;
      case '--url':
        args.url = next();
        break;
      case '--port': {
        const raw = next();
        const parsed = raw ? Number.parseInt(raw, 10) : NaN;
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`Invalid --port value: ${raw ?? '(missing)'}`);
        }
        args.port = parsed;
        break;
      }
      case '--upload':
        args.upload = 'force';
        break;
      case '--no-upload':
        args.upload = 'skip';
        break;
      case '--fail-on-upload-error':
        args.failOnUploadError = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
      // ignore bare positionals (reserved for future use)
    }
  }
  return args;
};

/** Spawn test-storybook with stdio inherit. Resolves with exit code. */
const runTestStorybook = (
  url: string,
  extraArgs: string[],
  logger: { log: (m: string) => void; error: (m: string) => void },
  spawn: TSpawnFn,
  childEnv: NodeJS.ProcessEnv,
): { promise: Promise<number>; child: ChildProcess } => {
  const args = ['--url', url, ...extraArgs];
  const command = resolveTestRunnerBin(process.cwd());
  logger.log(`[qlip] ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: childEnv,
  });
  const promise = new Promise<number>((resolve, reject) => {
    child.on('error', (err) => {
      reject(
        new Error(
          `failed to spawn test-storybook: ${err.message} — is @storybook/test-runner installed?`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (signal) {
        // Killed by a signal — surface as non-zero exit.
        resolve(128 + 1);
      } else {
        resolve(code ?? 0);
      }
    });
  });
  return { promise, child };
};

export interface IRunServeAndTestResult {
  exitCode: number;
  /** The URL the test-runner ran against (handy for tests/logs). */
  url?: string;
  /** Test-storybook's exit code, even when upload changed the final code. */
  testRunnerExitCode?: number;
}

/**
 * Programmatic entry — same shape as `runUpload`. Tests use this to
 * avoid spawning the CLI process directly.
 */
export const runServeAndTest = async (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  logger: { log: (m: string) => void; error: (m: string) => void } = console,
  /**
   * Override `child_process.spawn` for testing. Production uses
   * Node's spawn. Stubbed in unit tests so we don't actually
   * launch test-storybook.
   *
   * Cast: Node's spawn has many overloads; we only use the
   * (command, args, options) shape, so narrow it to TSpawnFn.
   */
  spawnFn: TSpawnFn = nodeSpawn as unknown as TSpawnFn,
): Promise<IRunServeAndTestResult> => {
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

  if (parsed.url && parsed.storybookStatic) {
    logger.error(
      'qlip-serve-and-test: --url and --storybook-static are mutually exclusive',
    );
    return { exitCode: 1 };
  }

  // Pin the build ID for this run BEFORE spawning test-storybook,
  // so:
  //   1. Every qlipCapture call across every Jest worker uses the
  //      same buildId (otherwise each worker generates its own
  //      timestamp-based ID, fragmenting one logical build across
  //      many directories).
  //   2. The subsequent qlip-upload step targets exactly THIS run's
  //      directory rather than picking "newest by mtime" — which
  //      had previously selected a stale build dir from a prior
  //      failed run (see docs/RUNNER_QORUS_IDE_REPORT.md, Bug #2).
  //
  // Respect a consumer-provided QLIP_BUILD_ID (e.g. ${{ github.sha }}
  // in CI matrix). Generate one otherwise.
  const runBuildId = env['QLIP_BUILD_ID'] ?? generateBuildId();
  const runOutputDir = path.resolve(
    env['QLIP_OUTPUT_DIR'] ?? './qlip/screenshots',
  );
  const runBuildDir = path.join(runOutputDir, runBuildId);
  // Mutate the env we pass to the child so qlipCapture picks it up.
  // We don't touch process.env directly — only the env handed to
  // the spawned test-storybook.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    QLIP_BUILD_ID: runBuildId,
  };

  let serverHandle: IStaticServerHandle | null = null;
  let url: string;
  if (parsed.url) {
    url = parsed.url;
  } else {
    const staticDir = path.resolve(
      parsed.storybookStatic ?? './storybook-static',
    );
    try {
      serverHandle = await startStaticServer({
        rootDir: staticDir,
        ...(parsed.port !== undefined ? { port: parsed.port } : {}),
      });
      url = serverHandle.url;
      logger.log(`[qlip] serving ${staticDir} at ${url}`);
    } catch (err) {
      logger.error(
        `qlip-serve-and-test: failed to serve storybook-static: ${(err as Error).message}`,
      );
      return { exitCode: 1 };
    }
  }

  // Install signal handlers BEFORE spawning the child so a quick
  // Ctrl-C still tears things down.
  let testRunnerChild: ChildProcess | null = null;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (testRunnerChild && !testRunnerChild.killed) {
      try {
        testRunnerChild.kill(sig);
      } catch {
        /* ignore */
      }
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let testRunnerExitCode = 0;
  try {
    const { promise, child } = runTestStorybook(
      url,
      parsed.testRunnerArgs,
      logger,
      spawnFn,
      childEnv,
    );
    testRunnerChild = child;
    testRunnerExitCode = await promise;
  } catch (err) {
    logger.error(`qlip-serve-and-test: ${(err as Error).message}`);
    return {
      exitCode: 1,
      url,
      ...(serverHandle !== null
        ? await serverHandle.close().then(() => ({}))
        : {}),
    };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  // Tear down the static server before running upload — frees the
  // port and signals to any orchestrators that the long-lived
  // service is done.
  if (serverHandle !== null) {
    await serverHandle.close();
  }

  // Upload phase. Run unless skipped or auto-mode and no URL set.
  const shouldUpload =
    parsed.upload === 'force' ||
    (parsed.upload === 'auto' && env['QLIP_UPLOAD_URL']);

  if (!shouldUpload) {
    if (parsed.upload === 'auto') {
      logger.log('[qlip] skipping upload (QLIP_UPLOAD_URL not set)');
    }
    return { exitCode: testRunnerExitCode, url, testRunnerExitCode };
  }

  logger.log('[qlip] running qlip-upload...');
  // Pass the pinned --build-dir so the upload step targets the
  // directory this run wrote to, not whatever happens to be newest
  // by mtime under outputDir. Fixes the stale-pickup bug from
  // RUNNER_QORUS_IDE_REPORT.md Bug #2.
  const uploadArgs: string[] = ['--build-dir', runBuildDir];
  if (parsed.failOnUploadError) uploadArgs.push('--fail-on-upload-error');
  const uploadResult = await runUpload(uploadArgs, childEnv, logger);

  // If the test run already failed, surface THAT — the upload's
  // outcome is secondary. The exception is --fail-on-upload-error
  // with a successful test run; then upload's failure wins.
  let exitCode = testRunnerExitCode;
  if (testRunnerExitCode === 0 && uploadResult.exitCode !== 0) {
    exitCode = uploadResult.exitCode;
  }

  return { exitCode, url, testRunnerExitCode };
};

// NOTE: bin entry lives at `./serve-and-test-bin.ts`. See
// `./upload.ts` for the rationale (same pattern: separate library
// from script to keep this file ESM/CJS-portable).

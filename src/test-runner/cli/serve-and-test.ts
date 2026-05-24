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
  /**
   * Number of test-storybook shards to run sequentially. `1` (the
   * default) is the historical single-process behavior. Higher
   * values loop test-storybook N times, each in its own subprocess
   * (so Node module-cache memory resets between shards), each
   * passing `--shard k/N` to test-storybook. All shards share the
   * pinned QLIP_BUILD_ID so they write manifest fragments into the
   * same buildDir; the single post-loop upload aggregates them.
   *
   * Why an orchestrator-level loop instead of consumer's CI matrix:
   * for local dev / a single-host CI runner, this is the only way
   * to land all N shards as ONE build in the dashboard (each
   * matrix-cell upload would otherwise hit DUPLICATE_BUILD on the
   * second shard).
   */
  shards: number;
  /**
   * When `true`, a non-zero shard exit does NOT stop the loop —
   * subsequent shards still spawn and contribute their captures.
   * The orchestrator's final exit code is the LAST non-zero shard
   * exit (or 0 if every shard passed).
   *
   * Use case: **visual regression demos and dashboards**, where a
   * shard exit code says "some play function asserted false" — the
   * SCREENSHOT for that story still got captured, and the dashboard
   * is where we want to *see* the regression. Stopping at shard 1
   * just because story 27 of 158 failed an assertion would lose
   * coverage on the other 7 shards.
   *
   * Default (`false`) preserves the CI-style stop-on-first-failure
   * semantics that match `vitest --shard`.
   */
  continueOnFailure: boolean;
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
  --shards <n>                  Run test-storybook N times sequentially
                                with --shard k/N appended. Each shard
                                is a fresh subprocess (Node module
                                cache resets between shards, so memory
                                doesn't accumulate). All shards share
                                the pinned QLIP_BUILD_ID and merge
                                into ONE build at upload time.
                                Default: 1 (no sharding).
                                Mutually exclusive with passing
                                --shard k/N after \`--\`.
  --continue-on-failure         When a shard exits non-zero, continue
                                with the remaining shards instead of
                                stopping. Final exit code is the LAST
                                non-zero shard exit (or 0 if all
                                passed). Useful for visual-regression
                                demos where assertion failures don't
                                invalidate the captured screenshots.
                                Default: off (stop on first failure,
                                matching \`vitest --shard\`).
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
    shards: 1,
    continueOnFailure: false,
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
      case '--shards': {
        const raw = next();
        const parsed = raw ? Number.parseInt(raw, 10) : NaN;
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(
            `Invalid --shards value: ${raw ?? '(missing)'} (must be a positive integer)`,
          );
        }
        args.shards = parsed;
        break;
      }
      case '--continue-on-failure':
        args.continueOnFailure = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
      // ignore bare positionals (reserved for future use)
    }
  }
  // Validate cross-flag invariants AFTER all args are collected so
  // the order user passed them doesn't change the message.
  if (args.shards > 1 && args.testRunnerArgs.includes('--shard')) {
    throw new Error(
      '--shards <n> is mutually exclusive with passing --shard k/N after `--`. ' +
        'The orchestrator owns the --shard flag when --shards is set; ' +
        'drop your manual --shard arg or remove --shards.',
    );
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
  /**
   * **Count** of shards that finished with exit 0 (not the index
   * of the last one — see the older revision history if confused).
   * With the default stop-on-first-failure path, this is either
   * `N` (all passed) or `K` where shard K+1 was the failure. With
   * `--continue-on-failure`, this may be less than `shardsRan`
   * (e.g. 6 if shards 3 and 7 failed but all 8 ran).
   */
  shardsCompleted?: number;
  /**
   * How many shards the loop actually spawned. With the default
   * stop-on-first-failure, equals `shardsCompleted` (until the
   * failure) or `shardsCompleted + 1` (the failing shard ran but
   * didn't complete-as-success). With `--continue-on-failure`,
   * equals N — every shard ran regardless of outcome.
   */
  shardsRan?: number;
  /**
   * Shard indices (1-based) that exited non-zero. Empty when
   * everything passed. Useful for tests asserting the
   * continue-on-failure path actually visited all shards.
   */
  shardsFailed?: number[];
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
  let shardsCompleted = 0;
  let shardsRan = 0;
  const shardsFailed: number[] = [];
  try {
    // Single-shard fast path: no per-iteration log noise, no --shard
    // arg passed at all. Behaviour is byte-identical to the
    // pre-multi-shard implementation.
    if (parsed.shards === 1) {
      const { promise, child } = runTestStorybook(
        url,
        parsed.testRunnerArgs,
        logger,
        spawnFn,
        childEnv,
      );
      testRunnerChild = child;
      testRunnerExitCode = await promise;
      shardsRan = 1;
      if (testRunnerExitCode === 0) shardsCompleted = 1;
      else shardsFailed.push(1);
    } else {
      // Multi-shard path: spawn sequentially. Each child gets a
      // unique `--shard k/N` appended to its args. They all share
      // childEnv (so QLIP_BUILD_ID is identical) — the writes land
      // under one buildDir and the post-loop upload merges every
      // fragment into one build.
      //
      // Default: stop-on-first-failure, matching `vitest --shard`
      // semantics and what most users expect from a CI orchestrator.
      // With `--continue-on-failure`, log the failing shard and
      // keep going so the dashboard ends up with every shard's
      // captures merged in — the right default for visual-regression
      // demos where assertion failures don't invalidate the
      // captured screenshots.
      logger.log(
        `[qlip] running ${String(parsed.shards)} shards sequentially (buildId=${runBuildId})${
          parsed.continueOnFailure ? ' [continue-on-failure]' : ''
        }`,
      );
      for (let k = 1; k <= parsed.shards; k += 1) {
        logger.log(
          `[qlip] shard ${String(k)}/${String(parsed.shards)} starting`,
        );
        const shardArgs = [
          ...parsed.testRunnerArgs,
          '--shard',
          `${String(k)}/${String(parsed.shards)}`,
        ];
        const { promise, child } = runTestStorybook(
          url,
          shardArgs,
          logger,
          spawnFn,
          childEnv,
        );
        testRunnerChild = child;
        // eslint-disable-next-line no-await-in-loop -- intentional: sequential by design (memory reset between shards)
        const shardExitCode = await promise;
        shardsRan = k;
        if (shardExitCode !== 0) {
          shardsFailed.push(k);
          // Last-non-zero wins for the orchestrator's final exit
          // code — CI cares "did anything fail" more than which
          // specific shard's code it was.
          testRunnerExitCode = shardExitCode;
          if (parsed.continueOnFailure) {
            logger.error(
              `[qlip] shard ${String(k)}/${String(parsed.shards)} exited ${String(shardExitCode)} — continuing (--continue-on-failure)`,
            );
            continue;
          }
          logger.error(
            `[qlip] shard ${String(k)}/${String(parsed.shards)} exited ${String(shardExitCode)} — stopping`,
          );
          break;
        }
        logger.log(
          `[qlip] shard ${String(k)}/${String(parsed.shards)} ok`,
        );
        // Count successful shards (not the index). With
        // stop-on-first-failure the two are interchangeable, but
        // with --continue-on-failure "index of last successful"
        // would be wrong (e.g. shards 1,4,7 succeed → count=3,
        // index=7).
        shardsCompleted += 1;
      }
    }
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
    return {
      exitCode: testRunnerExitCode,
      url,
      testRunnerExitCode,
      shardsCompleted,
      shardsRan,
      shardsFailed,
    };
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

  return {
    exitCode,
    url,
    testRunnerExitCode,
    shardsCompleted,
    shardsRan,
    shardsFailed,
  };
};

// NOTE: bin entry lives at `./serve-and-test-bin.ts`. See
// `./upload.ts` for the rationale (same pattern: separate library
// from script to keep this file ESM/CJS-portable).

#!/usr/bin/env node

/**
 * Bin entry for the `qlip-serve-and-test` orchestrator CLI. See
 * `./upload-bin.ts` for the rationale (library/bin split for
 * ESM/CJS portability).
 */

import { runServeAndTest } from './serve-and-test.js';

void runServeAndTest(process.argv.slice(2)).then((result) => {
  process.exit(result.exitCode);
});

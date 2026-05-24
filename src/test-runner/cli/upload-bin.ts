#!/usr/bin/env node

/**
 * Bin entry for the `qlip-upload` CLI. Pure trampoline — calls the
 * `runUpload` library function and exits with its result code.
 *
 * Separated from `./upload.ts` so the library file stays
 * import-safe (no top-level side effects, no `import.meta`-vs-
 * `require.main` detection), which lets us emit it in both ESM and
 * CJS builds for the test-runner library export.
 */

import { runUpload } from './upload.js';

void runUpload(process.argv.slice(2)).then((result) => {
  process.exit(result.exitCode);
});

# Task: multi-test-file manifest aggregation

**Status:** fixed 2026-05-22
**Found:** 2026-05-22, via `qlip-playground` (private test repo at
`/Users/nick/Projects/qlip-playground/`)
**Severity:** was ships-blocker for any project with more than one
`*.stories.tsx` file.

## Fix landed

Implemented the two-stage approach from the proposal:

- **`src/runtime/context.ts`**: each browser context gets a unique
  `fragmentId` at runtime-init time.
- **`src/runtime/screenshot.ts`**: every capture writes the full
  in-memory manifest to
  `<buildDir>/manifest-fragments/<fragmentId>.json` instead of
  overwriting `manifest.json`. The shared constant
  `MANIFEST_FRAGMENT_DIR` lives in `src/fs/output.ts` so the
  browser runtime can reference it without dragging `node:fs` into
  the browser bundle.
- **`src/upload/manifest.ts`** (new): `mergeManifestFragments`
  reads every fragment, sorts deterministically by `createdAt`,
  concatenates entries, sums stats, writes the canonical
  `manifest.json`.
- **`src/upload/reporter.ts`**: `QlipUploadReporter.onTestRunEnd`
  always merges fragments first; the upload step is now optional
  (no-op when `upload` is absent), so non-upload users still get
  `manifest.json`. Success log now includes the fragment +
  entry counts for visibility.
- **`src/plugin/vitestPlugin.ts`**: reporter is registered
  unconditionally (so the merge always runs); `configResolved`
  creates `manifest-fragments/`; `config` adds the resolved
  output dir to vite's `server.fs.allow` so
  `commands.writeFile` doesn't deny subdirectory writes when the
  output dir lives outside the project root (e.g. CI artifact
  paths, test tmpdirs).

Tests added: `tests/upload/manifest.test.ts` (8 cases — missing
dir, empty dir, two-fragment merge, deterministic sort, output
write, summed stats, non-JSON files ignored, build-level field
preservation). Existing 36 unit tests + the storybook e2e remain
green.

Verified against `/Users/nick/Projects/qlip-playground/`:
```
[qlip] uploaded build 20260522-032759 (3 fragments, 16 entries) → http://localhost:3100
```
Three test files produced three fragments; all 16 entries (8 Button
+ 5 Counter + 3 ProfileBadge) reached the server, vs the broken
state's 5.

## Symptom

Run vitest browser-mode against multiple `.stories.tsx` files with the
upload reporter enabled. Watch `manifest.json` and the resulting
server-side build:

- On disk, `qlip/screenshots/<buildId>/stories/auto/` correctly
  contains one PNG per story across all test files.
- `qlip/screenshots/<buildId>/manifest.json` contains entries from
  **only the last test file Vitest executed.**
- The upload reporter reads `manifest.json` and uploads only those
  entries. Earlier test files' captures are stranded on disk and
  never reach `qlip-server`.

Concretely the playground's first verification run captured 13 auto
screenshots on disk (8 Button + 2 Counter + 3 ProfileBadge) plus 3
manual (Counter), but `manifest.json` listed only the 5 Counter ones
and `stats.storiesTotal=2, capturedAuto=2, capturedManual=3` reflected
that subset.

## Root cause

`src/runtime/screenshot.ts` keeps the manifest in module-level state
initialized by `initRuntimeState()`. In vitest browser-mode every test
file runs in its own browser context (iframe/page), each with its own
module graph — so each gets a **fresh, empty manifest**. After every
capture the runtime serializes its in-memory manifest in full and
calls `commands.writeFile('manifest.json', JSON.stringify(...))`
(`screenshot.ts:507–511` and similar in the skipped/manual paths).
That's a Node-side write through vitest's commands bridge, and it
clobbers whatever earlier test files wrote.

Counter ran last in the playground, so its 5 entries (2 auto + 3
manual) became the entire on-disk manifest. The upload reporter
(`upload/reporter.ts`) runs after all test files complete, reads
`manifest.json` from disk, and only sees those 5 — matching exactly
what the server received.

This is **not** a vitest configuration issue. Even with
file-parallelism disabled the writes still serialize incorrectly,
because each fresh module re-initializes the in-memory manifest to
empty and then writes the full state.

## Proposed fix

Two-stage manifest assembly:

1. **Per-context fragment writes.** Each browser context's runtime
   writes its entries to `manifest-fragments/<random-uuid>.json` (one
   file per browser context, written incrementally via
   `commands.writeFile` after each capture). The fragment contains:
   - the build-level fields (buildId, createdAt, tool, defaults,
     outputDir) — these are identical across contexts, last-write-wins
     is fine, OR move them out of fragments and emit them once from
     the plugin's `configResolved` hook;
   - the entries this context captured;
   - this context's partial stats.

2. **Reporter-side merge.** `QlipUploadReporter.onTestRunEnd` (Node)
   reads every fragment in `manifest-fragments/`, merges entries
   (concatenate) and stats (sum the per-context counters), writes the
   final `manifest.json`, then proceeds with the existing upload
   logic. Delete the fragments directory after a successful merge.

This avoids the need for any atomic-write coordination during the
test run. Each test file owns its fragment exclusively; the merge
happens once, single-threaded, after every test file has finished.

## Acceptance criteria

- Run the playground (`/Users/nick/Projects/qlip-playground/`) with
  `QLIP_UPLOAD_URL=http://localhost:3100 yarn test:stories`. The
  resulting build on the server must contain **all 14 snapshots**
  (8 Button + 3 Counter Auto/Stopped/auto + 3 Counter manual at
  count-2/count-5/count-10 + 3 ProfileBadge) — totalling 14 entries,
  not 5.
- New unit test in `src/upload/` (or `src/runtime/`) that constructs
  two fragments with disjoint entries and verifies the merged
  manifest contains the union with correctly-summed stats.
- Existing 36 qlip unit tests still green.
- `manifest.json` schema is unchanged — fragments are an internal
  detail; consumers (qlip-server upload route) continue to see the
  same final manifest format.

## Out of scope

- No changes to `qlip-server`'s upload route; the contract from
  `design/UPLOAD.md` doesn't change.
- No multi-process safety beyond test-file isolation (e.g. running
  two `yarn test:stories` simultaneously against the same build dir
  is still undefined behavior — buildId collision is the real risk
  there, not manifest merging).

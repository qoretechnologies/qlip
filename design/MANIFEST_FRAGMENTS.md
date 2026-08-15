# qlip — manifest fragments (the on-disk capture record)

How a browser-side capture becomes a line in `manifest.json`. This is
the contract both capture paths write and the uploader reads; change it
only together with `src/upload/manifest.ts`.

---

## The problem

Captures happen in the browser, one per story, and the manifest they
belong to lives in Node. Three things run at once and none of them can
be coordinated from qlip's side:

1. **Several stories capture concurrently inside one browser context.**
   Under `isolate: false` — the standard configuration for a large
   suite, because isolation costs ~20s per file re-evaluating the
   bundle — Vitest runs several `*.stories.tsx` files in one context,
   sharing one `globalThis` and therefore one `QlipRuntimeState`. Their
   `afterEach` hooks overlap.
2. **Several contexts run in parallel**, each with its own state.
3. **Several processes may share one build directory** — CI that shards
   a suite across `vitest run` invocations pinned to one `--build-dir`
   via `buildId`, uploading once at the end.

## The rule

**One fragment file per capture, written exactly once, never
rewritten.**

```
<buildDir>/manifest-fragments/<fragmentId>-<seq>.json
```

- `fragmentId` — `Date.now()` base36 + 8 random base36 chars, minted
  once per browser context (`src/runtime/context.ts`) or per
  test-runner process (`src/test-runner/manifest-store.ts`). Unique
  across contexts and across processes without coordination.
- `seq` — a per-context counter, claimed synchronously
  (`nextFragmentSeq`) so two overlapping captures can never claim the
  same number.

The pair is unique, so no two writers ever address the same path. That
is the whole mechanism: there is no lock, no queue, and nothing to keep
correct as the code grows.

Each file is a `QlipManifestFragment` — a normal `QlipManifest` whose
`entries` array holds the single capture, plus `fragmentId` /
`fragmentSeq`. Keeping the manifest shape means the merger needs no
special case, and fragments written by an older qlip (a whole manifest,
no id/seq) still merge.

### Why not serialise the writes instead

A promise chain per context also removes the race, and is a smaller
change. It was rejected because it keeps re-serialising the whole
manifest per capture: `isolate: false` + `fileParallelism: false` puts
an entire suite in one context, so a 1700-story run would write ~290 MB
of JSON to record ~350 KB, and a context that dies still loses whatever
its last in-flight write held. Append-only is O(1) per capture, safe
across processes as well as contexts, and leaves a per-capture record
to diagnose from.

## Deletion: tombstones

Append-only has no rewrite, so removing an entry needs an explicit
retraction:

```json
{ "entries": [], "tombstones": [{ "storyId": "x--y", "kind": "error" }] }
```

The only producer today is the retry-mask prune
(`captureAutoScreenshot`): when a story passes on a retry, the error
captures from its failed attempts are no longer real failures. The
merger drops every matching entry **regardless of merge order** — "this
story ultimately passed" is true whenever the tombstone lands.

## The merge

`mergeManifestFragments` (`src/upload/manifest.ts`) at end-of-run:

1. Read every `*.json` in the fragments dir, 64 at a time (a ~1700-story
   run writes ~1700 files; a shared build dir across ~10 CI shards can
   hold ~17k).
2. Sort by `(createdAt, fragmentId, fragmentSeq)`, falling back to the
   file name for pre-append-only fragments. `readdir` order is not
   deterministic; entry order in `manifest.json` must be.
3. Drop tombstoned entries.
4. Dedupe by `(storyId, kind)`, last wins — vite's dep-optimization can
   re-run a story file mid-build (Storybook #33067) and the second
   capture is the more accurate one. The server's `snapshots` primary
   key is `(buildId, storyId, kind)`, so this also keeps the upload
   from being rejected wholesale.
5. Recompute stats from the surviving entries and write
   `manifest.json`.

Fragments are left in place afterwards — they are small, and re-running
the merge is a useful escape hatch.

## The audit (why a partial build can no longer be silent)

The race behind issues #25 / #26 survived for weeks because a build
that lost captures looked exactly like a smaller suite: no error, no
warning, `failed: 0`. After merging, `finalizeBuild` compares the PNGs
on disk against the manifest that claims to describe them
(`src/upload/capture-report.ts`) and:

- writes `<buildDir>/capture-report.json` — entries per context, per
  story file, per kind/status, retractions, and any orphans;
- warns when a PNG has no manifest entry and no tombstone explains it,
  naming examples. Retracted captures are listed separately, not as
  orphans: deleting their PNGs is best-effort and no-ops on Vitest
  versions without a `removeFile` command, and an audit that cries
  wolf on every retry-flaky run is worse than none;
- fails the run when `upload.failOnPartialBuild` (CLI:
  `--fail-on-partial-build`) is set — after uploading, so the evidence
  survives.

The check compares two facts on disk rather than trusting either
producer, so it holds for the Vitest plugin, the test-runner and
standalone `qlip-upload` alike.

`diagnostics: true` on the plugin (or `$QLIP_DEBUG=1`) additionally
logs one line per capture with the story, path, context and sequence.

## How to extend

- **Adding a field to a fragment**: add it to `QlipManifestFragment` as
  optional and make the merger tolerate its absence — a shared build
  dir can hold fragments from two qlip versions at once.
- **Never make a writer revisit a file.** If a future feature needs to
  amend a capture, express it as a new fragment (a tombstone is the
  existing example), not as a rewrite.
- **Keep both capture paths on `fragmentFileName`** (`src/fs/output.ts`)
  so the Vitest runtime and the test-runner store agree by
  construction rather than by two matching literals.

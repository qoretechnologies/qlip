# Task: manifest fragment writes lose captures (issues #25 + #26)

**Status:** fixed 2026-08-15 (phases 1-4).
**Branch:** `fix/manifest-fragment-race`.
**Issues:** [#26](https://github.com/qoretechnologies/qlip/issues/26)
(root cause), [#25](https://github.com/qoretechnologies/qlip/issues/25)
(same root cause + two diagnostics asks).
**Severity:** ships-blocker for any consumer running `isolate: false`
— up to ~2/3 of a suite's captures vanish with `failed: 0` and no
warning, so reviewers approve a build believing they saw everything.

## 1. Root cause (confirmed, not hypothesised)

Line references in this section are to the **pre-fix** code (`develop`
at f1a6c7c).

`writeManifestFragment` ([src/runtime/screenshot.ts:62-73](../src/runtime/screenshot.ts#L62-L73))
serialises the context's **entire** in-memory manifest and writes it to
one file per context, on **every** capture
([:650](../src/runtime/screenshot.ts#L650) skip path,
[:794](../src/runtime/screenshot.ts#L794) normal path). `fragmentId` is
fixed per context ([src/runtime/context.ts:82](../src/runtime/context.ts#L82))
and `pushEntry` mutates one shared array
([src/runtime/context.ts:113](../src/runtime/context.ts#L113)). Nothing
serialises the writes.

When two captures overlap inside one context, both serialise the shared
array and both write the same path. Whichever write **lands** last wins
on disk — and that is not necessarily the one that serialised the most
entries.

Reproduced against current `develop` with a deterministic interleave
(two `screenshot()` calls in one runtime state; capture A's fragment
write gated so it lands after capture B's):

```
[probe] fragment writes: 2 | surviving on disk: ["a--one"]
```

`b--two` is gone. No error, no warning, `failed: 0`.

The arithmetic in #26 corroborates the mechanism rather than a
whole-file-loss one: if the writes of a context complete in random
order, the surviving fragment is the one serialised at a uniformly
random point, so ~half of a context's entries survive on average.

| run | files/context | stories/context | predicted survivors | observed |
|---|---|---|---|---|
| laptop (`isolate: true`) | 1 | ~3.8 | ~3.8 (no overlap) | 3.9 |
| 16-core runner | 2.7 | ~12 | ~6 | 6.65 |
| ARC pod (8 CPU) | 6 | ~27 | ~13.5 | 8.75 |

The comment above `fragmentId` states the assumption that broke: "each
context is its own process / module graph, so two contexts can't race
here". True under `isolate: true`. Under `isolate: false` several test
files share one context and their `afterEach` hooks overlap — the race
is *between files inside one context*, not between contexts.

### Why #25 is the same bug

#25's own hypothesis (fragment names derived from a worker index that
restarts per chunk) is **not supported**: `fragmentId` is
`Date.now()` base36 + 8 random base36 chars, unique per context and per
process, so sequential chunks sharing a `--build-dir` cannot collide.
Nothing in the plugin ever clears the build dir, so chunks accumulate
correctly.

What #25's numbers actually show is the context-sharing shape from #26:

- healthy run — 353 fragments for 365 story files ≈ **one context per
  file** (`isolate: true`), 1465 screenshots, ~4/story-file.
- degraded run — 142 fragments for 382 story files ≈ **2.7 files per
  context**, 856 screenshots.

"More stories, fewer fragments" is the signature of contexts being
shared, and fragment count tracks context count, not story count. So
#25 needs no separate fix — but its two other asks (diagnostics, a
partial-build warning) are real gaps and are covered below.

## 2. Design

**Append-only: one fragment file per capture, written exactly once,
never rewritten.**

Each capture writes `<buildDir>/manifest-fragments/<fragmentId>-<seq>.json`
containing a normal `QlipManifest` object whose `entries` array holds
that single entry (plus `fragmentId` / `fragmentSeq` for ordering).
`seq` is a per-context counter. The merger already tolerates any entry
count per fragment, so the on-disk contract does not change shape.

Why this and not the minimal promise-chain serialisation suggested in
#26:

- **Kills the class, not the incident.** No shared mutable state is
  serialised while another write is in flight, because no file is ever
  written twice. Concurrency between files, between contexts, between
  chunked processes sharing a build dir (#25's shape) — all safe by
  construction rather than by a lock we have to keep correct.
- **O(1) per capture instead of O(entries).** A promise chain still
  rewrites the whole manifest per capture; with `isolate: false` and
  `fileParallelism: false` one context can hold the entire suite, so a
  1700-story run writes ~290 MB of JSON to say ~350 KB.
- **A context that dies mid-run keeps everything it already captured**
  instead of losing whatever the last in-flight write held.
- **Per-capture forensics for free** — the fragment set *is* the
  diagnostic record #25 asks for.

Cost: ~1700 small files per run (~17k for a 10-chunk shared build dir)
in one directory, read once at merge. Fine on every filesystem we
target; if it ever isn't, shard by `fragmentId` prefix — not now.

### Deletions need tombstones

The retry-mask prune ([src/runtime/screenshot.ts:929-963](../src/runtime/screenshot.ts#L929-L963))
currently removes stale `error` entries from the in-memory manifest and
relies on the *next* whole-manifest rewrite to drop them from disk.
Append-only has no rewrite, so the prune must write a tombstone
fragment: `{ …skeleton, entries: [], tombstones: [{ storyId, kind: 'error' }] }`.
The merger drops every matching entry regardless of ordering — the
semantic is "this story ultimately passed, so no error capture for it
is real", which is order-independent. Bonus: the manifest now stays
truthful even on Vitest versions with no `removeFile` command, where
today only the PNG cleanup is best-effort.

## 3. Work

### Phase 1 — the fix (issues #25 + #26) ✓

- [x] `src/runtime/context.ts` — add `fragmentSeq` to
      `QlipRuntimeState`; `nextFragmentSeq(state)` helper; rewrite the
      stale "two contexts can't race here" comment to state the real
      invariant (one file per capture, never rewritten).
- [x] `src/runtime/screenshot.ts` — `writeManifestFragment` takes the
      single entry (or a tombstone) and writes
      `<fragmentId>-<seq>.json`; call sites at `:650` and `:794` pass
      the entry they just built; the prune path writes a tombstone.
- [x] `src/fs/output.ts` — one shared `fragmentFileName(fragmentId, seq)`
      helper so the runtime and the test-runner store agree by
      construction.
- [x] `src/test-runner/manifest-store.ts` — same append-only write
      (`flushFragmentToDisk` currently rewrites the whole manifest per
      capture), so both capture paths share one on-disk contract.
- [x] `src/upload/manifest.ts` — read fragments with bounded
      concurrency (~64 at a time); sort by
      `(createdAt, fragmentId, fragmentSeq)` with a filename fallback
      for legacy fragments; apply tombstones; keep last-wins dedupe —
      re-keyed onto the server's snapshot identity while implementing
      this, see §5; widen `MergeResult` with `contextCount`,
      `entriesByContext`, `retractedCount`, `retractedPaths` and
      `collisions`.
- [x] `src/upload/finalize.ts` — log entries + contexts rather than a
      raw fragment count (a "fragment" is no longer a context), and log
      a one-line build summary even when upload is disabled (today a
      non-upload run prints nothing at all).

Tests (all must fail against current `develop`):

- [x] `tests/runtime/screenshot.test.ts` — the interleave regression:
      two overlapping captures in one runtime state, capture A's write
      gated to land last; assert both entries survive on disk. Note for
      whoever writes it: Vitest's module mocker mis-resolves
      `@vitest/browser/context` when two captures issue the dynamic
      import *simultaneously*, so stagger the second capture past
      `ensureBrowserContext` with a deferred `page.screenshot` gate
      (that is also a truer model of two `afterEach` hooks).
- [x] fragment filenames unique per capture; tombstone written when the
      retry-mask prune fires.
- [x] `tests/upload/manifest.test.ts` — tombstones applied; ordering
      deterministic across shuffled `readdir` order; legacy
      multi-entry fragments still merge (back-compat); 500-fragment
      merge smoke test.
- [x] cross-process shape (#25): two independent runtime states writing
      into one build dir merge to the union.

### Phase 2 — make a partial build impossible to miss (#25 ask 3) ✓

- [x] `src/upload/capture-report.ts` (new), called from `finalizeBuild` — after the merge, walk
      `<buildDir>/stories/**/*.png` and diff against
      `manifest.entries[].path`. A PNG with no entry is a capture whose
      manifest record was lost: warn loudly with the count and a few
      example paths. Path-independent — it covers the Vitest plugin,
      the test-runner, and standalone `qlip-upload`, and it would have
      surfaced both issues on the first CI run.
- [x] `QlipUploadOptions.failOnPartialBuild` (+ `--fail-on-partial-build`
      on `qlip-upload`) to turn that warning into a non-zero exit.
- [x] Tests: orphan PNGs warn; clean build stays quiet; the flag
      controls the exit code.

### Phase 3 — diagnostics (#25 ask 2) ✓

- [x] Always write `<buildDir>/capture-report.json` at merge time:
      per-context entry counts, per-story-file counts (entries already
      carry `storyFilePath`), tombstones applied, orphan PNGs, totals.
      Small, cheap, and it is what you want when CI has already gone
      home.
- [x] Opt-in per-capture logging (`QLIP_DEBUG=1` or a `diagnostics`
      plugin option): `[qlip] captured <storyId> <kind> → <path>
      (ctx <fragmentId> #<seq>)`.
- [x] Tests for both.

### Phase 4 — executed-vs-captured census ✓ (investigated + built 2026-08-15)

**Verdict was: build it, reporter-side. It is cheaper and sharper than
the estimate that deferred it.** The doubt was whether Vitest's reporter
payload could tell story tests from ordinary ones, and whether it
arrived before the merge. A throwaway probe reporter run against this
repo's storybook project answered both:

```
atRunEnd: {"total":13,"withStoryId":13}
onTestModuleEnd | Button.stories.ts | tests 4 | withStoryId 4 |
  example-button--primary,example-button--secondary,example-button--large,example-button--small
```

- `TestCase.meta().storyId` is populated for **every** story test
  (13/13), so the census names story ids — not just counts. A gap
  report can therefore list exactly WHICH stories never captured,
  which is what #25 asked for and what no other signal provides.
- `onTestModuleEnd` fires per story file **during** the run, so the
  census is complete before either finalize path runs. That kills the
  ordering hazard (the reporter and the globalSetup teardown race to
  finalize, and either can win).
- The invariant to check is `story tests executed == auto entries`
  (captured + skipped + failed), verified on the demo run: 13 tests →
  13 auto entries (+1 manual = 14 total). Manual and error entries are
  extra and must not be counted.
- Cost is an in-memory tree walk in the Node process: no I/O, nothing
  in the browser, no new hook that could fail a user's test.

Against the reported incident it would have printed, on the FIRST
build: `1713 story tests executed, 560 captured — 1153 missing`, plus
the missing ids. That is the difference between one run and three
builds plus a week of elimination.

- [x] `src/upload/census.ts` — symbol-keyed on `globalThis` (same
      pattern as `__QLIP_FINALIZE_CONFIG__`), so whichever path
      finalizes can read it; reporters and globalSetup share the Node
      process. Both task-tree walkers are duck-typed and swallow
      unknown shapes — a throw inside a reporter hook would break a
      run that is otherwise fine.
- [x] `QlipUploadReporter` — `onTestModuleEnd` (V3+) and
      `onFinished(files)` (V2) accumulate `meta.storyId` per module.
- [x] `capture-report.ts` — diffs census vs auto entries into
      `storyTestsExecuted` / `missingStoryIds` / `missingByStoryFile`;
      `finalizeBuild` warns.
- [x] Tests against both lifecycle shapes, plus the three failure
      modes below.

**Verified in a live browser run.** Disabling auto capture on one story
produced, from the real pipeline:

```
[qlip] 1 of 13 story tests produced no capture, across 1 story file
(example-header--logged-in). Expected if those stories set
qlip.auto = false; otherwise they were lost.
```

Without the gap: `storyTestsExecuted: 13`, 13 auto entries, 0 missing.

Design constraints found while investigating — get these wrong and the
check is worse than nothing:

1. **No census means silence, never "everything is missing."** On
   Vitest 2 in workspace mode the reporter can be lifecycle-dead (the
   reason `globalSetup` teardown exists at all), and on V2 the census
   can only be built at `onFinished`, which may lose the race to
   teardown. An absent census is "unknown", not zero.
2. **`auto: false` is not a lost capture.** A story with auto capture
   disabled produces no auto entry by design. Skip the check when the
   resolved default is `auto: false`; per-story overrides are
   invisible from the reporter, so treat the count as advisory and
   never make it fail a build.
3. **Count only tests carrying `meta.storyId`** — a consumer's
   non-story browser tests in the same project would otherwise read as
   missing captures.
4. V2's task-tree shape (`file.tasks[]` + `task.meta`) is unverified
   locally — no Vitest 2 install on this machine. Verify against
   qorus-ide before trusting the V2 branch.

### Phase 5 — docs + release

- [x] `design/MANIFEST_FRAGMENTS.md` — the on-disk contract:
      append-only, tombstones, merge ordering, why contexts are shared.
      Cross-ref from [design/UPLOAD.md](../design/UPLOAD.md) and
      [design/RUNNER.md](../design/RUNNER.md).
- [x] README — diagnostics options, sharded-CI guidance, the new log lines, and a note that
      `isolate: false` is a supported configuration.
- [ ] a beta publish so qorus-ide can verify
      on a real ~1700-story run.
- [ ] Reply on both issues with the confirmed root cause + the fix.

## 4. Acceptance

- [x] The interleave regression test fails on current `develop` and
  passes after Phase 1 — verified by reverting `writeManifestFragment`
  to the pre-fix body: all three new durability tests go red, and green
  again with the fix restored.
- [x] A real browser run (`npm run test -- --project storybook`, 6
  story files) produced 14 fragments across **6 contexts** — contexts
  are shared here, which is the shape that used to lose captures — 14
  manifest entries, 13 PNGs, 0 orphans.
- [ ] A qorus-ide CI run with `isolate: false` yields manifest entries ≈
  stories executed (was ~1/3 on the ARC pod). **Needs a beta publish.**
- [x] Any remaining shortfall prints a warning naming counts and
  examples — no build can be silently partial again.

## 5. Out of scope / follow-ups

- ~~**`(storyId, kind)` dedupe collapses multiple manual screenshots
  per story**~~ — **fixed in this branch instead of deferred.** The
  premise was wrong: qlip-server does not key snapshots on `kind`, it
  derives the primary key as
  `${buildId}-${storyId}-${screenshotName}`
  (`qlip-server/src/utils/transforms.ts`, matching the `snapshots.id`
  contract in its schema). So the old key was wrong in both directions
  — it dropped a story's 2nd and 3rd `screenshot()` calls and every
  error capture after the first on a retried story, while still letting
  a manual `screenshot(ctx, 'auto')` collide with the auto capture and
  take the build down on `snapshots_pkey`. Now keyed on
  `(storyId, screenshotName)`, with genuine collisions reported rather
  than dropped silently.
- **qlip-server: snapshot identity and baseline identity disagree.**
  Baselines are unique on `(projectId, storyId, viewportKey)` — no
  `screenshotName` — so every non-error capture of a story at one
  viewport shares a baseline. That already affects auto-vs-manual, but
  keeping the captures the old key dropped increases the number of
  competitors. **The real fix is server-side** (index + baseline
  filename + migration) and still needs an issue in `qlip-server`; the
  corrected contract — both identities, the required change, and the
  migration — is now specified in `design/UPLOAD.md`
  ("Snapshot and baseline identity"), which is the doc both repos cite.
  Mitigated here in the only way a client can: the audit reports the
  affected captures once per build (`baselineCollisions`) so their
  meaningless diffs are not read as visual change.
- Why a context is shared at all — the consumer's `isolate` setting,
  deliberate.
- `capture.log` in the repo root is a stray file from an unrelated
  project (`@vrt/vrt`) that got committed; delete under
  [.tasks/CHORES.md](CHORES.md).

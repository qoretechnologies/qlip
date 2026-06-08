# qlip — chores

**Status:** ongoing.

Flat checklist of small qlip-side items (≤ ~2 hours each). Add to
the bottom as they come up. Check off when done; leave in place
for history. When something grows complicated enough to need its
own spec, promote to a sibling task file.

## Open

- [x] **`componentName="Unknown"` fallback** — when a manifest
  entry lacks `storyTitle`, the transform falls back to
  `componentName: "Unknown"` (`src/upload/manifest.ts`). Some
  Storybook stories don't propagate `storyTitle` through to
  qlip's capture context. Two options: fix the upstream story
  metadata wiring, OR improve the fallback to derive a component
  name from the `storyId` prefix (e.g. `button--primary` →
  `"button"`). The fallback path is cheaper and covers the
  general case where consumers can't be expected to instrument
  every story. Acceptance: a manifest entry with no `storyTitle`
  produces a sensible `componentName` (`"Button"`, not
  `"Unknown"`); add a unit test in `src/upload/manifest.test.ts`.
  **Done 2026-05-27 (qlip-server side).** The qlip side was
  already covered — `src/runtime/screenshot.ts`'s
  `deriveTitleNameFromStoryId` (lines 148–171) already fills in
  `storyTitle` via a kebab→PascalCase fallback when
  `composeStory()` hides the title (with passing tests at
  `tests/runtime/screenshot.test.ts:241`, `:268`). The actual
  drift was in **qlip-server**: `src/utils/transforms.ts:60`
  still had the old `"Unknown"` literal even though
  `src/services/upload.service.ts:49` already had a
  `deriveComponentName` helper with the storyId derivation.
  Unified by moving `deriveComponentName` into
  `src/utils/transforms.ts`, calling it from both `transformEntry`
  (`manifestJson` blob) and the snapshot-row insertion path —
  the two now agree by construction. Tests updated:
  `transforms.test.ts` swaps the "Unknown" assertion for a
  storyId-derivation assertion, plus a new fallback test for
  unparseable storyIds; `upload.service.test.ts` updated to
  import from the new location. Server suite: 355 → 356 tests
  green. No qlip-side code change needed.

- [x] **Error-capture story-title context propagation** — when
  qlip's `captureOnError` fires from a play function failure, the
  manifest entry lands with `storyTitle: None / storyName:
  storyFn` instead of the actual failing story's id/title. Hides
  the real failing story from the FailureCollection surface in
  qlip-ui. Mentioned in 2026-05-25 PROGRESS.md decision log as a
  follow-up. Look at `src/runtime/screenshot.ts` and
  `src/runtime/error-capture.ts` — the issue is likely that the
  Vitest test context doesn't carry `storyId` through the error
  path. Acceptance: an error-capture entry contains the same
  `storyId` / `storyTitle` / `storyName` as a successful capture
  would have for the same story.
  **Done 2026-05-27.** The fix landed in code at some point after
  the chore was filed — `captureErrorScreenshot` in
  `src/runtime/screenshot.ts` (lines 787–813) now applies the
  same fallback chain as `captureAutoScreenshot`
  (`readStoryFromStore` → `task.suite.name` →
  `deriveTitleNameFromStoryId`). What was missing was an
  explicit test asserting the worst-case scenario (composedStory
  hides title, `task.name` is the `storyFn` tag). Added the
  test "error capture derives storyTitle / storyName from
  storyId when composedStory hides them" in
  `tests/runtime/screenshot.test.ts` (mirrors the auto-capture
  test at line 268). Asserts: storyTitle = "Fields/Service/Webhooks",
  storyName = "New Webhook Can Be Added", and the error payload
  still propagates. Test passes against current code; suite goes
  from 14 → 15 tests in screenshot.test.ts. Full qlip suite: 122
  green (123 total, 1 pre-existing skip).

- [ ] **v0.1.1 release prep** — after the three-repo merge (see
  memory: `qlip-v0-1-1-publish-gated`), publish v0.1.1 to npm.
  Concrete steps: bump version in `package.json`, regenerate
  build artefacts, `yarn publish`, tag the commit `v0.1.1`, push
  the tag. Update `README.md` install instructions if anything
  changed. **Do not do this before the merge.**

## Done

_None yet._

# qlip — Standalone runner (Storybook test-runner mode)

A second capture path for qlip that **doesn't depend on the consumer's
Vitest version**. Built on top of `@storybook/test-runner` (the same
piece Chromatic uses under the hood). Sits alongside the existing
Vitest plugin path; both pump captures into the same upload protocol
and the same review UI.

> Status: **design only — not implemented.** Tracking lives in
> `qlip/.tasks/STANDALONE_RUNNER.md`. Update this doc and the tracker
> together when the design moves.

---

## Why this exists

The existing Vitest plugin couples qlip to a specific Vitest major
version (currently `^4.0.0` via `peerDependencies`). Real-world
consumers don't all upgrade in lockstep — `qorus-ide` is pinned to
Vitest `^2.1.4` (Storybook 8.5 compat) and can't consume our newest
qlip without breaking its own test setup. Asking every consumer to
align their Vitest with ours is unrealistic.

Chromatic dodges this by **decoupling capture from the consumer's
test runner**: their cloud builds the consumer's Storybook, renders
each story in their own Playwright, and screenshots. The consumer's
test runner is irrelevant.

We can do the same thing locally + self-hosted by using
`@storybook/test-runner` — Storybook's official Playwright-driven
story runner. It ships its own Jest internally, doesn't touch the
consumer's Vitest, and exposes `preVisit` / `postVisit` hooks
designed for exactly this kind of plugin.

The Vitest plugin stays. It's still the fastest path for greenfield
projects on the latest Vitest (stories run as Vitest tests, no extra
process). The runner is the **compatibility path** for everyone else.

<!-- Decision: see PROGRESS.md 2026-05-22 — Standalone runner direction -->

---

## What the consumer experience looks like

```bash
# 1. Build the consumer's Storybook (whatever Storybook version, any
#    test-runner pinning, any Vitest pinning — qlip doesn't care).
yarn build-storybook

# 2. Capture + upload via qlip-runner.
QLIP_UPLOAD_URL=http://localhost:3100 \
QLIP_PROJECT=qorus-ide \
yarn qlip-runner --storybook-static ./storybook-static
```

That's the whole UX. No `vitest.workspace.ts` editing, no plugin
wiring, no peer-dep gymnastics. The runner serves the static bundle
on a free port, drives `@storybook/test-runner` against it, captures
every story (or a filtered subset via `--tags`), writes the
manifest, and POSTs to qlip-server.

Programmatic API for users who want to embed:

```ts
import { runQlipCapture } from '@qoretechnologies/qlip/runner';

await runQlipCapture({
  storybookStatic: './storybook-static',
  upload: { serverUrl: 'http://localhost:3100', project: 'my-app' },
  // Optional: pass the same QlipCaptureOptions the Vitest plugin
  // accepts. Story-level `parameters.qlip` still wins per-story.
  defaults: { viewport: { width: 1280, height: 720 } },
});
```

---

## Architecture

Three actors in the same Node process:

```
┌──────────────────────────────────────────────────────────────┐
│ qlip-runner CLI (this design)                                │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────┐                │
│  │ static-server│    │ test-runner driver   │                │
│  │ (http-server)│───▶│ (jest + playwright)  │                │
│  └──────────────┘    │                      │                │
│         ▲            │  preVisit  ───┐      │                │
│  storybook-static    │  render+play  │      │                │
│                      │  postVisit ───┴──▶ qlip capture hook  │
│                      └──────────────────────┘     │          │
│                                                   ▼          │
│                              ┌──────────────────────────┐    │
│                              │ shared with Vitest path: │    │
│                              │  - prep (anim/idle/mask) │    │
│                              │  - manifest entry build  │    │
│                              │  - upload                │    │
│                              └──────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
                                          POST /api/builds/upload
                                          (existing protocol)
```

**Static server (optional, only when `--storybook-static` passed):**
spawn `http-server` (or equivalent) bound to a free port, expose the
URL to the test-runner driver, kill it on exit.

**Test-runner driver:** `@storybook/test-runner` invoked
programmatically with a generated `TestRunnerConfig` that wires our
`postVisit` hook. We can also expose a `qlip-runner` flag that just
prints the test-runner config snippet for power users to drop into
their own `.storybook/test-runner.ts`.

**Capture hook:** the `postVisit(page, context)` body. Fires for
every story after render + play function complete. Inside:
1. Read story parameters via `getStoryContext(page, context)` (the
   documented bridge — `context` only has `id/title/name`).
2. Resolve options through the **existing** `resolveQlipOptions()`
   from `src/config/parameters.ts` — same precedence (explicit →
   story → defaults).
3. Inject prep scripts into the page via `page.evaluate()`:
   disable/pause animations, wait for DOM idle, apply ignore masks.
4. `await page.screenshot({ path: <buildDir>/stories/auto/...png })`.
5. Append to an **in-process** manifest (no fragments — see "Manifest
   construction" below).

**End-of-run:** after `@storybook/test-runner` exits, the CLI writes
`manifest.json` and invokes the existing `uploadBuild()` from
`src/upload/upload.ts`. Unchanged wire protocol → no qlip-server
changes needed.

---

## Code layout

Two viable shapes; we pick one in the implementation phase.

### Option A — same package, new subpath export (recommended)

```
qlip/
├── src/
│   ├── plugin/          # existing Vitest plugin (unchanged)
│   ├── runtime/         # existing in-Vitest capture (unchanged)
│   ├── runner/          # NEW
│   │   ├── cli.ts             # bin entry — yargs / arg parsing
│   │   ├── server.ts          # static-server spawn + teardown
│   │   ├── test-runner-config.ts # generates TestRunnerConfig
│   │   ├── capture.ts         # postVisit body — calls prep + screenshot + manifest
│   │   ├── prep.ts            # browser-side prep scripts (page.evaluate strings)
│   │   ├── manifest-store.ts  # single-process manifest accumulator
│   │   └── index.ts           # programmatic API: runQlipCapture()
│   ├── upload/          # existing — REUSED 100%
│   ├── config/          # existing — REUSED 100%
│   ├── fs/              # existing — REUSED 100%
│   └── types.ts         # existing + 1-2 runner-specific additions
├── package.json
│   ├── "bin": { "qlip-runner": "./dist/runner/cli.js" }
│   ├── "exports": {
│   │   ".":         { plugin path },
│   │   "./runner": { runner programmatic API }
│   │ }
│   └── "peerDependencies": {
│       "vitest": "^4.0.0",                  # vitest plugin path
│       "@storybook/test-runner": "^0.21.0"  # runner path
│     }
│   + "peerDependenciesMeta" marking BOTH as optional
└── design/
    └── RUNNER.md (this file)
```

**Pros:** single install, shared internals, no version drift between
"qlip" and "qlip-runner."

**Cons:** consumers see one fat peerDependencies block; `npm` may
nag about missing optional peers even though they don't need them.

### Option B — separate package `@qoretechnologies/qlip-runner`

```
qlip-project/
├── qlip/                # current package — Vitest path only
├── qlip-runner/         # NEW package
│   └── (mirrors layout above; depends on qlip for shared internals)
└── qlip-server/         # unchanged
```

**Pros:** clean dep boundary per consumer use case.

**Cons:** two packages to publish, internal-sharing requires either a
workspace setup or copying code. Adds maintenance overhead.

**Recommendation: Option A.** Use `peerDependenciesMeta` to mark both
runtime peer deps as optional, so the consumer only sees the warning
that matches their path. Re-evaluate if the runner code grows beyond
~1500 LOC or develops fundamentally different release cadence.

<!-- Decision: see PROGRESS.md 2026-05-22 — Standalone runner direction -->

---

## What's reused vs. ported vs. new

| Module | Status | Notes |
|---|---|---|
| `src/upload/upload.ts` | **Reused 100%** | Same multipart wire protocol → server unchanged. |
| `src/upload/manifest.ts` | **Reused (one fragment)** | Runner is single-process — passes one fragment in, gets a manifest out. Same merger code path. |
| `src/upload/autodetect.ts` | **Reused 100%** | Branch/commit detection from `$GITHUB_*` / `git`. |
| `src/upload/reporter.ts` | Not used | Reporter is Vitest-specific. Runner CLI invokes `uploadBuild()` directly. |
| `src/config/parameters.ts` | **Reused 100%** | Pure resolution function — works with any option source. |
| `src/fs/output.ts` | **Reused 100%** | Path construction for `stories/auto/<title>--<name>.png`. |
| `src/types.ts` | **Reused + extended** | Add `QlipRunnerOptions` (storybookStatic, url, tags, etc.). Existing manifest + entry types unchanged. |
| `src/runtime/screenshot.ts` — `applyAnimationControl`, `waitForDomIdle`, `applyIgnoreMasks` | **Ported** to `runner/prep.ts` | Pure DOM code today, but tightly woven with Vitest's `@vitest/browser/context` page API. The runner injects them via `page.evaluate(stringifiedFn)`. |
| `src/runtime/screenshot.ts` — orchestration (`captureScreenshot`, manual screenshot, error capture) | Not ported initially | Runner v1 captures one auto screenshot per story (matches `auto: true` semantics). Manual / error captures are a v2 feature. |
| `src/plugin/vitestPlugin.ts` | Not used | Stays as-is for Vitest consumers. |
| `src/runtime/context.ts` (in-memory state) | Not used | Runner builds its manifest directly in `manifest-store.ts`. |

---

## Capture lifecycle (per story)

```
test-runner navigates to /iframe.html?id=<storyId>&viewMode=story
  │
  ▼
preVisit(page, context)
  │   set viewport (early, before render — Storybook honours pre-render
  │   viewport for some addons like measure / outline)
  ▼
test-runner renders the story + executes play function
  │
  ▼
postVisit(page, context)
  │   1. storyCtx = await getStoryContext(page, context)
  │   2. resolved = resolveQlipOptions({
  │        defaults: cli.defaults,
  │        story: storyCtx.parameters.qlip,
  │      })
  │   3. if resolved.skip → push skipped entry, return
  │   4. if resolved.viewport differs from preVisit's → page.setViewportSize()
  │   5. await page.evaluate(animationControl, resolved)
  │   6. await page.evaluate(waitForDomIdle, resolved)
  │   7. masks = await page.evaluate(applyMasks, resolved.ignoreElements)
  │   8. relativePath = buildAutoScreenshotPath({...})
  │   9. await page.screenshot({ path: absolutePath, fullPage: false })
  │  10. await page.evaluate(removeMasks, masks)
  │  11. manifestStore.push(buildEntry({...}))
  ▼
next story
```

**End of run** (after test-runner exits):
- `manifestStore.write(<buildDir>/manifest-fragments/runner.json)`
- `mergeManifestFragments(<buildDir>)` → `<buildDir>/manifest.json`
- If `upload` configured → `uploadBuild({ buildDir, options })`

---

## CLI surface (v1)

```
qlip-runner [options]

Source (one of):
  --storybook-static <dir>   Path to built Storybook (will be served on a free port)
  --url <url>                Existing Storybook URL (default: http://localhost:6006)

Capture:
  --output-dir <dir>         Where to write screenshots + manifest. Default: ./qlip/screenshots
  --build-id <id>            Override the auto-generated timestamp build ID
  --viewport <WxH>           Default viewport (e.g. 1280x720)
  --include-tags <csv>       Only capture stories with these Storybook tags
  --exclude-tags <csv>       Skip stories with these tags
  --max-workers <n>          Parallel browser contexts. Default: 1 (RAM-safe)
  --browsers <list>          chromium | firefox | webkit (csv). Default: chromium

Upload (env-driven, mirrors Vitest plugin path):
  QLIP_UPLOAD_URL            Required to enable upload
  QLIP_UPLOAD_TOKEN          Required when server has UPLOAD_TOKEN set
  QLIP_PROJECT               Project name (default: "default")
  --fail-on-upload-error     Exit non-zero if upload fails (CI default)
```

**Why env-driven for upload:** matches the playground convention and
keeps secrets out of shell history / CI logs.

**Why default `--max-workers 1`:** lesson learned from the 2026-05-22
OOM incident (40 GB RAM) when test-runner spawned 215 chromium
instances against the linked qlip. Single-fork is the safe default;
power users opt in to parallelism.

---

## qlip-server contract

**No server changes needed.** The wire protocol in
`design/UPLOAD.md` is honoured exactly:

- `manifest.json` shape — unchanged.
- `screenshots[<entry.path>]` field naming — unchanged.
- `project`/`branch`/`commit` text fields — unchanged.

This is the whole point of the architecture: capture path swaps; the
server only ever sees a finished build POST.

The server's `tool` field in `manifest.json` will report
`tool.name = "qlip"` and `tool.version = <package version>` regardless
of capture path. We can optionally add a `tool.runner: "vitest" |
"standalone"` discriminator if it ever becomes useful for analytics
on the qlip-ui side — currently no consumer-side need.

---

## Open questions

These are documented here instead of bypassing the design doc with
ad-hoc decisions later. Add a PROGRESS.md decision log entry when
each is resolved + delete the question from this list.

1. **Static-server library.** `http-server` (mature, zero-config) vs
   `sirv` (smaller, faster). Either works. Lean towards `http-server`
   for familiarity; sirv if dep weight matters.
2. **`@storybook/test-runner` API stability.** Their `preVisit` /
   `postVisit` API has been stable through Storybook 8.x; need to
   confirm Storybook 9 behavior before publishing. Plan to pin
   `peerDependency` to a known-good range and bump explicitly.
3. **Story-level upload-token override.** Currently upload options
   are global. A story could in principle declare a different upload
   target via `parameters.qlip.upload` — declined for v1 because no
   real use case has come up.
4. **Per-story full-page vs viewport-only.** The Vitest plugin path
   currently captures viewport-only. Some consumers may want
   full-page on certain stories (long dashboards). Add
   `parameters.qlip.fullPage: boolean` in v2 — backend already
   accepts whatever PNG size we send.
5. **`manual` screenshots inside play functions.** test-runner's
   page is exposed via `page.exposeBinding`. We can replicate qlip's
   manual `screenshot(name)` API by exposing `window.__qlip_screenshot`
   from `preVisit` and routing it to our capture pipeline. v2.
6. **Error captures.** `auto-error-capture` semantics in the Vitest
   path catch test failures. test-runner reports per-story status —
   we can read it in `postVisit` and trigger an extra capture when
   the story failed. v2.
7. **Manifest fragment vs single-file.** Current Vitest path writes
   per-browser-context fragments because each `.stories.tsx` runs in
   isolation. Runner is one process — could skip fragments. Keeping
   the fragment indirection means `mergeManifestFragments()` is the
   single chokepoint for manifest writes, easier to keep both paths
   in sync. Decision: **keep fragments**, runner writes exactly one.

---

## Effort estimate

| Phase | Subtasks | Days |
|---|---|---|
| **1. Skeleton** | package layout, CLI scaffold (yargs), config loading, `peerDependenciesMeta` markup, bin wiring | 0.5 |
| **2. Test-runner driver** | TestRunnerConfig generator, programmatic invoke of `@storybook/test-runner`, output capture, exit-code propagation | 1.0 |
| **3. Capture hook** | `postVisit` body, `getStoryContext` integration, port prep functions via `page.evaluate`, screenshot wiring | 1.0 |
| **4. Static server** | http-server spawn / port selection / teardown, `--storybook-static` flag, `--url` fallback | 0.5 |
| **5. Manifest + upload** | manifest-store, single-fragment write, `uploadBuild()` invocation, fail-on-error handling | 0.5 |
| **6. Smoke + docs** | E2E against qlip-playground, README update, design doc lock | 0.5 |
| **7. Buffer** | First-time integration unknowns (test-runner quirks, Storybook 8 vs 9 edges, port collisions, etc.) | 1.0 |
| **Total** | | **~5 days** |

Assumptions: solo dev, no qlip-server changes, no qlip-ui changes,
reuses ~60% of existing qlip code. If the open questions in §6 force
us to extend the manifest schema or add server endpoints, add
~2 days per affected layer.

---

## Phasing (post-design)

Tracked in `qlip/.tasks/STANDALONE_RUNNER.md`:

1. **Phase R-1 (Skeleton + driver)** — phases 1-2 above. Output: a
   CLI that runs test-runner against a given URL but doesn't capture
   anything yet.
2. **Phase R-2 (Capture)** — phase 3. Output: screenshots land on
   disk for every story, with prep applied.
3. **Phase R-3 (Static server + manifest + upload)** — phases 4-5.
   Output: end-to-end working `qlip-runner --storybook-static <dir>`
   that uploads to qlip-server. **MVP for the runner.**
4. **Phase R-4 (Polish)** — phase 6. Smoke against `qlip-playground`
   and (with permission) `qorus-ide`. Cut a `0.2.0-beta` release.
5. **Phase R-5+ (v2 features)** — manual screenshots, error
   captures, full-page mode, Storybook 9 verification. Each as its
   own task.

---

## How to extend

When you add a new feature to the runner, follow this order:

### Adding a per-story option (e.g. `fullPage`)

1. Add field to `QlipCaptureOptions` in `src/types.ts` (already shared
   between Vitest + runner paths).
2. Resolve in `src/config/parameters.ts` `resolveQlipOptions()` —
   defaults → story → override.
3. Plumb into `runner/capture.ts`'s `postVisit` body. Use it in the
   `page.screenshot({ fullPage })` call or in a prep step.
4. If the Vitest path should also honour it, plumb into
   `src/runtime/screenshot.ts` in the same change.
5. Add the option to the CLI flag list in `runner/cli.ts` (only when
   a CLI override makes sense — most options are story-parameter-only).
6. Document in the CLI surface table above + add to UPLOAD.md if the
   manifest schema gains a field.

### Adding a new capture kind (e.g. error captures)

1. Add to `QlipEntryKind` in `src/types.ts`.
2. Add path helper to `src/fs/output.ts` if the new kind lives in a
   distinct directory.
3. Trigger from inside `runner/capture.ts` based on story context
   (e.g. test-runner exposes failure state — read it, branch).
4. Mirror in `src/runtime/screenshot.ts` so the Vitest path produces
   identically-named manifest entries.
5. The server side already accepts arbitrary entry paths; no qlip-server
   change unless you want to render this kind specially in qlip-ui.

### Adding a new CLI subcommand (e.g. `qlip-runner discover`)

1. New file under `runner/commands/<name>.ts`.
2. Register in `runner/cli.ts`'s yargs builder.
3. If it reuses test-runner infrastructure, hoist the shared bits
   into a helper module (e.g. `runner/test-runner-config.ts`).
4. Document in the CLI surface table above.

### Supporting a new Storybook major (e.g. 10)

1. Read their changelog for `index.json` schema changes (the field
   most likely to drift).
2. Test against an upgraded `qlip-playground` first.
3. Update the `peerDependency` range on `@storybook/test-runner` if
   they cut a matching release.
4. Add a smoke test fixture per supported major to lock the matrix.
5. Document the support range in the package README.

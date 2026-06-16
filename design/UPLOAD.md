# qlip — Build upload to qlip-server

This document is the **qlip side** of the cross-repo contract for
uploading a finished build to a `qlip-server` instance. Pair it with
`qlip-server/design/UPLOAD.md`, which describes the *server's* view of
the same wire protocol — both docs must stay in sync.

---

## When the upload happens

The upload is wired in by `qlipVitestPlugin` when the `upload` option
is set:

```ts
// vitest.config.ts
import { qlipVitestPlugin } from '@qoretechnologies/qlip';

export default defineConfig({
  test: {
    plugins: [
      qlipVitestPlugin({
        upload: {
          serverUrl: 'http://localhost:3100',
          uploadToken: process.env.UPLOAD_TOKEN, // required when the server has it set
          project: 'my-app',
          // branch + commit auto-detected from $GITHUB_* / git
        },
      }),
    ],
  },
});
```

The plugin registers a Vitest `Reporter` (`QlipUploadReporter`) whose
`onTestRunEnd` hook posts the finished build. Mechanics:

- Runs **once** at the end of the test run, after every captured
  screenshot and the manifest are on disk.
- Doesn't fail the run on upload error by default — set
  `upload.failOnUploadError: true` to make upload failures fatal (CI
  default).
- Reads branch + commit from `$GITHUB_HEAD_REF` / `$GITHUB_REF_NAME` /
  `$GITHUB_SHA` first, falling back to `git rev-parse`. Pass either
  explicitly to skip detection.
- Reads the PR base branch from `$GITHUB_BASE_REF` (PR builds only) and
  the commit ancestry from `git rev-list --max-count=100 HEAD`
  (nearest-first), so the server can resolve a baseline. Both are
  omitted when unavailable; a shallow clone truncates the ancestry and
  triggers a one-time warning (set `actions/checkout` `fetch-depth: 0`).

---

## Wire format

<!-- Decision: see PROGRESS.md 2026-06-11 — Upload protocol v2 -->

qlip uploads via the **content-addressed three-phase protocol**. The
**source of truth for the contract is `qlip-server/design/UPLOAD.md §0`**
(the server owns it); this section records what the client sends and
how it behaves. Client implementation: `src/upload/upload.ts`.

1. **`POST <serverUrl>/api/builds`** — JSON body
   `{ manifest, project?, branch?, commit?, baseBranch?, ancestorCommits? }`
   (`baseBranch` a string, `ancestorCommits` a native JSON array of
   SHAs ordered nearest-first; both omitted when unavailable). Before
   sending, the client stream-hashes every captured screenshot and writes
   `sha256` + `sizeBytes` onto each captured manifest entry
   (`src/upload/hash.ts`). The server replies
   `{ buildId, missing: [sha256, …] }`.
2. **`PUT <serverUrl>/api/builds/:buildId/blobs/:sha256`** — one raw
   `image/png` body per *missing* blob, at most
   `TRANSFER_CONCURRENCY` (10) in flight, each retried up to twice on
   network/5xx errors with a 30 s timeout. Deduped screenshots
   (already on the server) are skipped — a warm cache transfers
   nothing.
3. **`POST <serverUrl>/api/builds/:buildId/finalize`** — no body; the
   server runs diffs and returns `{ build, snapshots }`.

**Legacy fallback.** If `POST /api/builds` returns **404** (a
qlip-server predating the v2 routes), the client transparently falls
back to the original single multipart `POST /api/builds/upload`
(manifest file + one `screenshots[<entry.path>]` part per captured
entry + `project`/`branch`/`commit`/`baseBranch` text fields, with
`ancestorCommits` appended as a **JSON-encoded string** field — all the
metadata fields omitted when unavailable). This keeps the
published client working against older self-hosted servers. The
fallback path is the one that can hit a reverse-proxy `413` on large
builds — the v2 path can't, since each request carries a single
screenshot.

If `uploadToken` is set, every request carries
`Authorization: Bearer <uploadToken>`. The server fail-closes on
mismatch when its own `UPLOAD_TOKEN` env var is non-empty.

`uploadToken` may be **either** a per-project token minted from the
dashboard (`qlt_…`; scoped to one project — uploads to a different
`project` field 403) **or** the server's env-pinned super-admin
`UPLOAD_TOKEN` value (uploads to any project). qlip forwards the
string verbatim and doesn't distinguish them; the scope check is
entirely server-side. Prefer the narrowest token that works — a
per-project token for a single-project CI. See the qlip-server
`design/API.md §0` auth model + `§18` token CRUD, and the
"Authenticating uploads" section of this repo's `README.md`.

### Why field-name-encoding for the path (legacy fallback only)

The v2 protocol addresses screenshots by content hash, so this no
longer applies on the primary path. It still governs the **legacy
fallback** multipart request: a build may have screenshots whose
basenames collide (e.g. `Button/Primary.png` and `Modal/Primary.png`),
and Fastify strips directory components from filenames, so the full
manifest-relative path goes in the multipart field name:

```
Content-Disposition: form-data; name="screenshots[stories/auto/Button--Primary.png]"; filename="Button--Primary.png"
```

The server parses `screenshots\[(.+)\]` on the field name and matches
each part against the manifest's `entry.path`. The filename is not used
for matching.

---

## What's uploaded vs left on disk

- **Uploaded:** `manifest.json` + one PNG per `entries[].status === "captured"` entry.
- **Skipped:** entries with `status === "failed"` or `"skipped"` — their
  rows still go to the server via the manifest, but no PNG is sent.
- **Local-only:** any side files (`logs/*.json` from
  `captureConsole`, etc.) stay on disk. They aren't part of the
  cross-repo contract today; if we surface logs in the dashboard later,
  this section gets updated.

---

## Manifest entry kinds

Every `entries[]` row carries a discriminating `kind`. The contract
between qlip (producer) and qlip-server (consumer) requires the
server to accept all three:

| `kind` | Origin | Server treatment |
|---|---|---|
| `auto` | After-each post-render snapshot taken once per story. | Stored as `kind: 'snapshot'`. Goes through the baseline + diff pipeline. |
| `manual` | An explicit `screenshot()` call inside a play function. | Stored as `kind: 'interaction'`. Goes through baseline + diff. |
| `error` | Screenshot captured at the moment a story's play function **failed**. Triggered automatically from the runtime's `afterEach` when `captureOnError` is enabled and `task.result?.state === 'fail'`. **Always paired with a populated `error.message`** (pulled from `task.result.errors[0]`). | Stored as `kind: 'error'`. **Skips** baseline lookup + diff (there is no "expected" image to compare against). Surfaced in the dashboard's dedicated "Failures" section; review (accept/deny) is disallowed (the server returns 400 on attempts). |

The path for an `error` entry lives under the `error/` subtree
(routed by the `qlip-auto-error-capture*` filename prefix in
`src/fs/output.ts`). The wire format is identical — same multipart
field-name encoding, same PNG payload.

Stat impact: error captures bump `stats.failed` only — they do not
bump `stats.storiesTotal` (the matching auto entry already counted
that story) and do not count as `capturedAuto` or `capturedManual`.

<!-- Decision: see PROGRESS.md 2026-05-24 — Error-capture end-to-end -->

---

## Response shape

The **finalize** response (`201`) — identical to the legacy upload's
response, so consumers are unaffected by the protocol change:

```json
{
  "build": { "id": "...", "status": "pending", ... },
  "snapshots": [ ... ]
}
```

On error (`4xx/5xx`), any phase:

```json
{
  "error": { "code": "DUPLICATE_BUILD", "message": "..." }
}
```

`QlipUploadError` carries the failing `phase`
(`create` | `blob` | `finalize` | `legacy`) and `status` for
diagnostics. The plugin doesn't act on the response beyond logging the
resulting build ID and how many screenshots actually transferred (the
rest being deduped server-side) — the dashboard is where users review
the upload.

---

## Detection rules — branch + commit

The first non-empty value wins:

| Source | Branch | Commit |
|---|---|---|
| Explicit `upload.branch` / `upload.commit` | yes | yes |
| `$GITHUB_HEAD_REF` (PRs) | yes | — |
| `$GITHUB_REF_NAME` (push events) | yes | — |
| `$GITHUB_SHA` | — | yes |
| `git rev-parse --abbrev-ref HEAD` | yes (unless `HEAD` for detached) | — |
| `git rev-parse HEAD` | — | yes |

If nothing matches, the field is omitted from the upload — the server
stores it as null.

## Detection rules — base branch + ancestry

| Source | baseBranch | ancestorCommits |
|---|---|---|
| Explicit `upload.baseBranch` / `upload.ancestorCommits` | yes | yes |
| `$GITHUB_BASE_REF` (PR builds only) | yes | — |
| `git rev-list --max-count=100 HEAD` (nearest-first) | — | yes |

`baseBranch` has no git-local fallback — a base branch only exists in a
PR context, so on push builds it's omitted and the server uses the
project's default branch. `ancestorCommits` is omitted when git is
unavailable or reports nothing. A **shallow** clone returns a truncated
ancestry and emits a one-time warning (`git rev-parse
--is-shallow-repository`); the upload still proceeds. See the
`fetch-depth: 0` note in `README.md`.

---

## How to extend

### Add a new upload field (e.g. another metadata field)

1. Add the field to `QlipUploadOptions` in `src/types.ts`.
2. Include it in the `POST /api/builds` JSON body in
   `src/upload/upload.ts` (and, if the legacy fallback must carry it
   too, in `uploadBuildLegacy`'s `FormData`).
3. Update the server's `createBuildBodySchema` + `uploadFieldsSchema`
   (`qlip-server/src/utils/validation.ts`) and the relevant column on
   the `builds` table if it should persist.
4. Update **both** sides of this contract: this doc and
   `qlip-server/design/UPLOAD.md` (the owner). Reference the same
   decision-log entry from both.

### Replace the upload trigger

The current trigger is Vitest's `onTestRunEnd`. If we ever ship a
standalone CLI (`npx qlip-upload <buildDir>`):

1. Add a `bin` entry in `package.json` pointing at a new CLI module
   under `src/cli/upload.ts`.
2. Reuse `uploadBuild` from `src/upload/upload.ts` — the orchestration
   logic stays unchanged.
3. The reporter remains for the in-test workflow; the CLI covers
   manual + after-the-fact uploads.

### Add a new transfer phase or change the protocol

The wire contract is owned by `qlip-server/design/UPLOAD.md §0`.
Change it there first (server lands the route), then update
`src/upload/upload.ts` and this section in the same cross-repo change,
referencing one decision-log entry from both docs. The current shape
(create → blobs → finalize, with a legacy multipart fallback on 404)
is deliberately the Argos/Chromatic/Percy-style protocol; a future
direct-to-object-storage variant (presigned PUT) would slot in as an
alternative phase-2 transport without changing phases 1 and 3.

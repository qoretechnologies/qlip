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

---

## Wire format

`POST <serverUrl>/api/builds/upload` with `multipart/form-data`:

| Field name | Type | Required | Meaning |
|---|---|---|---|
| `manifest` | file | yes | `manifest.json` body, content type `application/json` |
| `screenshots[<entry.path>]` | file | per captured entry | One file part per captured manifest entry. The entry's `path` is encoded **in the field name brackets**, not in the filename — `@fastify/multipart` strips directory separators from filenames for security. Content type `image/png`. |
| `project` | text | no (defaults `"default"`) | Project name to upload under. |
| `branch` | text | no | Git branch. |
| `commit` | text | no | Git commit SHA. |

If `uploadToken` is set, the request carries
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

### Why field-name-encoding for the path

A given build may have multiple screenshots whose basenames collide
(e.g. `Button/Primary.png` and `Modal/Primary.png`). The natural
multipart attribute for the path would be the filename, but Fastify
strips directory components from filenames. We therefore put the full
manifest-relative path in the multipart field name:

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

On success (`201`):

```json
{
  "build": { "id": "...", "status": "pending", ... },
  "snapshots": [ ... ]
}
```

On error (`4xx/5xx`):

```json
{
  "error": { "code": "DUPLICATE_BUILD", "message": "..." }
}
```

The plugin doesn't act on the response beyond logging the resulting
build ID — the dashboard is where users review the upload.

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

---

## How to extend

### Add a new upload form field

1. Add the field to `QlipUploadOptions` in `src/types.ts`.
2. Append the field to the `FormData` in `src/upload/upload.ts`.
3. Update the server's `uploadFieldsSchema` (`qlip-server/src/utils/validation.ts`)
   and the relevant column on the `builds` table if it should persist.
4. Update **both** sides of this contract: this doc and
   `qlip-server/design/UPLOAD.md`. Reference the same decision-log
   entry from both.

### Replace the upload trigger

The current trigger is Vitest's `onTestRunEnd`. If we ever ship a
standalone CLI (`npx qlip-upload <buildDir>`):

1. Add a `bin` entry in `package.json` pointing at a new CLI module
   under `src/cli/upload.ts`.
2. Reuse `uploadBuild` from `src/upload/upload.ts` — the orchestration
   logic stays unchanged.
3. The reporter remains for the in-test workflow; the CLI covers
   manual + after-the-fact uploads.

### Replace the wire format (e.g. JSON+S3-direct upload)

Out of scope here. Would require a new design doc and a new server
endpoint; this doc would then point at the new one as the source of
truth for "uploads going forward."

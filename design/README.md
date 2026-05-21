# qlip — Design documents

Locked design decisions and "how to extend" guides for the qlip capture
tool. Update in place when decisions change (see
`../../.claude/rules/docs-and-tracking.md` for the doc-update protocol).

## Planned docs

The list below is the scope this folder should eventually cover. Items
are added as they're written — the absence of a doc here means it
hasn't been written yet, not that it's been ruled out.

- **ARCHITECTURE.md** — capture lifecycle: plugin → runtime setup →
  screenshot capture → manifest emit. The major modules and how they
  fit together.
- **CONFIG.md** — three-tier option resolution (explicit call → story
  parameters → plugin defaults), the full option matrix, and the
  precedence rules.
- **MANIFEST.md** — the manifest schema this tool emits, including
  the JSON shape and file layout.
- **UPLOAD.md** ✓ — the qlip-side of the cross-repo upload contract
  with qlip-server. Multipart wire format, the field-name encoding
  for screenshot paths, branch/commit auto-detection, and a
  how-to-extend section. Keep in sync with
  `qlip-server/design/UPLOAD.md`.

## Conventions

- Every doc ends with a **"How to extend"** section listing the steps
  for adding a new component of the kind described (e.g. "How to add
  a new manifest field," "How to add a new capture phase").
- Use `<!-- Decision: see PROGRESS.md YYYY-MM-DD — Title -->` comments
  near sections affected by recent decision-log entries.
- These docs are the *contract*, not a scratchpad. Open exploration
  belongs in chat or in `PROGRESS.md` "Open decisions" until a
  decision is made, then the doc gets updated.

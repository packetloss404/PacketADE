# Project-Local Memory Hub — Scoped Loop

Created: 2026-07-28
Status: source-complete through MH7; MH8/MH9 packaged interoperability gated
Product decision: **Option B — project-native memory inside PacketADE**

## Objective

Extend PacketADE's existing Memory surface with a human-readable,
version-controlled-capable project memory source. Users and agents can inspect
and edit Markdown notes, follow links and backlinks, find orphaned knowledge,
understand provenance, search across project and existing global memory, and
share the same bounded source through PacketADE's MCP provider.

This is a PacketADE capability, not a separate PacketMemory product.

## Product boundary

- Existing persisted/global PacketADE memory remains supported and is not
  destructively migrated.
- Project-local memory is a distinct source class shown inside the existing
  Memory view.
- Notes are Markdown with versioned, machine-readable metadata. The default
  directory and any branding-neutral path convention are frozen in MH1 rather
  than scattered through code.
- Links/backlinks and the graph derive from files; there is no second opaque
  graph database.
- Current IDF retrieval spans eligible global and project-local sources. Local
  embeddings remain separately evidence-gated.
- MCP reads are scoped and bounded. Writes require the existing `allow_writes`
  posture plus project/path validation and an audit entry.
- External file edits are expected. PacketADE watches/reloads safely and never
  silently overwrites a changed note.
- Symlink escapes, oversized files, malformed metadata, binary content, and
  suspected secrets fail closed or become visible warnings.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID      | Item                                | Acceptance condition                                                                                                                                                                                             | Gate                                                               | Depends on    | Status |
| ------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------- | ------ |
| **MH1** | File and metadata contract          | Freeze a branding-neutral configurable project-memory directory, schema version, Markdown/frontmatter fields, stable IDs, link syntax, provenance references, size/count bounds, and Git-ignore behavior.        | Golden fixtures and backward/forward compatibility tests           | —             | closed |
| **MH2** | Safe project-memory repository      | List/read/create/update/archive notes with atomic writes, optimistic revision checks, confinement, symlink defence, malformed-file reporting, and no silent overwrite of external edits.                         | Filesystem, race, path, encoding, and recovery tests               | MH1           | closed |
| **MH3** | Link graph and health               | Resolve Markdown/wiki-style links deterministically and compute backlinks, broken links, and orphans without a second database. Duplicate IDs and ambiguous titles remain visible errors.                        | Graph fixtures, cycles, rename, duplicate, and broken-link tests   | MH1, MH2      | closed |
| **MH4** | Unified retrieval                   | Extend current IDF-ranked search and “Ask your project” context selection across eligible global and project-local memory with source/scope filters and bounded excerpts.                                        | Ranking, dedupe, scope, provenance, and context-budget tests       | MH2           | closed |
| **MH5** | Provenance and capture flows        | Promote a transcript, Flight event, review finding, artifact, or global memory entry into a project note with source references; preserve origin and never copy secrets automatically.                           | Capture fixtures, redaction, idempotency, and missing-source tests | MH1, MH2      | closed |
| **MH6** | Memory Hub UI                       | Add project/global source controls, Markdown note detail/editor, backlinks, graph/list toggle, orphan/broken-link health, external-change warnings, and clear conflict recovery inside the existing Memory view. | Component tests, keyboard/accessibility pass, and visual QA        | MH2–MH5       | closed |
| **MH7** | Scoped MCP surface                  | Expose bounded project-memory search/read/graph resources and permission-gated create/update/archive tools through the existing PacketADE MCP provider and audit controls.                                       | MCP schema, auth, `allow_writes`, confinement, and audit tests     | MH2–MH5       | closed |
| **MH8** | Watch, reload, and interoperability | Coalesce filesystem events, ignore PacketADE's own completed writes, reload external changes, surface conflicts, and keep CLI/editor-authored Markdown interoperable.                                            | Watch-storm, partial-write, rename, reload, and restart tests      | MH2, MH3, MH6 | gated  |
| **MH9** | Migration, regression, and docs     | Offer opt-in copy/export from existing memory without deleting originals; cover empty/large/dirty/gitignored projects and update public/backlog/schema docs.                                                     | Full Vitest/Rust/build gates plus packaged manual smoke            | MH1–MH8       | gated  |

## Frozen contract and implementation record

- Directory: `.agents/memory`; schema: `1`; bounds: 2,000 notes and 256 KiB
  per note. Each Markdown file has YAML frontmatter for stable UUID, title,
  timestamps, archive flag, tags, and provenance IDs.
- `[[Title]]` and Markdown note links resolve deterministically. Duplicate IDs,
  ambiguous titles, broken links, cycles, and orphans are surfaced from the
  files; no graph database is introduced.
- Writes use revision hashes plus temp/backup recovery and refuse stale edits.
  Confinement, symlink, binary, UTF-8, size/count, malformed-metadata, and
  suspected-secret checks fail closed or surface bounded warnings.
- `.agents/memory` is version-control-capable by default. PacketADE never
  changes `.gitignore`; the repository owner chooses whether notes are tracked.
- The existing global memory store remains unchanged. Promotion copies a
  redacted note with provenance references and is idempotent; originals are not
  deleted.
- Focused Rust repository tests compile, frontend capture/retrieval/store/UI
  tests pass, and the unsigned Windows bundle is produced. MH8/MH9 remain
  gated on a real external editor/watch storm, packaged restart/rename
  recovery, dirty/gitignored project smoke, and available macOS/Linux hosts.

## Sequencing

```text
MH1 -> MH2 -> MH3 -> MH6 -> MH8 -> MH9
          \-> MH4 -/       /
          \-> MH5 -/      /
               \-> MH7 --/
```

## Definition of done

- Project knowledge is readable and editable outside PacketADE.
- Links, backlinks, orphans, provenance, and retrieval agree after restart and
  external edits.
- Existing global memory remains available and clearly distinguished.
- MCP consumers receive the same scoped truth without bypassing write policy.
- No cloud memory service, vector database, or standalone PacketMemory app is
  required.

## 2026-08-01 proof refresh

Focused repository, retrieval, capture, Memory UI, and MCP integration tests
pass in the **22-file / 124-test** proof set. No external editor/watch storm or
current packaged restart/rename matrix was run, so MH8/MH9 remain gated. See
[`proof-audit-2026-08-01.md`](../proof-audit-2026-08-01.md).

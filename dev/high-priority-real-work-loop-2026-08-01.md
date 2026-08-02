# High-Priority Real Work Loop — 2026-08-01

Status: **source implementation and independent review complete; external proof remains**

This is the canonical plan and evidence record for the 2026-08-01 pass over
PacketADE's highest-priority source-completable work. It separates real code
gaps from owner decisions and environment-only proof so a green fixture is
never promoted into a packaged or live claim.

## Selection rule

Work entered this loop only when all of the following were true:

1. It was a current P1/P0 correctness, security, or operational-truth gap in
   `backlog.md`, `HANDOFF.md`, or the State of the ADE audit.
2. The current Windows source tree could materially close it without Remote
   Agents, new product authority, unavailable hardware, signing credentials,
   or a real external host.
3. Current source inspection reproduced the gap; a stale ledger claim was
   corrected instead of being reimplemented.
4. The change could be bounded by explicit acceptance tests and independent
   peer review.

That rule deliberately excludes the owner decision on global Undo, the paused
Remote Agents program, signing/updater work, live microphone matrices, and
real packaged/SSH/Git-host/PacketAgent acceptance. Those remain open for the
reason recorded in `backlog.md` and `dev/proof-audit-2026-08-01.md`.

## Loop

### HP1 — Destructive Workspace pane close

Acceptance: closing a terminal pane names the PTY/process consequence; cancel
or Escape changes nothing; explicit confirmation kills the PTY then removes
the pane.

Implementation: `WorkspacePane` now uses the shared confirmation modal through
a portal and an idempotent kill-before-remove path. Focused regression coverage
includes cancel and confirm.

### HP2 — Anthropic edit-approval correlation

Acceptance: every `pending_edit` emitted by the Claude Agent SDK carries the
exact non-empty SDK `toolUseId`; missing correlation fails closed and visibly;
the sidecar protocol and provider agree.

Implementation: protocol v11's pending-edit shape requires `toolUseId`, the
Anthropic provider forwards the exact ID, and a dedicated sidecar smoke covers
the round trip. A live Claude approval remains an external acceptance gate.

### HP3 — Honest operational controls

Acceptance:

- Agent Stop remains **Stopping** until a request-scoped terminal event and
  stays active/retryable on invoke failure.
- Side Chat owns request IDs, request-scoped listeners, backend cancellation,
  startup/close race handling, and a shortcut close that really cancels.
- only one cancel-pending-tools action is presented;
- Monitor-open failures are visible;
- Git commit copy does not claim a review gate the runtime does not enforce.

Implementation: source and focused frontend/Rust regressions are complete.
Independent peer review found and closed the terminal-ack and Side Chat race
boundaries before this item was marked implemented.

### HP4 — Project, SSH, repository, and Git-host authority

Acceptance:

- an SSH Workspace never displays or mutates the retained local fallback path
  or branch;
- Git-host/repository changes clear prior detail and unkeyed caches;
- stale async responses cannot repopulate a new authority scope;
- host activation is serialized/latest-wins, auth is reprobed per host, and a
  failed activation rolls back visibly;
- a remote Workspace does not inherit the prior local Git-host repository;
- GitHub-only AI, checks, draft toggles, and inline review authoring are gated
  on Gitea/Forgejo.

Implementation: authority-epoch guards, serialized activation, repo reset,
remote unbinding, typed shell display/gating, and capability gates are in the
working tree. Independent re-review found no remaining concrete P1/P2 source
defect. A packaged stress run that overlaps a slow host write with a host switch
remains open because the Rust command still selects the process-global active
host at command start.

### HP5 — Settings authority and SSH password security

Acceptance:

- safety/autonomy settings report Saving/Saved/Error from the awaited backend
  result and late writes/hydration cannot replace newer edits;
- unused Agent rail-collapse and unenforced MCP scope/tool settings are hidden;
- SSH passwords exist only in the OS keyring and ephemeral invoke/form data;
- create/update/delete/test form one truthful operation, including credential
  manager errors and partial cleanup;
- every connection-affecting edit invalidates old Test success.

Implementation: the source slice keeps the secret boundary clean. Independent
peer review found trailer-persistence, server-record/keyring atomicity,
credential-error, test-staleness, and legacy-purge issues; all six findings were
fixed and the final review is clean. Packaged OS-keyring behavior and a live
pinned SSH password-authentication run remain external gates.

### HP6 — Implemented-but-awaiting-proof audit

Acceptance: run every proof available on this host; record exact commands and
revisions; keep real hardware, external-service, packaged, cross-platform, and
credential-dependent gates open.

Implementation: the proof team produced `dev/proof-audit-2026-08-01.md`,
rechecked PacketADE plus the PacketAgent and PacketCode siblings, and found no
falsely closed external gate. A separate documentation peer identified stale
provider, retired-S11, and newly closed-source claims; those contradictions were
corrected. Final integrated counts are recorded after the repository-wide
gates; a commit revision and current-package evidence remain intentionally open
because this loop does not create either artifact.

## Exit gates

- focused regression suites for every changed boundary;
- sidecar build/check and Anthropic correlation smoke;
- complete frontend Vitest suite, TypeScript/Vite build, and ESLint;
- complete Rust test suite plus explicit ignored-test accounting;
- `git diff --check` and documentation contradiction/link checks;
- independent source and documentation peer verdicts with every P1/P2 finding
  resolved or explicitly left open with its blocker.

Final integrated source results:

- focused high-priority suite: **15 files / 108 tests**;
- complete frontend suite: **225 files / 1,857 tests**;
- Rust: **600 passed / 0 failed / 3 intentionally ignored/manual**;
- sidecar deterministic build/smoke suite: **pass**;
- ESLint: **0 errors / 9 pre-existing Fast Refresh warnings**;
- TypeScript/Vite production build, configured Prettier check, patch whitespace,
  and relative links across 27 changed Markdown documents: **pass**.

The exact commands, warning disposition, and external-proof matrix are in
`dev/proof-audit-2026-08-01.md`.

No commit, tag, installer, push, live external mutation, or Remote Agents work
is implied by this loop.

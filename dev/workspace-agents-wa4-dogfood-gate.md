# WA4 — Workspace/Agents Attachment Decision

Status: **COMPLETE — OWNER DECISION APPLIED**

Decision date: 2026-07-29

Parent goal:
[`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md)

WA3 evidence:
[`workspace-agents-wa3-handoff-evidence.md`](./workspace-agents-wa3-handoff-evidence.md)

## Final decision

**Retire all creation of new Workspace conversation attachments now. Preserve
load and removal compatibility for panes already saved in old layouts.**

The owner made this product decision directly after reviewing the purpose and
maintenance cost of **Open alongside Workspace**. It explicitly supersedes the
planned seven-day usage threshold. The short observation sample did not prove
the decision and is not represented as doing so.

The resulting responsibility split is:

- **Agents** owns GUI/API-agent creation, conversation operation, approvals,
  plans, reviews, and history.
- **Workspace** owns PacketCode, coding CLIs, terminals, editor, and Git
  workroom presentation.
- **Flight Deck** owns structured delivery and attempt supervision.
- **Monitor** owns detached read-only awareness.

## Removed behavior and code

- The **Open alongside Workspace** action is absent from Agent menus.
- `openConversationAlongsideWorkspace()` and
  `attachConversationToWorkspace()` no longer exist.
- `workspaceStore.addConversationPane()` and
  `workspaceStore.ensureConversationWorkspace()` no longer exist.
- `sessionGlue.openSession()` can no longer materialize wrapper Workspaces.
- The dormant `DraftTile` / `draftTileStore` created-before-insert flow is
  deleted.
- The advisory attachment evaluator and its threshold-driven recommendation UI
  are deleted.
- Agent Git endings and Flight-attempt Workspace handoffs open or reuse the
  matching CLI-first project Workspace without adding a conversation pane.

The normal test suite contains a repository boundary scan that rejects any
reintroduction of these attachment producers.

## Preserved compatibility

This decision does not rewrite or delete user data:

- persisted panes with `kind: "conversation"` and `conversationId` continue to
  normalize and render through `ConversationTile`;
- their underlying durable conversations remain authoritative and resumable in
  Agents;
- closing an old pane removes only its placement;
- deleting a conversation still garbage-collects dangling pane references;
- orphaned old wrapper Workspaces are reconciled without mutating conversation
  files;
- previous-release and old-binary-resave fixtures continue to prove safe
  hydration.

No source API can create a replacement conversation pane after the user closes
one.

## Historical observation record

Before the owner decision, local content-free evidence recorded:

- roughly two hours of observation;
- zero genuine Agent starts;
- zero new Workspace attachments or cross-surface Workspace handoffs;
- five clean migration audits;
- five successful compatibility-pane loads;
- zero compatibility failures, missing references, or orphan wrappers.

No clicks or counters were manufactured. The local schema remains readable as
historical migration diagnostics, but it no longer controls product behavior.

## Verification

- focused attachment-removal, handoff, compatibility, and boundary tests pass;
- TypeScript validation passes;
- the complete frontend suite passes **165 files / 1,255 tests**;
- Rust library tests pass **430 / 430** with two explicitly ignored
  real-user-state tests;
- the production build, ESLint, Prettier, diff check, `cargo check`, and
  `cargo fmt --check` pass.

## Remaining work

There is no remaining WA4 attachment-policy decision.

Packaged SSH, published PacketCode, and configured PacketAgent interoperability
are separate environment-gated product proofs. An interactive detachable
Agents window remains a later WA5 item and still requires a safe single-writer
state contract.

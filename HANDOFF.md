# PacketADE Handoff

Last updated: 2026-08-01

This is the restart document for the next PacketADE work session. Read it
before older plans or audit notes.

## Latest pass — 2026-08-01 (correctness fixes and proof refresh)

The “implemented but awaiting proof” backlog was re-audited without promoting
fixtures to live/package claims. Canonical evidence:
[`dev/proof-audit-2026-08-01.md`](./dev/proof-audit-2026-08-01.md).

- The current working tree fixes the highest-priority operational-honesty
  residue: Anthropic pending edits carry their `toolUseId`; Agent Stop remains
  `Stopping` until backend acknowledgement; Side Chat has request-scoped events
  and cancellation; Monitor-open failures are visible; terminal-pane removal
  confirms its live-PTY consequence; and the duplicate cancel-pending chrome is
  removed.
- Git/repository authority now follows the active local/SSH Workspace and
  host/repository scope; stale async reads and mutations are revision-guarded,
  and GitHub-only actions are capability-gated for Gitea/Forgejo.
- Settings safety writes are awaited and revision-fenced, unenforced controls
  are hidden, and SSH password management now has an OS-keyring-only secret
  boundary with compensating rollback and truthful test/error state.
- The exact focused 2026-08-01 check passes **15 files / 108 tests**,
  `pnpm sidecar:check` passes, and the Rust suite passes **600 tests** with
  **3 explicitly ignored/manual tests**. The complete frontend count and
  package evidence are recorded in the proof audit; no commit/package was
  created by this loop.
- Clean PacketAgent `main` `f71021c` passes the focused W9 package/trust suite
  **11/11** and event/lifecycle/serialized-restart suite **25/25**, with one
  live interoperability test correctly skipped because no URL/token/workspace
  is configured.
- Clean PacketCode `main` `9f3364a` passes `go test ./...` and its source-tree
  schema-v1 doctor reports healthy. PCH3, PCH4, and PCH5 are closed; only the
  published/clean-machine and PacketAgent cross-product gates remain.
- This Windows profile still has zero PacketADE SSH servers and zero active
  capture endpoints. Current-package, real-host, microphone, external-editor,
  live-provider, and cross-platform gates therefore remain open.
- Release readiness reports **0 failures / 6 warnings**: signing/notarization,
  updater signing/configuration, and `latest.json` are absent. Existing bundles
  were superseded by the fresh `fd8c226` Windows build recorded below; that
  proves bundling, not manual packaged behavior or release trust.
- The reviewed source was committed and pushed to `main` as `fd8c226`. A fresh
  unsigned Windows app, MSI, and NSIS setup EXE were then built from that exact
  revision, hashed, and followed by restoration of sidecar development
  dependencies.

## Prior pass — 2026-07-31 (Packet Control adoption)

Docs and planning only; **no PacketADE runtime code changed**.

- **Packet Control Phases 1–2 adopted into PacketADE** from the packetcode
  proposal (`D:\projects\packetcode\PACKETCOMPUTERS.md`). Plan:
  [`dev/packet-control-loop.md`](./dev/packet-control-loop.md), CTL1–CTL9,
  **proposed — not started**. Packet Computers stays a packetcode item.
- **The load-bearing constraint is CTL1.** PacketADE is already growing an
  evidence path in `dev/bridgemind/packetagent-handoff-loop.md` PH8, so CTL1
  must project losslessly onto PacketAgent's `ValidationEvidenceRecord`, and
  `CoordinationArtifactRef` (`core/flight.rs`) must not be widened into a
  bundle type. One evidence format, not three.
- **Owner decisions D1–D3 ratified**: deterministic exit-code/assertion
  verdicts with a recorded `verdict_authority` (no model judges a claim in
  Phases 1–2), user-initiated runs only with manual after-the-fact attach to
  an `Attempt`, and capped retention with reported pruning.
- **Cross-repo:** PCH3 (workflow verifier), PCH4 (abandoned-job resubmit),
  PCH5 (remote MCP trust), and PCMP1/PCMP2 (Packet Computers registry) have now
  shipped in packetcode. PC9 in
  [`dev/bridgemind/packetcode-bridgecode-loop.md`](./dev/bridgemind/packetcode-bridgecode-loop.md)
  is updated; PC5/PC10 remain externally gated on signing credentials, a
  published build, and a live PacketAgent.
- Two back-dated marketing plans were deleted from `marketing/`; the
  press-kit collateral there is untouched.

## Resume here

The 2026-07-30 State of the ADE review is complete and received a current
status pass on 2026-08-01. It comprised a research
fleet pass
over the landscape, a bug-fix wave, a full root-documentation overhaul
(`README.md`, `ROADMAP.md`, `backlog.md`, `CHANGELOG.md`, this file), and the
removal of Gemini CLI support from the PTY session surface. Its shipped
outcomes and open recommendations are ledgered in
[`backlog.md`](./backlog.md#2026-07-30-state-of-the-ade-review); the full
consolidated report now ships as two editions with identical content:
`docs/reports/state-of-the-ade-2026-07-30.md` — the agent-facing source of
truth, whose Section 0 now supersedes the dated deep-dive statuses with the
2026-08-01 source/proof disposition — and
`docs/reports/state-of-the-ade-2026-07-30.pdf` (98 pages) for human reading.
Regenerate the PDF from the Markdown with
`python3 scripts/render_state_of_the_ade.py docs/reports/state-of-the-ade-2026-07-30.md docs/reports/state-of-the-ade-2026-07-30.pdf`.
The HTML edition was retired on 2026-07-30; do not recreate it.

All five threads from that review are now closed. The first two:

1. **Committed and verified.** The State of the ADE review work landed on
   `main` as
   `d5cfe8b` (bug fixes + Gemini removal + docs), `580ee80` (build evidence),
   and `3f8aba1` (consolidated ledger expansion), all pushed; gates were green
   at each commit (pnpm build, cargo check + test 440/440, vitest 1260/1260,
   sidecar build).
2. **The main-shell implementation pass. COMPLETE.** The owner made all five
   main-shell decisions on 2026-07-30 and all five were implemented the same
   day, in the decided order, one commit per step with gates green at each:
   `a8abf54` (D1), `531fbec` (D3), `2898946` (D4), `86cfac3` (D2+D5).
   `pnpm build` stayed green and lint stayed at zero errors throughout, and
   the Vitest suite grew 1260 → 1276 → 1320 → 1363 passing across 179 files.
   Known pre-existing and not caused by this wave: one unhandled rejection in
   `src/lib/__tests__/bootstrap.test.ts`, reproduced on a clean tree.

The five owner decisions, all made 2026-07-30 and all implemented 2026-07-30:

1. **DECIDED: YES. IMPLEMENTED `a8abf54`.** Remove the unscoped
   Workspace-level Agent inspector; Inspector is owned solely by the Agents
   view (resolves P0-1).
2. **DECIDED: YES. IMPLEMENTED `86cfac3`.** Build one surface-scoped
   `RightDock` controller owning width/stacking/visibility of all right-side
   panels (resolves P0-2, P0-3).
3. **DECIDED: YES. IMPLEMENTED `531fbec`.** Gate/disable local-only actions
   (Preview, applied-Review, Undo, Plan handoff, diff) on SSH conversations
   now; full remote parity later (resolves P0-4). The same commit also fixed
   the identical silent SSH→local conversion in the `/new` and `/review` slash
   commands, and diff failures that had been rendering as `+0/−0`.
4. **DECIDED: YES. IMPLEMENTED `2898946`.** One route registry owns the main
   rail, command palette, labels, placements, and hotkeys (resolves
   UX-14/P1-9; enables the creation-label fixes). Hotkeys now match the
   physical `KeyboardEvent.code`, so the Ctrl+Shift chords work on AZERTY,
   QWERTZ, and Dvorak layouts.
5. **DECIDED: RECONNECT. IMPLEMENTED `86cfac3`.** The lightweight Editor is
   now a first-class `RightDock` panel — `editorStore.openFile` has production
   callers and dirty buffers are protected. In-app quick editing IS part of
   PacketADE's positioning. Per the same-day amendment, the panel's wired
   Markdown viewer opens/previews `.md` files, resolving audit finding P1-5
   (Files' unwired Markdown-Preview path). P1-7 closes with it.

That delivered the audit's MS1 through MS3 slices — correctness boundaries,
one right dock, one navigation registry. **MS4 (product polish and proof) is
what remains** of that sequence: responsive/accessibility semantics, the
Gitea capability and repo-switch tests, and the packaged local/SSH and
800px-to-ultrawide visual matrix.

The third thread closed on top of that sequence:

3. **The main-shell follow-up loop. COMPLETE — `c3906c7`.** The Group A UX
   quick wins and the Group B creation-flow fixes that D1–D5 deliberately left
   out are all shipped, committed, and pushed. Gates at that commit: `pnpm build`
   green, Vitest 1466/1466 across 194 files (up from 1363), ESLint at
   zero errors. What landed:
   - **Deletion safety.** The §5 Critical is closed: the unrouted dead-code
     `ServersView.tsx` was deleted and a shared `ConfirmDeleteModal` plus
     `src/lib/serverUsage.ts` now name real consequences (connection state,
     conversations on that `sshTarget`, running attempts, bound workspaces).
     All 7 native `window.confirm` sites were eliminated and 15 destructive
     paths that had no confirmation gained one; `scripts/confirm-idiom.test.mjs`
     fences the idiom.
   - **Keyboard and exit safety.** `src/lib/keyboardTarget.ts` +
     `useGlobalShortcuts` stop Ctrl+K from stealing keystrokes from a focused
     terminal/input (and leave `defaultPrevented` false so the shell gets its
     kill-line); Escape no longer steals from terminals for dictation-cancel.
     `useCloseConfirm` + `src/lib/liveWork.ts` + `CloseConfirmDialog` confirm
     app close **only** when live work exists, listing what dies.
   - **Modals and board.** `Modal` now defaults to `closeOnEscape=true` (every
     X already advertised "Close (Esc)"); `TransientPtyModal` opts out because
     xterm owns Escape; `NewIssueForm` migrated off its hand-rolled overlay;
     `IssueBoard`'s `grid-cols-5`-vs-six-columns wrap is fixed.
   - **Creation flows.** `createWorkspace` throws on a blank local
     `projectPath`; instant paths go through `src/lib/workspaceCreation.ts`
     (OS folder picker, nothing created on cancel); workspaces auto-name
     Workspace/Workspace 2/…; `FleetSidebar`'s duplicate create controls are
     de-duplicated; workspace creation is now in the "+ New" menu and the
     Ctrl+K palette.

The fourth thread closed on top of that:

4. **The delete-cleanup loop. COMPLETE — `8cc2217`.** The three questions
   `c3906c7` deferred were all answered by the owner on 2026-07-30 and
   implemented the same day, so a confirmed delete now cleans up after itself.
   Gates at that commit: `pnpm build` green, Vitest 1523/1523 across 199 files
   (up from 1466), `cargo test` 444/444 (up from 440), ESLint at zero errors.
   What landed:
   - **Flight delete cancels and cleans up.**
     `asyncFlightStore.deleteFlightWithAttemptCleanup` cancels every
     non-terminal attempt through the existing cancel path, then deletes the
     Flight. "Non-terminal" deliberately **includes `reviewing`**: Rust only
     tears a worktree down on a terminal transition, so a reviewing attempt's
     worktree is still on disk — a subtlety the audit never identified. Cleanup
     is per-attempt try/caught with the delete after the `finally`, so a wedged
     attempt cannot abort it; failures toast the branch and what may survive
     (including SSH attempts whose `ServerConfig` is gone, which neither Rust
     nor the frontend fallback can reach). The 3-second armed inline button is
     replaced by the shared `ConfirmDeleteModal`, which states which attempts
     will be cancelled by status, which worktrees will be removed, which of
     those are dirty or uncheckable, and that live tasks are **not** cancelled.
     Completion capture is suppressed during a delete so cancelling the last
     attempt cannot mint a `flight_completed` memory event and retrospective
     for a record being thrown away.
   - **Conversation delete discards the worktree and branch, and says so
     first.** Owner's call was "discard, surface the confirm". Dirty trees are
     **force-discarded** rather than refused — once the record is gone no UI
     names the tree, so refusing would strand a directory nobody can find. The
     confirm leads with the uncommitted-changes warning in caps, names the exact
     path and `pkt/<id>` branch, escalates the button to "Delete and discard
     changes", and treats an unreadable git status as possibly-dirty rather than
     clean. Root-run, SSH, and already-discarded worktrees are skipped. New
     `ConfirmDeleteConversationModal` +
     `src/lib/conversationWorktreeDisclosure.ts`; both sidebars share the idiom
     and `FleetSidebar`'s workspace dialog is no longer "Delete session?".
   - **SSH keyring no longer orphaned.** New Rust `delete_ssh_password` clears
     both the current and the legacy keyring service (reads auto-migrate from
     legacy, so a survivor could resurrect the secret on id reuse), treats a
     missing entry as success, is registered in `lib.rs` with a TS binding, and
     runs from `serverStore.deleteServer` so every delete path is covered. A
     keyring failure cannot block the delete, and the confirm copy no longer
     claims the password stays behind.

The fifth thread closed on top of that:

5. **The cleanup-holes loop. COMPLETE — `7cad08b`.** Everything the previous
   two loops recorded as still open, except undo. Gates at that commit: `pnpm build`
   green, Vitest 1581/1581 across 200 files (up from 1523), `cargo test`
   452/452 with 2 ignored (up from 444), ESLint at zero errors. What landed:
   - **Rust worktree failures now surface.** New `WorktreeCleanupOutcome`
     (`worktreePath`, `removed`, `branch`, `branchDeleted`, `branchRetained`,
     `dirtyPaths`, `error`, `deferred`) is returned by `cancel_flight_attempt`
     and `mark_attempt_status` instead of swallowing a failed
     `git worktree remove` behind `warn!`. Failures are **data, not `Err`** —
     the attempt is still cancelled — so the frontend's existing
     `FlightCleanupFailure[]` toast path finally covers them. Discovery:
     `mark_attempt_status`'s SSH arm was doing **nothing but logging**; it now
     resolves the saved `ServerConfig` with fingerprint pinning like `cancel`
     does.
   - **Cooperative integration worktrees are no longer abandoned.** New
     `cleanup_flight_integration_worktree` (registered + TS binding) removes
     the `.pkt-flight-integrations/<flightId>` tree local or remote and is
     called from the flight-delete fan-out; its dirty state is probed and named
     in the confirm **separately** from the attempt counts. Deliberate
     conservatism: the integration branch is removed with safe
     `git branch -d`, never `-D`, because it can be the only ref to
     merged-but-unlanded attempt work — a refusal is reported in
     `branchRetained` and the branch survives.
   - **Startup restores the last view.** `bootstrap.ts` no longer force-routes
     to Welcome. New pure `resolveStartupView(persisted, isModuleEnabled)` in
     `appStore` validates against `ROUTE_REGISTRY` + module-enabled state;
     retired ids, unknown ids, and disabled-module routes fall back to Welcome,
     and first run is Welcome. The restore runs after conversation hydration
     but before `setInitialized(true)` — no Welcome flash, no view mounting
     against a half-built graph. No "always start on Welcome" preference
     existed anywhere; none was invented.
   - **Issues are deletable.** `issueStore.deleteIssue` already existed with
     **zero UI callers**; it is now reachable from an `IssueCard` hover
     affordance and an `IssueDetail` footer action, both behind the shared
     confirm via new `ConfirmDeleteIssueModal`, which names the flight it
     unlinks, the workspace session that **keeps running**, and the counts of
     comments, acceptance criteria, and dependency links deleted with it. Real
     bug fixed: the flight unlink previously fired only when the deleted issue
     itself carried a `flightId`, so a flight holding a drifted id kept it
     forever. Comment deletion added with the same confirm idiom.
   - **Chrome de-duplicated.** `AgentSidebar` drops its header "+" and keeps
     the labelled footer CTA, matching `FleetSidebar`, so the report's "Partly
     resolved" duplicate-sidebar-CTA finding fully closes. `ConversationTile`
     had **three** kebabs — tile chrome, a "More controls" toggle, and the
     overflow menu's own trigger — merged into **one** menu with every action
     preserved and the lazy-mount economy intact. The close (X) tooltip was
     lying because the same component mounts in two places where closing means
     different things; labels are now per-mount-site and state the real
     consequence. No confirm was added there — closing destroys nothing and is
     one click to reverse.
   - **Confirm-idiom fence tightened.** `scripts/confirm-idiom.test.mjs` no
     longer trips on a test **name** containing `confirm (`. Fixing it exposed
     a CRLF bug: the repo checks out CRLF and `.` won't match a trailing
     carriage return, so `$` never anchored and comments were never stripped —
     which had produced a false positive on a real file. Both directions are
     pinned with fixtures and proven with a planted `window.confirm` probe.

## Start here next session

The restart point is what four loops have deliberately not done. Full list in
[`backlog.md`](./backlog.md) under "P1 — deletion and shell follow-ups"; the
same list, with evidence and finding IDs, is §0.3 of
`docs/reports/state-of-the-ade-2026-07-30.md`.

**Lead with the one owner decision that blocks everything else: undo.**

No undo exists for any destructive action anywhere in the app — confirmation is
still the only safety net, and every other cleanup hole is now closed. It was
deferred again in `7cad08b` because it touches every store and is a design
decision, not a bug fix. Pick one:

- **(a) Soft-delete + restore.** Every store gains a tombstone and a restore
  path; persistence changes; recovery survives an app restart, and a "Recently
  deleted" surface becomes possible. The durable answer, and the larger build —
  it also raises retention questions (how long do tombstones live, what sweeps
  them, do they sync).
- **(b) Time-boxed undo toast.** The commit is deferred for N seconds behind a
  toast with an Undo action; nothing in persistence changes and no store gains
  state; there is no recovery at all once the window closes. An afternoon of
  work that covers the common misclick and nothing else.

They are not mutually exclusive — (b) is a strict subset of (a)'s UX — but (a)
should not be started as an incremental extension of (b) without deciding the
retention model first.

**The final destructive-without-confirm path is now fixed in the 2026-08-01
working tree:**

- **`WorkspacePane`'s terminal tile "Close pane" now uses the shared typed
  confirmation.** It names the live PTY/CLI consequence, Cancel preserves the
  pane, and confirmation stops the process before removing the pane. Focused
  component coverage, final integrated gates, and the `fd8c226` unsigned
  Windows package build pass; manual packaged interaction remains.

**Then the smaller residue:**

- `src/components/views/IssueDetailView.tsx` is dead code — an unmounted
  duplicate superseded by `IssueDetail`, only self-referencing. The
  issue-deletion work went into `IssueDetail`; this file was left untouched.
  Delete-or-keep decision (report §5.3 B-11).
- The duplicate `CancelPendingButton` is resolved in the 2026-08-01 working
  tree: the composer owns the one canonical cancel-pending action while
  per-item and bulk Allow/Deny remain.
- The four-controls-one-action finding's remaining legs: `Ctrl+N` and the
  `/new` slash command still reach conversation creation by separate routes
  with different semantics. Both sidebar legs are now de-duplicated.
- No Rust test covers `remove_remote_integration_worktree`; it needs a live SSH
  host, matching the existing gap for every remote worktree function.
- Two pre-existing `cargo fmt` drifts in
  `src-tauri/src/commands/agent_sidecar/supervisor.rs` and
  `src-tauri/src/commands/mod.rs`, left untouched so `7cad08b`'s diff stayed
  reviewable. `cargo fmt` is still not gated.
- A "don't ask again" preference for the app-close confirmation.
- The six-spellings label sweep across `WelcomeScreen`, `ProjectInfoCard`, and
  `OnboardingPane`.
- `useServerConnection` and `ConnectionProgress` are unreferenced — kept
  deliberately, but they need a keep-or-delete decision.

MS4 (responsive/accessibility semantics, packaged local/SSH and
800px-to-ultrawide visual matrix) remains open. Running Agents and Side Chat
cancellation acknowledgement, Gitea capability gates, and repo/host-context
invalidation are implemented and independently reviewed in the 2026-08-01
working tree. Real GitHub/Gitea package proof and the bounded slow-write/host-
switch stress case remain open.

## Current product state

- `main` is at `7cad08b` (cleanup holes: typed worktree-cleanup outcomes,
  cooperative integration worktrees, startup view restore, issue and comment
  deletion, chrome de-duplication), on top of `8cc2217` (delete cleanup: flight
  attempts, conversation worktrees, SSH keyring), `c3906c7` (main-shell
  follow-ups: deletion safety, keyboard/exit safety, creation flows), `86cfac3`
  (D2+D5 RightDock and reconnected Editor), `2898946` (D4), `531fbec` (D3),
  `a8abf54` (D1), and the State of the ADE review commits `3f8aba1` /
  `580ee80` / `d5cfe8b` — all committed 2026-07-30.
- Gates at `main` (`7cad08b`): `pnpm build` green, ESLint 0 errors, Vitest
  1581/1581 across 200 files, `cargo test` 452/452 with 2 ignored.
- The main shell now has one surface-scoped `RightDock`, one route registry
  behind the rail/palette/labels/hotkeys, SSH-gated local-only actions, an
  Agents-owned Inspector, and a reconnected Editor panel with a wired Markdown
  viewer.
- Destructive actions are confirmed through one shared `ConfirmDeleteModal`
  (plus `ConfirmDeleteConversationModal` for the worktree-bearing case). There
  are no native `window.confirm` calls left in source, and
  `scripts/confirm-idiom.test.mjs` enforces that. Confirmation now also cleans
  up: Flight delete cancels every non-terminal attempt (including `reviewing`,
  whose worktree is still on disk) before deleting, conversation delete
  discards the worktree and `pkt/<id>` branch after disclosing dirtiness, and
  SSH-server delete clears the keyring secret from both the current and legacy
  services. Worktree removal failures are now typed data
  (`WorktreeCleanupOutcome`) rather than a log line, and cooperative
  `.pkt-flight-integrations/<flightId>` worktrees are removed on flight delete
  with `git branch -d` (never `-D`, because that branch can be the only ref to
  merged-but-unlanded work). **What remains is undo**; the terminal-pane close
  confirmation was added in the 2026-08-01 working tree.
- Ctrl+K and Escape yield to focused terminals and text inputs, and closing the
  app confirms only when live work would be destroyed. Startup restores the
  last view you were on, validated against the route registry and
  module-enabled state, with Welcome as the fallback.
- Issues and issue comments are deletable behind the shared confirm, and every
  flight naming a deleted issue is unlinked (not just one holding a matching
  `flightId`). Conversation tiles carry one kebab menu and a close label that
  states what closing actually does at that mount site.
- Workspace creation has one contract: no workspace is created without a
  project path, instant paths open the OS folder picker, names auto-increment,
  and creation is reachable from the "+ New" menu and the Ctrl+K palette.
- Gemini CLI is no longer a supported PTY agent. Supported PTY CLIs are Claude
  Code, Codex CLI, OpenCode, PacketCode, and plain shells; the GUI-agent picker
  keeps its seven chat rows (Claude Agent SDK/API, OpenAI API/Agents SDK,
  MiniMax, OpenRouter, Ollama). Saved panes that
  referenced `gemini` reopen as plain terminals.
- Workspace/Agents restructuring is complete. Workspaces are CLI/PacketCode
  first; Agents is the first-class GUI-agent surface; new Workspace
  conversation attachments are retired; saved panes remain compatible.
- **Open alongside Workspace** and its creation/materialization paths are
  removed.
- The six-group Settings Option B is implemented without removing any former
  destination. Search, focused sub-tabs, scope badges, typed PacketCode
  recovery, and legacy CLI recovery are test-covered.
- Flight Deck Option B is implemented: planning uses a normal read-only Agent
  conversation, applying the plan is explicit, and attempts remain
  user-launched.
- PacketAgent is a separate repository and Codex project. PacketADE contains
  the W9 consumer/handoff source but does not own PacketAgent's runtime.
- PacketCode is a separate TUI product. PacketADE detects it, offers bounded
  install/setup recovery, and treats it as the recommended Workspace CLI when
  available.
- Read-only Agent and Flight Monitor windows exist. Approval/Cost monitors,
  multiple simultaneous monitors, saved bounds, and PTY attachment remain
  later work.
- The 30 low-rated Reliability audit findings are closed.

## Settings work that remains

The information architecture and 2026-08-01 P1 authority/security pass are
done. Remaining work is the bounded P2 follow-up and external proof tracked in
[`dev/workspace-agent-settings-decision-2026-07-29.md`](./dev/workspace-agent-settings-decision-2026-07-29.md)
and [`backlog.md`](./backlog.md):

- consume or remove Task Role Defaults (AI Provider Routing is now consumed);
- migrate MCP selections/trust to stable scoped IDs;
- make Project information use the active local/SSH Workspace identity;
- validate provider-aware profile model/tool choices;
- run packaged OS-keyring and live pinned-SSH password-authentication proof.

The unused Agent rail-collapse and unenforced MCP scope/tool controls are hidden;
safety saves and SSH password storage are source-complete and peer-reviewed.

## Remote Agents is still paused

Remote Agents is preserved as the next major networked product bet, but no
Remote Agents code should be written until the owner resolves all three
Sprint-0 decisions in
[`dev/remoteagents/09-open-decisions.md`](./dev/remoteagents/09-open-decisions.md):

1. authentication provider;
2. end-to-end-encryption timing;
3. code/repository location.

The canonical plan is
[`dev/remoteagents/README.md`](./dev/remoteagents/README.md). Keep the v1
boundary narrow: PWA conversation supervision through a relay, with providers,
secrets, tools, files, and execution remaining on the desktop. Do not build a
generic remote Tauri bridge.

## Environment and release gates

Source-completable pre-Remote work has converged. The remaining gates need real
environments, external products, hardware, or credentials:

- Windows Authenticode and macOS signing/notarization credentials;
- Tauri updater signing and hosted `latest.json`;
- live Windows/macOS/Linux Dictation microphone matrices;
- real local/SSH provider, MCP, GitHub, and Gitea packaged proof;
- PacketCode clean-machine install/upgrade/rollback proof;
- PacketAgent live cross-repository close/restart proof;
- packaged Flight Reviewer/graph/inbox/YOLO matrices;
- real external-editor and project-Memory watch interoperability.

These are not permission to invent new source features. Follow the linked
runbooks and record evidence when the required environment exists. The last
source-level recheck and the exact reason each external gate remains open are
recorded in
[`dev/proof-audit-2026-08-01.md`](./dev/proof-audit-2026-08-01.md).

## Latest Windows build

On 2026-08-01, `pnpm tauri build` succeeded from pushed `main` commit
`fd8c22643715572c89365e7a21bf3c7f06fd57f4`. Sidecar development dependencies
were restored after the production prune.

This is a post-tag local development rebuild that still uses version `0.10.2`;
it is not a newly tagged public release.

| Artifact                         |       Size | SHA-256                                                            |
| -------------------------------- | ---------: | ------------------------------------------------------------------ |
| `packetade.exe`                  |  43.59 MiB | `47E04DD3B439B467E81E0CA0DB1ECF7C58786A6724ABDC496FEE09E1F0373A14` |
| `PacketADE_0.10.2_x64-setup.exe` |  84.64 MiB | `872129D74DE1F5E2A42ABAC39FC46D0E703BC2EAA5A5FC066FBD3E0E4B6E37B7` |
| `PacketADE_0.10.2_x64_en-US.msi` | 132.16 MiB | `4BA6DC0F3FD492D32633D207DB3A33CFF4C5BFF295D73D51A702480AC4D7660D` |

Local paths:

- `C:\Users\ianwalmsley\packetade-build\release\packetade.exe`
- `C:\Users\ianwalmsley\packetade-build\release\bundle\nsis\PacketADE_0.10.2_x64-setup.exe`
- `C:\Users\ianwalmsley\packetade-build\release\bundle\msi\PacketADE_0.10.2_x64_en-US.msi`

All three artifacts are unsigned.

The build completed with the known non-failing Vite chunk/dynamic-import,
stale Browserslist, and `ts-rs` serde-alias warnings.

## Last verified gates

The `fd8c226` source/package pass is the current authority: **225 frontend test
files / 1,857 tests**, **15 focused files / 108 tests**, **600 Rust tests passed
with 3 intentionally ignored/manual**, deterministic sidecar checks passing,
ESLint at zero errors with nine existing Fast Refresh warnings, production web
build passing, and both Windows installer formats compiled successfully.

Every commit in this sequence ran the frontend gates before landing:

- Vitest grew 1260 → 1276 (`a8abf54`) → 1320 (`531fbec`, cumulative through
  `2898946`) → 1363 across 179 files (`86cfac3`) → 1466 across 194 files
  (`c3906c7`) → **1523 passing across 199 files** (`8cc2217`);
- `cargo test` grew 440 → **444** (`8cc2217`, the new `delete_ssh_password`
  coverage);
- ESLint passed with zero errors at every step;
- the TypeScript/Vite production build passed at every step;
- one pre-existing unhandled rejection in
  `src/lib/__tests__/bootstrap.test.ts` reproduces on a clean tree and is not
  attributable to this wave.

The preceding Settings/main-shell documentation commit was verified against
167 Vitest files and 1,261 tests, zero ESLint errors with nine existing Fast
Refresh warnings, a passing production build, all eight Playwright web-mode
tests, and passing formatting/diff checks.

The subsequent full Tauri build completed the optimized Rust release compile
and produced both Windows installer formats. Its known non-failing output was
limited to existing `ts-rs` serde-alias and Vite chunk/dynamic-import warnings.

## Guardrails that must survive

- Do not revive the deleted autonomous Flight Planner v1 runtime, journal, FSM,
  wake loop, or planner MCP surface.
- Do not recreate new Workspace conversation-attachment producers.
- Do not make an interactive detachable Agents window until one backend-owned
  or single-writer conversation-state contract exists.
- Keep secrets in the OS keyring; never persist tokens or SSH passwords in
  frontend state or ordinary files.
- Keep Remote Agents desktop-owned and narrow.
- Preserve PacketAgent and PacketCode as separate products/repositories.
- Add open work to `backlog.md`; do not turn dated audits into competing task
  registers.

## Canonical reading order

1. This `HANDOFF.md`.
2. [`ROADMAP.md`](./ROADMAP.md) for current direction.
3. [`backlog.md`](./backlog.md) for open work.
4. [`dev/README.md`](./dev/README.md) for the planning index.
5. The main-shell audit for what the 2026-07-30 implementation closed and what
   is still open in it.
6. The Settings decision report for authority cleanup.
7. The Remote Agents plan only after the current local-shell decisions.

## Suggested first prompt

> Read `HANDOFF.md`. The five decided main-shell items (`a8abf54`, `531fbec`,
> `2898946`, `86cfac3`), the main-shell follow-up loop (`c3906c7` —
> deletion-confirm sweep, Ctrl+K/Escape terminal guards, app-close confirm,
> Modal Escape default, Issues-board wrap, unified workspace creation), and the
> delete-cleanup loop (`8cc2217` — Flight delete cancels non-terminal attempts
> and cleans worktrees, conversation delete discards the worktree/branch with a
> dirty-state confirm, SSH delete clears the keyring on both services) are all
> implemented and committed — do not re-open them. Pick up what they
> deliberately left out, in `backlog.md` under "P1 — deletion and shell
> follow-ups". Lead with the two real cleanup holes: Rust swallows git
> worktree-removal errors (`cancel_flight_attempt` only `warn!`s), which needs a
> Rust signature change so failures surface; and cooperative
> `integrationBranch` worktrees are still abandoned on Flight delete because
> they have no exposed command and are not attempt-id keyed. Then restore the
> persisted `selectedView` in `bootstrap.ts` instead of force-routing to
> Welcome. Then undo for destructive actions. Then the residue: Issue delete
> and `IssueCommentList` comment delete, the `ConversationTile` double kebab and
> lying X tooltip, a "don't ask again" close preference, the six-spellings label
> sweep (`WelcomeScreen`/`ProjectInfoCard`/`OnboardingPane`), a keep-or-delete
> decision on the now-unreferenced `useServerConnection` / `ConnectionProgress`,
> and narrowing `scripts/confirm-idiom.test.mjs` so a test _name_ containing
> `confirm (` stops tripping the fence. Keep gates green at each step
> (`pnpm build`, `pnpm lint`, Vitest — currently 1523 passing across 199 files —
> and `cargo test`, currently 444).

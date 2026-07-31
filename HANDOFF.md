# PacketADE Handoff

Last updated: 2026-07-30

This is the restart document for the next PacketADE work session. Read it
before older plans or audit notes.

## Resume here

The 2026-07-30 State of the ADE review is complete. It comprised a research
fleet pass
over the landscape, a bug-fix wave, a full root-documentation overhaul
(`README.md`, `ROADMAP.md`, `backlog.md`, `CHANGELOG.md`, this file), and the
removal of Gemini CLI support from the PTY session surface. Its shipped
outcomes and open recommendations are ledgered in
[`backlog.md`](./backlog.md#2026-07-30-state-of-the-ade-review); the full
consolidated report is `docs/reports/state-of-the-ade-2026-07-30.html`
(11 chapters, with the
UX Ledger, Visual Audit, and Outstanding Audits Ledger).

All four threads from that review are now closed. The first two:

1. **Committed and verified.** The State of the ADE review work landed on
   `main` as
   `72b2734` (bug fixes + Gemini removal + docs), `580ee80` (build evidence),
   and `3f8aba1` (consolidated ledger expansion), all pushed; gates were green
   at each commit (pnpm build, cargo check + test 440/440, vitest 1260/1260,
   sidecar build).
2. **The main-shell implementation pass. COMPLETE.** The owner made all five
   main-shell decisions on 2026-07-30 and all five were implemented the same
   day, in the decided order, one commit per step with gates green at each:
   `e7e7c27` (D1), `33708c0` (D3), `dffbe61` (D4), `93d41af` (D2+D5).
   `pnpm build` stayed green and lint stayed at zero errors throughout, and
   the Vitest suite grew 1260 → 1276 → 1320 → 1363 passing across 179 files.
   Known pre-existing and not caused by this wave: one unhandled rejection in
   `src/lib/__tests__/bootstrap.test.ts`, reproduced on a clean tree.

The five owner decisions, all made 2026-07-30 and all implemented 2026-07-30:

1. **DECIDED: YES. IMPLEMENTED `e7e7c27`.** Remove the unscoped
   Workspace-level Agent inspector; Inspector is owned solely by the Agents
   view (resolves P0-1).
2. **DECIDED: YES. IMPLEMENTED `93d41af`.** Build one surface-scoped
   `RightDock` controller owning width/stacking/visibility of all right-side
   panels (resolves P0-2, P0-3).
3. **DECIDED: YES. IMPLEMENTED `33708c0`.** Gate/disable local-only actions
   (Preview, applied-Review, Undo, Plan handoff, diff) on SSH conversations
   now; full remote parity later (resolves P0-4). The same commit also fixed
   the identical silent SSH→local conversion in the `/new` and `/review` slash
   commands, and diff failures that had been rendering as `+0/−0`.
4. **DECIDED: YES. IMPLEMENTED `dffbe61`.** One route registry owns the main
   rail, command palette, labels, placements, and hotkeys (resolves
   UX-14/P1-9; enables the creation-label fixes). Hotkeys now match the
   physical `KeyboardEvent.code`, so the Ctrl+Shift chords work on AZERTY,
   QWERTZ, and Dvorak layouts.
5. **DECIDED: RECONNECT. IMPLEMENTED `93d41af`.** The lightweight Editor is
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

3. **The main-shell follow-up loop. COMPLETE — `f405ea1`.** The Group A UX
   quick wins and the Group B creation-flow fixes that D1–D5 deliberately left
   out are all shipped, committed, and pushed. Gates at that commit: `pnpm
   build` green, Vitest 1466/1466 across 194 files (up from 1363), ESLint at
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

4. **The delete-cleanup loop. COMPLETE — `d94cca4`.** The three questions
   `f405ea1` deferred were all answered by the owner on 2026-07-30 and
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

## Start here next session

The restart point is what `f405ea1` and `d94cca4` deliberately did **not** do.
Full list in [`backlog.md`](./backlog.md) under "P1 — deletion and shell
follow-ups".

**Lead with the two real cleanup holes that remain:**

- **Rust swallows git worktree-removal errors.** `cancel_flight_attempt` only
  `warn!`s, so a genuine removal failure logs instead of surfacing — the
  frontend cleanup path cannot report what it was never told. Fixing this needs
  a Rust signature change.
- **Cooperative `integrationBranch` worktrees are still abandoned on Flight
  delete.** There is no exposed command for them and they are not attempt-id
  keyed, so `d94cca4`'s attempt fan-out cannot reach them.

**Then the persisted-view restore:** `bootstrap.ts` still force-routes to
Welcome instead of restoring the persisted `selectedView`.

**Then undo,** which is now the only remaining safety net gap: every
destructive action is confirmed, but none of them can be taken back.

**Then the smaller residue:**

- Issues have no delete path at all, and `IssueCommentList` comment delete is
  missing;
- `ConversationTile`'s double kebab and its X whose tooltip does not match what
  it does;
- a "don't ask again" preference for the app-close confirmation;
- the six-spellings label sweep across `WelcomeScreen`, `ProjectInfoCard`, and
  `OnboardingPane`;
- `useServerConnection` and `ConnectionProgress` are now unreferenced — kept
  deliberately, but they need a keep-or-delete decision;
- a sharp edge in the fence itself: `scripts/confirm-idiom.test.mjs` greps
  broadly enough that a **test name** containing `confirm (` trips it.

MS4 (responsive/accessibility semantics, Gitea capability and repo-switch
tests, packaged local/SSH and 800px-to-ultrawide visual matrix) and the two
unaddressed MS1 items remain open alongside these.

## Current product state

- `main` is at `d94cca4` (delete cleanup: flight attempts, conversation
  worktrees, SSH keyring), on top of `f405ea1` (main-shell follow-ups: deletion
  safety, keyboard/exit safety, creation flows), `93d41af` (D2+D5 RightDock and
  reconnected Editor), `dffbe61` (D4), `33708c0` (D3), `e7e7c27` (D1), and
  the State of the ADE review commits `3f8aba1` / `580ee80` / `72b2734` — all
  committed 2026-07-30.
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
  services. What remains is Rust-side error surfacing for worktree removal,
  cooperative `integrationBranch` worktrees, and undo — see the restart list.
- Ctrl+K and Escape yield to focused terminals and text inputs, and closing the
  app confirms only when live work would be destroyed.
- Workspace creation has one contract: no workspace is created without a
  project path, instant paths open the OS folder picker, names auto-increment,
  and creation is reachable from the "+ New" menu and the Ctrl+K palette.
- Gemini CLI is no longer a supported PTY agent. Supported PTY CLIs are Claude
  Code, Codex CLI, OpenCode, PacketCode, and plain shells; the GUI-agent picker
  keeps its eight chat rows (Anthropic subscription/API, OpenAI
  ChatGPT/API/Agents SDK, MiniMax, OpenRouter, Ollama). Saved panes that
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

The information architecture is done. The remaining work is authority and
runtime correctness, tracked in
[`dev/workspace-agent-settings-decision-2026-07-29.md`](./dev/workspace-agent-settings-decision-2026-07-29.md)
and [`backlog.md`](./backlog.md):

- enforce or hide PacketADE MCP provider scope/tool controls;
- implement secure SSH password set/delete/test or remove Password auth from
  new server setup;
- consume or remove AI Provider Routing / Task Role Defaults;
- wire or remove the unused Agent rail-collapse preference;
- migrate MCP selections/trust to stable scoped IDs;
- make Project information use the active local/SSH Workspace identity;
- make Flight/autonomy Settings saves awaited and authoritative.

Do not confuse this authority cleanup with the completed six-group Settings
navigation work.

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
runbooks and record evidence when the required environment exists.

## Latest Windows build

On 2026-07-30, `pnpm tauri build` succeeded from the State of the ADE review
commit `72b2734` (16 verified bug fixes, Gemini CLI removal, docs overhaul). Sidecar
development dependencies were restored after the production prune and the
repository was left clean.

This is a post-tag local development rebuild that still uses version `0.10.2`;
it is not a newly tagged public release.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `packetade.exe` | 42.63 MiB | `D28FFCD355933F280A4C348DB26C77C53D61C9983B07858DBFA79DDD0E84E7E8` |
| `PacketADE_0.10.2_x64-setup.exe` | 84.47 MiB | `F1B19D36B84338FC495EC1591EC3E66437A118C87617A4EFC27239C68B3BF0E7` |
| `PacketADE_0.10.2_x64_en-US.msi` | 131.90 MiB | `A79B995A927AF4D91E74BD682122C32ED27CF8CBAE99779312EBF11D654A09C8` |

Local paths:

- `C:\Users\ianwalmsley\packetade-build\release\packetade.exe`
- `C:\Users\ianwalmsley\packetade-build\release\bundle\nsis\PacketADE_0.10.2_x64-setup.exe`
- `C:\Users\ianwalmsley\packetade-build\release\bundle\msi\PacketADE_0.10.2_x64_en-US.msi`

All three artifacts are unsigned.

## Last verified gates

Every commit in this sequence ran the frontend gates before landing:

- Vitest grew 1260 → 1276 (`e7e7c27`) → 1320 (`33708c0`, cumulative through
  `dffbe61`) → 1363 across 179 files (`93d41af`) → 1466 across 194 files
  (`f405ea1`) → **1523 passing across 199 files** (`d94cca4`);
- `cargo test` grew 440 → **444** (`d94cca4`, the new `delete_ssh_password`
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

> Read `HANDOFF.md`. The five decided main-shell items (`e7e7c27`, `33708c0`,
> `dffbe61`, `93d41af`), the main-shell follow-up loop (`f405ea1` —
> deletion-confirm sweep, Ctrl+K/Escape terminal guards, app-close confirm,
> Modal Escape default, Issues-board wrap, unified workspace creation), and the
> delete-cleanup loop (`d94cca4` — Flight delete cancels non-terminal attempts
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
> and narrowing `scripts/confirm-idiom.test.mjs` so a test *name* containing
> `confirm (` stops tripping the fence. Keep gates green at each step
> (`pnpm build`, `pnpm lint`, Vitest — currently 1523 passing across 199 files —
> and `cargo test`, currently 444).

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

Both threads from that review are now closed:

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

## Start here next session

The restart point is no longer the five decisions. It is the follow-up work
they deliberately left out, in two groups.

**Group A — standalone UX quick wins** (explicitly scoped out of D1–D5):

- guard Ctrl+K so it does not steal keystrokes from a focused terminal;
- confirm before closing the app when live sessions would be destroyed;
- opt Escape-to-close into the New Flight and New Issue modals;
- fix the Issues board grid wrap, where the sixth column ("Done") drops onto
  a second row with a dead right half at both 1280 and 1920.

**Group B — top creation-flow fixes** from the report's new Creation, Opening
& Deletion Flows chapter (`docs/reports/state-of-the-ade-2026-07-30.html`,
§5 — 65 findings across five flows, 124 controls inventoried):

- **Critical: unconfirmed live SSH-server delete.** The Settings card's delete
  fires immediately, and the component that does carry a confirmation
  (`ServersView.tsx`) is unrouted dead code. Deleting a server also silently
  breaks every workspace and flight attempt bound to it.
- unify the two workspace-creation flows: the full `WorkspaceCreationModal`
  requires a name, a CLI session, and a non-empty project path, while Ctrl+N
  and the Fleet sidebar instantly create a zero-pane workspace hard-named
  "New Session" using whatever `layoutStore.projectPath` happens to hold —
  including the empty string the modal explicitly blocks;
- de-duplicate the `FleetSidebar` top "+" and bottom "New session" buttons,
  which are bound to the identical handler inside one 240px sidebar (the
  `AgentSidebar` "New agent" pair is the same shape);
- add workspace creation to the global "+ New" menu and the Ctrl+K command
  palette — today the two most discoverable surfaces are the only places the
  primary object cannot be made.

## Current product state

- `main` is at `93d41af` (D2+D5 RightDock and reconnected Editor), on top of
  `dffbe61` (D4), `33708c0` (D3), `e7e7c27` (D1), and the State of the ADE
  review commits `3f8aba1` / `580ee80` / `72b2734` — all committed 2026-07-30.
- The main shell now has one surface-scoped `RightDock`, one route registry
  behind the rail/palette/labels/hotkeys, SSH-gated local-only actions, an
  Agents-owned Inspector, and a reconnected Editor panel with a wired Markdown
  viewer.
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

The four main-shell implementation commits each ran the frontend gates before
landing:

- Vitest grew 1260 → 1276 (`e7e7c27`) → 1320 (`33708c0`, cumulative through
  `dffbe61`) → 1363 passing across 179 files (`93d41af`);
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

> Read `HANDOFF.md`. The five decided main-shell items are implemented and
> committed (`e7e7c27`, `33708c0`, `dffbe61`, `93d41af`) — do not re-open
> them. Pick up the follow-ups instead. Start with the deletion critical: the
> live SSH-server delete in Settings has no confirmation while the component
> that has one (`ServersView.tsx`) is unrouted dead code. Then do the
> standalone UX quick wins (Ctrl+K terminal guard, close-confirm on app exit,
> Escape-close on the New Flight/New Issue modals, Issues-board grid wrap) and
> the top creation-flow fixes from §5 of
> `docs/reports/state-of-the-ade-2026-07-30.html`: unify the two
> workspace-creation flows and stop the empty-`projectPath` instant create,
> de-duplicate the FleetSidebar top/bottom "New session" buttons, and add
> workspace creation to the "+ New" menu and the Ctrl+K palette. Keep gates
> green at each step (`pnpm build`, `pnpm lint`, Vitest, currently 1363
> passing across 179 files).

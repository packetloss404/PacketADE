# PacketADE Handoff

Last updated: 2026-07-30

This is the restart document for the next PacketADE work session. Read it
before older plans or audit notes.

## Resume here

The 2026-07-30 midway review is complete. It comprised a research fleet pass
over the landscape, a bug-fix wave, a full root-documentation overhaul
(`README.md`, `ROADMAP.md`, `backlog.md`, `CHANGELOG.md`, this file), and the
removal of Gemini CLI support from the PTY session surface. Its shipped
outcomes and open recommendations are ledgered in
[`backlog.md`](./backlog.md#2026-07-30-midway-review); the full consolidated
report is `docs/reports/midway-review-2026-07-30.html` (11 chapters, with the
UX Ledger, Visual Audit, and Outstanding Audits Ledger).

One thread is open from here:

1. **Committed and verified.** The midway-review work landed on `main` as
   `72b2734` (bug fixes + Gemini removal + docs), `580ee80` (build evidence),
   and `3f8aba1` (consolidated ledger expansion), all pushed; gates were green
   at each commit (pnpm build, cargo check + test 440/440, vitest 1260/1260,
   sidecar build).
2. **The main-shell implementation pass.** The owner made all five main-shell
   decisions on 2026-07-30; next session's work is implementing them, not
   re-litigating them.

For thread 2, start with
[`dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md).
The five owner decisions, all made 2026-07-30:

1. **DECIDED: YES.** Remove the unscoped Workspace-level Agent inspector;
   Inspector is owned solely by the Agents view (resolves P0-1).
2. **DECIDED: YES.** Build one surface-scoped `RightDock` controller owning
   width/stacking/visibility of all right-side panels (resolves P0-2, helps
   P0-3).
3. **DECIDED: YES.** Gate/disable local-only actions (Preview, applied-Review,
   Undo, Plan handoff, diff) on SSH conversations now; full remote parity
   later (resolves P0-4).
4. **DECIDED: YES.** One route registry owns the main rail, command palette,
   labels, placements, and hotkeys (resolves UX-14/P1-9; enables the
   creation-label fixes).
5. **DECIDED: RECONNECT.** The lightweight Editor becomes a first-class
   `RightDock` panel — wire `editorStore.openFile` production callers and
   protect dirty buffers. In-app quick editing IS part of PacketADE's
   positioning. This folds into decision 2's `RightDock` scope.

Implement in this order: D1 inspector removal first (smallest), then D3 SSH
gating, then D4 route registry, then D2 `RightDock` including D5's Editor
panel. That maps onto the audit's MS1 through MS4 sequence: correctness
boundaries, one right dock, one navigation registry, then polish/proof.

## Current product state

- `main` is at `3f8aba1` (consolidated 6-month ledger expansion), on top of
  `72b2734` (midway review: 16 verified bug fixes, Gemini CLI removal, docs
  overhaul) — all committed and pushed 2026-07-30.
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

On 2026-07-30, `pnpm tauri build` succeeded from the midway-review commit
`72b2734` (16 verified bug fixes, Gemini CLI removal, docs overhaul). Sidecar
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

The Settings/main-shell documentation commit was preceded by:

- 167 Vitest files and 1,261 tests passed;
- ESLint passed with zero errors and nine existing Fast Refresh warnings;
- TypeScript/Vite production build passed;
- all eight Playwright web-mode tests passed;
- formatting and diff checks passed.

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
5. The main-shell audit for the decided (2026-07-30) implementation scope.
6. The Settings decision report for authority cleanup.
7. The Remote Agents plan only after the current local-shell decisions.

## Suggested first prompt

> Read `HANDOFF.md`. First, run the quality gates over the uncommitted
> midway-review working tree (Gemini CLI removal + docs overhaul) and commit it
> if they pass. Then read the main-shell navigation/right-panel audit and begin
> implementing the five decided (2026-07-30) items in order: D1 Workspace
> inspector removal, D3 SSH gating, D4 route registry, then D2 RightDock
> including the D5 Editor panel.

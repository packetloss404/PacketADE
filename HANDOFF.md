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
[`backlog.md`](./backlog.md#2026-07-30-midway-review); the report placeholder
is `docs/reports/midway-review-2026-07-30.html`.

Two threads are open from here:

1. **Commit and verify the midway-review working tree.** The Gemini removal
   (~650 net lines across `src/` and `src-tauri/`) and the documentation
   overhaul are uncommitted on `main` as of this handoff. Run the usual gates
   (`pnpm lint`, `pnpm test`, `pnpm build`, `cargo check`) before committing.
2. **The main-shell decision pass** remains the current owner decision target:
   navigation, menus, tabs, buttons, and right-side panel ownership. The
   review is complete, but none of its recommendations has been silently
   approved or implemented.

For thread 2, start with
[`dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md)
and step through these five owner decisions before changing code:

1. Remove the unscoped Workspace-level Agent inspector and keep Inspector owned
   by Agents. Recommended: **yes**.
2. Replace competing Inspector, Git, and Editor panels with one
   surface-scoped `RightDock`. Recommended: **yes**.
3. Disable unsupported SSH Preview, applied-file Review/Diff, Editor, and
   local-only handoff actions until remote-aware implementations exist.
   Recommended: **yes**.
4. Make one route registry own main rail, command palette, labels, placements,
   and hotkeys. Recommended: **yes**.
5. Reconnect the lightweight Editor through the new dock or remove its
   production-unreachable shell. Decide this after reviewing how much editing
   should remain in PacketADE versus PacketCode.

Do not start the implementation loop until the owner has confirmed these
decisions. Once confirmed, use the audit's MS1 through MS4 sequence:
correctness boundaries, one right dock, one navigation registry, then
polish/proof.

## Current product state

- The most recent functional source commit before this documentation handoff is
  `a7feb4a` (`Reorganize Settings and audit main shell`) on `main`. The
  2026-07-30 midway-review changes (Gemini removal + docs overhaul) sit
  uncommitted on top of it.
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

On 2026-07-30, `pnpm tauri build` succeeded from functional commit `a7feb4a`.
It compiled PacketADE `0.10.2`, restored sidecar development dependencies after
the production prune, and left the repository clean.

This is a post-tag local development rebuild that still uses version `0.10.2`;
it is not a newly tagged public release.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `packetade.exe` | 42.65 MiB | `23E954FDF0C10A1CA2E5CF2198334CB6D268B1925EA155F83EC1C8FCC91FBA1A` |
| `PacketADE_0.10.2_x64-setup.exe` | 84.47 MiB | `E4A1119396EF6E7E9BF4511F8BAFC3E2B076FF37011C8C36101870B959A2BDD6` |
| `PacketADE_0.10.2_x64_en-US.msi` | 131.90 MiB | `AB307CFE7BD1FE0149C97FC047F08CB21A61AFBA9611444B98FE84F0C7E30E5D` |

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
5. The main-shell audit for the current owner decisions.
6. The Settings decision report for authority cleanup.
7. The Remote Agents plan only after the current local-shell decisions.

## Suggested first prompt

> Read `HANDOFF.md`. First, run the quality gates over the uncommitted
> midway-review working tree (Gemini CLI removal + docs overhaul) and commit it
> if they pass. Then read the main-shell navigation/right-panel audit — do not
> implement yet — and step me through the five owner decisions, beginning with
> the Workspace Agent inspector and the shared RightDock, explaining what
> functionality is preserved or lost by each choice.

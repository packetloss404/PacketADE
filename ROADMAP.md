# PacketBench Roadmap

Last reconciled: 2026-08-12

PacketBench is a local-first Agent Development Environment and remains the
flagship control surface. The desktop owns local providers, models, secrets,
Workspaces, MCP configuration, permissions, Memory, and execution. Phone and
cloud surfaces supervise their configured authority; they do not replace it.
(Syndicate separated from the Packet\* product family on 2026-08-27; its
execution-target integration was removed — see `CHANGELOG.md` [Unreleased].)

The detailed task ledger is [`backlog.md`](./backlog.md). This file contains
only product direction and ordering.

## Current baseline

- v0.10.3 is tagged and packaged for Windows from release source `61e0669`.
- Workspace/Agents restructuring is complete: Workspaces are
  CLI/PacketCode-first; Agents owns first-class same-window GUI conversations;
  new Workspace conversation attachments are retired; saved panes remain
  compatible.
- The six-group Settings information architecture and its P1 authority/security
  corrections are complete.
- Flight Deck Option B, Flight supervision source, PacketCode integration,
  PacketAgent W9 consumer source, Project Memory, local-first MCP Hub,
  Dictation hardening, trust/provenance, Issue-to-Flight mirroring, and Monitor
  v1 are implemented.
- Selectable local Terminal shells and the self-bootstrapping Claude Code native
  status bar ship in v0.10.3.
- The 30 low-rated Reliability findings are closed.
- The first-class Syndicate execution target (scoped device pairing/revocation,
  Host-owned Workspaces, durable remote CLI panes, managed pinned-SSH
  bootstrap, encrypted PacketRelay transport) was implemented, reviewed, and
  then removed on 2026-08-27 when Syndicate separated from the Packet\*
  family. The pre-removal implementation is at `d87fb125`; the controller
  protocol and relay continue in Syndicate's own repos.

The remaining bottleneck is packaged, real-host acceptance proof, not another
broad source feature wave.

## Now

| Track                       | Priority | Current state                                                                                                    | Next action                                                                                                                                           |
| --------------------------- | -------: | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged Windows acceptance |       P1 | v0.10.3 app/NSIS/MSI compiled; interactive matrix open                                                           | Dogfood real Terminal panes, Claude statusline, close/lifecycle, Monitor, accessibility, and denial behavior                                          |
| Distribution trust          |       P1 | 0 failures / 6 readiness warnings; artifacts unsigned                                                            | Add hosted CI; acquire Windows Authenticode and Apple Developer ID credentials in parallel on day 0; wire notarization and updater                    |
| macOS release               |       P1 | Builds, bundles a DMG, and runs from source on real hardware; never signed, notarized, or interactively accepted | Enroll in the Apple Developer Program now; run the unsigned acceptance matrix in the 1.0 buffer; ship arm64 DMG in v1.1 (`dev/macos-release-plan.md`) |
| Remote Agents decisions     |   PAUSED | Program paused by owner 2026-08-16; E2EE gate ratified; auth parked as first pickup action                       | On pickup, run the runbook in `dev/remoteagents/10-pause-record.md` (auth decision first)                                                             |
| Global Undo                 |       P1 | Confirmations and cleanup are implemented; no recovery path                                                      | Decided 2026-08-16: time-boxed delayed-delete toast (soft-delete declined); implementation not yet scheduled                                          |
| Flight supervision proof    |       P1 | Reviewer/graph/inbox/YOLO source complete                                                                        | Run packaged local and disposable pinned-SSH matrices                                                                                                 |
| PacketAgent handoff proof   |       P1 | W9 consumer source and fixtures pass                                                                             | Run separately hosted close/relaunch/reconnect and evidence-return matrix                                                                             |
| PacketCode release proof    |       P1 | Source integration and doctor contract pass                                                                      | Publish signed artifacts; run clean-machine upgrade/rollback and compatibility smoke                                                                  |
| Dictation proof             |       P1 | DV1-DV16 source complete                                                                                         | Run real microphone plus macOS/Linux package matrices                                                                                                 |
| Settings/MS4 cleanup        |       P2 | P1 correctness is complete                                                                                       | Stable IDs/active identity/profile validation, diagnostics, ARIA, labels, and responsive overflow                                                     |
| Git/Memory/MCP/Trust proof  |       P2 | Source implementations pass                                                                                      | Run real GitHub/Gitea, editor-watch, provider, MCP, SSH, restart, and visual matrices                                                                 |
| Terminal shell proof        |       P2 | Source, package compile, detection, and command probes pass                                                      | Run interactive pane, persistence, unavailable-profile, CLI, and SSH matrix                                                                           |
| Monitor proof               |       P2 | Read-only Agent/Flight v1 source complete                                                                        | Run packaged multi-display lifecycle and Rust-denial proof                                                                                            |

## Next

After the immediately available proof gates:

1. Implement the chosen Undo scope.
2. Close bounded Settings and main-shell MS4 work.
3. Finish Ollama capability-aware selection, auxiliary-task routing, retired
   conversation provider switching, and edit/diff honesty.
4. (Closed 2026-08-27) ~~Run the Syndicate acceptance matrix~~ — moot; the
   integration was removed when Syndicate separated from the Packet\* family.
5. (Paused 2026-08-16) Remote Agents: on pickup, resolve auth per
   `dev/remoteagents/10-pause-record.md` (E2EE already ratified), then execute
   Sprint 0 against the standalone Rust relay at `D:\projects\packetrelay`.
6. Land a private PWA/relay alpha with desktop-owned execution, narrow audited
   commands, device trust, reconnect/replay, approvals, and attention push.
7. Acquire distribution credentials and publish signed, updateable builds:
   Windows Authenticode for v1.0.0, then the signed and notarized macOS arm64
   DMG for v1.1 per [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).

## Later

- Packet Control: deterministic, user-initiated local/SSH evidence capture
  using one contract shared with PacketAgent.
- PacketBBS: bounded non-secret connection preset with safe external Web and
  Telnet launch.
- Monitor expansion: Approval/Cost routes, saved bounds, multiple windows, and
  PTY attachment only after ownership is safe.
- Detachable interactive Agent windows after a single-writer state contract.
- Native iOS/TestFlight after the Remote Agents PWA proves useful.
- Additional Gitea authoring/checks parity, semantic Memory retrieval when
  measured misses justify it, and alternate Dictation engines after real
  benchmarks.
- Linux packaging proof, macOS x86_64 alongside arm64, and Snap/Flatpak when
  distribution demand warrants them.

## Remote Agents v1 boundary

The first Remote Agents release is a PWA supervision surface through Packet
Cloud and the standalone Rust relay:

- Packet account sign-in and desktop device trust
- configured hosts, Workspaces, providers, models, profiles, and conversations
- start/continue API-agent conversations and stream `api-agent:*`
- permission/edit approval, cancel/retry/model changes, reconnect, and push
- encrypted sensitive payloads before external beta

Provider secrets, MCP servers, files, shells, tools, and execution stay on the
desktop. No generic remote Tauri bridge, raw PTY control, or cloud-side provider
execution belongs in v1.

## Architectural debt worth retaining

- Mid-session MCP hot-swap is unsupported; trust/config changes apply on next
  session start.
- `historyStore`, `projectHistoryStore`, and `promptStore` may overlap; perform
  consolidation only when a product change gives it a clear owner.
- `flightStore` owns persisted Flight CRUD; `asyncFlightStore` owns runtime
  attempts. Do not collapse them casually.
- Persisted Mission/Planner/retired-provider aliases remain read-only
  compatibility until their documented release-age gates are met.

## Release path

1. Prove the existing v0.10.3 Windows package interactively.
2. Close available real-host, microphone, provider, MCP, and cross-product
   evidence gates.
3. Resolve and implement Undo plus bounded Settings/MS4 work.
4. (Closed 2026-08-27) ~~Syndicate packaged acceptance matrix~~ — moot; the
   integration was removed with Syndicate's separation from the family.
5. (Paused 2026-08-16) Remote Agents: decide auth on pickup, then build the
   PWA/relay alpha. See `dev/remoteagents/10-pause-record.md`.
6. Add hosted CI, signing, notarization, and updater infrastructure.
7. Expand E2E coverage across session creation, API-agent launch, Remote Agents
   approvals, and Flight attempt lifecycle.

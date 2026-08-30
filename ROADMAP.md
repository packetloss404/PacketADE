# PacketBench Roadmap

Last reconciled: 2026-08-27

PacketBench is a local-first Agent Development Environment and remains the
flagship control surface. The desktop owns local providers, models, secrets,
Workspaces, MCP configuration, permissions, Memory, and execution.

There is no shipped remote supervision surface today. Syndicate separated from
the Packet\* product family on 2026-08-27 and its execution-target integration
was removed (`CHANGELOG.md` [Unreleased]), which leaves generic SSH — remote
Workspaces, PTY panes, and agent file/bash tools over a pinned connection — as
the only way to reach another machine. Remote Agents, unpaused 2026-08-27, is
the program that builds a supervision surface. The rule it has to satisfy is
therefore forward-looking rather than descriptive: phone and cloud surfaces
will supervise the authority the desktop already holds; they will not replace
it.

The detailed task ledger is [`backlog.md`](./backlog.md). This file contains
only product direction and ordering.

## Current baseline

- Source is at **0.13.0** (`package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`). `v0.10.3` — packaged for Windows from release source
  `61e0669` — is still the newest annotated tag, while `CHANGELOG.md` records
  0.10.4 and 0.10.5 as released, and 0.11.0 through 0.13.0 as built but
  unreleased.
- **The renamed product has been packaged, but never installed.** Windows
  bundles exist at 0.11.0, 0.12.0, 0.12.1 and 0.13.0 (hashes in `CHANGELOG.md`); the 2026-08-26
  rename moved the Tauri bundle identifier from `com.packetade.desktop` to
  `com.packetbench.desktop` along with the product name. Section 1 of the
  acceptance matrix ran from source on 2026-08-28 and found **two migration
  defects** — the data-dir veto (fixed in `544e4cc6`, verified against a copy of
  a real legacy dir) and localStorage across a bundle-identifier change (open,
  in `backlog.md`). An installed, upgraded `PacketBench` package remains the
  sharpest untested path in the tree.
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
- Closed record, not current capability: the first-class Syndicate execution
  target (scoped device pairing/revocation, Host-owned Workspaces, durable
  remote CLI panes, managed pinned-SSH bootstrap, encrypted PacketRelay
  transport) was implemented, reviewed, and then removed on 2026-08-27 when
  Syndicate separated from the Packet\* family. PacketBench ships none of it
  today; what survives is two tolerant deserializers
  (`src-tauri/src/core/workspace.rs:88`, `src/types/workspace.ts:108`) that
  degrade a persisted `syndicate` execution target to `None` instead of failing
  the state file. The pre-removal implementation is at `d87fb125`; the
  controller protocol continues in Syndicate's own repos.
- PacketRelay — the standalone Rust relay at `D:\projects\packetrelay` — now
  belongs to PacketBench (owner decision, 2026-08-27). It is no longer shared
  with or owned by Syndicate, and its deployment target is **Railway**,
  replacing the Cloud Run deployment it ran while it served Syndicate.

The remaining bottleneck is packaged, real-host acceptance proof, not another
broad source feature wave — and the package to prove is 0.13.0, which is built
and waiting to be installed.

## Now

| Track                       | Priority | Current state                                                                                                    | Next action                                                                                                                                           |
| --------------------------- | -------: | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged Windows acceptance |       P1 | 0.13.1 bundles built 2026-08-30 from `8dc13780` and hashed in `CHANGELOG.md`, superseding every earlier pair; sections 0 and 1 of `dev/acceptance-0.13.1.md` have run and found two migration defects. Three packaged installs have happened (0.12.1, 0.13.0, 0.13.1): the two upgrade rows and the cold-start row are closed, and 0.13.1 is the first build whose UI anyone has looked at | Install the 0.13.1 package over a machine carrying pre-rename state; prove the new bundle identifier and the data-dir/keyring migrations end to end; then run sections 2-5 — Terminal panes, Claude statusline, close/lifecycle, dictation on the real headset, analytics, Monitor, accessibility, and denial behavior |
| Distribution trust          |       P1 | **DEFERRED ON COST 2026-08-27** — owner decision to spend nothing on signing for now; v0.10.3 reported 0 failures / 6 readiness warnings and all artifacts remain unsigned | Keep shipping unsigned local builds. On the stated trigger — the first build handed to anyone who is not the owner — take the cheapest path (Azure Trusted Signing, ~$10/month), then wire hosted CI, notarization, and the updater. Terms in `backlog.md` |
| macOS release               |       P1 | Builds, bundles a DMG, and runs from source on real hardware; never signed, notarized, or interactively accepted | Run the unsigned acceptance matrix; start Apple Developer Program enrollment when v1.1 starts rather than now (deferred alongside signing on 2026-08-27); ship arm64 DMG in v1.1 (`dev/macos-release-plan.md`) |
| Remote Agents decisions     |       P1 | **UNPAUSED 2026-08-27** (paused 2026-08-16). The E2EE gate stays ratified — encrypted agent, approval, and file payloads are a hard requirement before any external beta. Auth resolved 2026-08-28: build passkey/magic-link into the relay (Rust on PostgreSQL), owner accepting the owned surface. **No blocking owner decision remains** | Run Sprint 0 against PacketRelay — PacketBench-owned, deploying to Railway. Size in the owned auth surface (WebAuthn, sessions, recovery, rate limiting) and treat the pre-beta security review as a gate alongside E2EE |
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
4. Remote Agents: auth resolved 2026-08-28 (build passkey/magic-link into the
   relay) and the E2EE gate ratified, so no owner decision blocks the program
   ([`dev/remoteagents/09-open-decisions.md`](./dev/remoteagents/09-open-decisions.md)).
   Execute Sprint 0 against
   PacketRelay at `D:\projects\packetrelay` — PacketBench-owned since
   2026-08-27 and deploying to Railway.
5. Land a private PWA/relay alpha with desktop-owned execution, narrow audited
   commands, device trust, reconnect/replay, approvals, and attention push.
6. When the signing deferral's trigger fires, acquire distribution credentials
   and publish signed, updateable builds: Windows Authenticode first, then the
   signed and notarized macOS arm64 DMG for v1.1 per
   [`dev/macos-release-plan.md`](./dev/macos-release-plan.md).

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
Cloud and PacketRelay, the standalone Rust relay at `D:\projects\packetrelay`
— PacketBench-owned since 2026-08-27 and deploying to Railway:

- Packet account sign-in and desktop device trust
- configured hosts, Workspaces, providers, models, profiles, and conversations
- start/continue API-agent conversations and stream `api-agent:*`
- permission/edit approval, cancel/retry/model changes, reconnect, and push
- encrypted sensitive payloads before external beta

Provider secrets, MCP servers, files, shells, tools, and execution stay on the
desktop. No generic remote Tauri bridge, raw PTY control, or cloud-side provider
execution belongs in v1.

How the account sign-in above is provisioned — hosted IdP, self-hosted IdP, or
built into the relay — is an open owner decision, not settled here.

## Architectural debt worth retaining

- Mid-session MCP hot-swap is unsupported; trust/config changes apply on next
  session start.
- `historyStore`, `projectHistoryStore`, and `promptStore` may overlap; perform
  consolidation only when a product change gives it a clear owner.
- `flightStore` owns persisted Flight CRUD; `asyncFlightStore` owns runtime
  attempts. Do not collapse them casually.
- Persisted Mission/Planner/retired-provider aliases, and the tolerant
  `syndicate` execution-target deserializers, remain read-only compatibility
  until their documented release-age gates are met.

## Release path

1. Interactively prove the packaged 0.13.0 `PacketBench` Windows package
   (built 2026-08-28), including upgrade from a pre-rename install.
2. Close available real-host, microphone, provider, MCP, and cross-product
   evidence gates.
3. Resolve and implement Undo plus bounded Settings/MS4 work.
4. Remote Agents: decide auth, then build the PWA/relay alpha on PacketRelay
   (Railway). See `dev/remoteagents/README.md`.
5. Add hosted CI, signing, notarization, and updater infrastructure once the
   signing deferral's trigger fires.
6. Expand E2E coverage across session creation, API-agent launch, Remote Agents
   approvals, and Flight attempt lifecycle.

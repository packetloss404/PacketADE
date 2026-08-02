# PacketADE Roadmap

Last updated: 2026-08-01 (Workspace/Agents and Settings IA are complete; the
five main-shell/right-dock decisions and MS1–MS3 are implemented; the
highest-priority operational-honesty residue is committed, pushed, fully
source-gated, and compiled into fresh unsigned Windows bundles; Remote Agents
remains preserved at its Sprint-0 decision gate)

> **2026-07-30 — State of the ADE review completed.** The State of the ADE
> review ran to
> completion on this date: a research fleet surveyed the landscape, a bug-fix
> pass landed, the root documentation set was overhauled, and Gemini CLI
> support was removed from the PTY session surface (saved Gemini panes reopen
> as plain terminals). Review recommendations are tracked in
> [`backlog.md`](./backlog.md#2026-07-30-state-of-the-ade-review).
>
> **Same day — the five main-shell decisions were made and implemented.** All
> five owner decisions landed in four commits (`a8abf54` D1, `531fbec` D3,
> `2898946` D4, `86cfac3` D2+D5), delivering the audit's MS1–MS3 slices with
> gates green at each step (build passing, lint at zero errors, Vitest
> 1260 → 1363 across 179 files). The UX quick wins and creation-flow fixes then
> shipped in `c3906c7`, the three deferred delete-cleanup decisions in
> `8cc2217`, and the remaining cleanup holes in `7cad08b` — typed
> worktree-cleanup outcomes, cooperative integration worktrees, startup view
> restore, issue and comment deletion, chrome de-duplication (Vitest 1581
> across 200 files, `cargo test` 452 with 2 ignored). The 2026-08-01 follow-up
> added the missing terminal-pane confirmation and made Agent Stop, Side Chat,
> and Monitor failure feedback truthful. Commit `fd8c226` is pushed, the full
> source gates pass, and fresh unsigned Windows app/MSI/NSIS artifacts exist.
> Remaining: manual packaged/MS4 proof and **undo** (an owner design
> decision: soft-delete + restore vs a time-boxed undo toast).

`ROADMAP.md` is the short product-direction document. It says what matters now
and why. The task ledger lives in [`backlog.md`](./backlog.md); implementation
briefs, runbooks, and historical planning live under [`dev/`](./dev/README.md).
For architectural conventions, see the local generated `AGENTS.md` and
`CLAUDE.md` files (intentionally gitignored). For the exact session restart
point, see [`HANDOFF.md`](./HANDOFF.md).

## North Star

PacketADE is a local-first agent development environment: the desktop remains
the source of truth for providers, models, secrets, workspaces, MCP config,
permissions, memory, and execution.

The completed Workspace/Agents product contract is the
[`Workspace/Agents restructuring`](./dev/workspace-agents-restructuring-goal.md):
make new Workspaces CLI/PacketCode-first, give GUI agents a first-class
same-window Agents surface, preserve existing conversation-pane compatibility,
and connect the surfaces with explicit handoffs. Interactive detachable Agent
windows wait for a safe single-writer state contract.

Remote Agents remains the next major networked product bet after this local
surface goal. It is preserved, not canceled, at its three Sprint-0 decisions.

## Now

| ID  | Track                                     | Priority | Status                                                                                                                                                                  | Canonical Plan                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R11 | Main shell and right-dock ownership       |       P1 | Decisions (MS1–MS3) and 2026-07-30 cleanup shipped; the 2026-08-01 operational-honesty fixes are implemented and focused-tested; MS4 packaged proof and **undo** remain | [`HANDOFF.md`](./HANDOFF.md), [`dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md)                                                                                                                                                                                                                       |
| R10 | Workspace/Agents restructuring            |       P0 | Complete; final owner policy implemented and fully verified                                                                                                             | [`dev/workspace-agents-restructuring-goal.md`](./dev/workspace-agents-restructuring-goal.md), [`dev/workspace-agents-wa0-route-contract.md`](./dev/workspace-agents-wa0-route-contract.md), [`dev/workspace-agents-wa3-handoff-evidence.md`](./dev/workspace-agents-wa3-handoff-evidence.md), [`dev/workspace-agents-wa4-dogfood-gate.md`](./dev/workspace-agents-wa4-dogfood-gate.md) |
| R0  | Remote Agents: PWA + Packet Cloud relay   |       P1 | Preserved; paused at three Sprint-0 product decisions                                                                                                                   | [`dev/remoteagents/README.md`](./dev/remoteagents/README.md)                                                                                                                                                                                                                                                                                                                           |
| R1  | Docs and planning consolidation           |       P1 | Root set overhauled 2026-07-30; ongoing maintenance                                                                                                                     | [`dev/README.md`](./dev/README.md)                                                                                                                                                                                                                                                                                                                                                     |
| R2  | Distribution readiness: signing + updater |       P1 | Still blocked on signing certificates                                                                                                                                   | [`dev/updater-setup.md`](./dev/updater-setup.md), [`dev/multi-platform-build.md`](./dev/multi-platform-build.md)                                                                                                                                                                                                                                                                       |
| R3  | Flight Deck supervision                   |       P1 | Core loops implemented; manual/SSH smoke remains                                                                                                                        | [`dev/bridgemind/reviewer-gate-loop.md`](./dev/bridgemind/reviewer-gate-loop.md), [`dev/bridgemind/cooperative-flight-graph-loop.md`](./dev/bridgemind/cooperative-flight-graph-loop.md), [`dev/bridgemind/coordination-inbox-loop.md`](./dev/bridgemind/coordination-inbox-loop.md), [`dev/bridgemind/autonomy-policy-loop.md`](./dev/bridgemind/autonomy-policy-loop.md)             |
| R4  | PacketCode integration                    |       P1 | Source integration complete; release proof gated                                                                                                                        | [`dev/bridgemind/packetcode-bridgecode-loop.md`](./dev/bridgemind/packetcode-bridgecode-loop.md)                                                                                                                                                                                                                                                                                       |
| R5  | PacketAgent deploy/supervise handoff      |       P1 | W9 consumer source implemented; live cross-repo proof gated                                                                                                             | [`dev/bridgemind/packetagent-handoff-loop.md`](./dev/bridgemind/packetagent-handoff-loop.md)                                                                                                                                                                                                                                                                                           |
| R6  | Project-local Memory Hub                  |       P2 | MH1–MH7 source complete; live external-edit/packaged proof gated                                                                                                        | [`dev/bridgemind/project-local-memory-hub-loop.md`](./dev/bridgemind/project-local-memory-hub-loop.md)                                                                                                                                                                                                                                                                                 |
| R7  | Dictation reliability                     |       P1 | DV1–DV16 source complete; packaged mic/platform matrix and DV17 gated                                                                                                   | [`dev/bridgemind/dictation-repair-hardening-loop.md`](./dev/bridgemind/dictation-repair-hardening-loop.md)                                                                                                                                                                                                                                                                             |
| R8  | Trust and provenance                      |       P2 | TP1–TP7 source complete; packaged provider/SSH proof gated                                                                                                              | [`dev/bridgemind/trust-provenance-loop.md`](./dev/bridgemind/trust-provenance-loop.md)                                                                                                                                                                                                                                                                                                 |
| R9  | Local-first MCP Hub                       |       P2 | Codex enforcement source complete; live SSH/packaged proof gated                                                                                                        | [`dev/bridgemind/local-first-mcp-hub-loop.md`](./dev/bridgemind/local-first-mcp-hub-loop.md)                                                                                                                                                                                                                                                                                           |

### Remote Agents Acceptance Shape

The first Remote Agents release is successful when a user can sign into a
Packet account from a PWA, trust a desktop host, see configured PacketADE
providers/models/profiles, start or continue API-agent conversations, stream
`api-agent:*` events, approve or deny permission/edit prompts, and receive push
notifications for attention-needed events. Provider secrets, MCP servers,
files, shells, and execution remain on the desktop. End-to-end encryption is a
gate before any external beta.

The v0.9.4 trust wave (SSH host-key pinning on async launch, remote SSH
file-tool confinement) hardened the _runtime_ connection path, but it does not
touch binary distribution. R2 stays blocked on the same external dependency:
acquiring Windows + macOS code-signing certificates. Once certificates land,
the remaining R2 work is wiring the signing config and Tauri updater per the
canonical plan docs.

## Next

The reliability loop in
[`dev/archive/p1-p2-fix-loop-spec.md`](./dev/archive/p1-p2-fix-loop-spec.md) is complete. The
orphaned deploy backend was already deleted; its unused constants and test mocks
have now been removed as well. Flight Deck Option B is implemented as an
explicit read-only `AgentConversation`: the user refines a structured plan,
applies milestones/tasks to the Flight, and launches attempts separately. It
does not restore the deleted autonomous Planner v1.

The approved BridgeMind-response work is ordered in
[`dev/bridgemind/pre-remote-agents-loop-queue.md`](./dev/bridgemind/pre-remote-agents-loop-queue.md).
The user confirmed and ran that queue on 2026-07-28. Source-completable work is
implemented through the MCP Hub boundary; convergence records the remaining
environment-dependent proof without entering Remote Agents. The combined local
gate and unsigned-package evidence is in
[`dev/bridgemind/pre-remote-convergence-2026-07-28.md`](./dev/bridgemind/pre-remote-convergence-2026-07-28.md).

| ID  | Track                     | Priority | Status                                                                                 | Next action                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------- | -------: | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Remote Agents Sprint 0    |       P1 | Paused at decision gate                                                                | After the current main-shell decision pass or explicit owner reprioritization, decide auth provider, E2EE timing, and code location before writing code.                                                                                                                                                                                                                                                                                                          |
| D2  | Flight Deck scope         |       P1 | Complete                                                                               | Option B shipped: upfront conversation-backed planning with explicit apply; attempts remain user-launched.                                                                                                                                                                                                                                                                                                                                                        |
| D3  | API-agent concurrency     |       P2 | Complete                                                                               | Turns now have compare-and-remove ownership; sidecar protocol v9 targets edit responses by `toolUseId`.                                                                                                                                                                                                                                                                                                                                                           |
| D4  | SSH parity verification   |       P2 | Partially complete / environment-gated                                                 | Saved-password path probing is fixed; run the surviving Claude Agent SDK and OpenAI Agents SDK remote-provider matrix when a pinned SSH host is available.                                                                                                                                                                                                                                                                                                        |
| D5  | Signing and updater       |       P1 | Externally blocked                                                                     | Acquire Windows/macOS credentials, then follow the existing release runbooks.                                                                                                                                                                                                                                                                                                                                                                                     |
| D6  | Flight supervision gates  |       P1 | Core implementation complete                                                           | Run packaged local/SSH/manual matrices for Reviewer Gate, cooperative integration, inbox delivery, and bounded YOLO.                                                                                                                                                                                                                                                                                                                                              |
| D7  | PacketCode release proof  |       P1 | Source integration complete                                                            | Publish signed multi-platform artifacts; run clean-machine install/upgrade/rollback and cross-product smoke.                                                                                                                                                                                                                                                                                                                                                      |
| D8  | Project-local Memory Hub  |       P2 | Source complete / environment-gated                                                    | Run packaged external-editor/watch, dirty/gitignored project, and platform proof; no source feature gap remains.                                                                                                                                                                                                                                                                                                                                                  |
| D9  | Dictation packaged smoke  |       P1 | Environment-gated                                                                      | Connect/enable an active microphone, then run the Windows 48 kHz, fast-PTT, cancel, history, in-app, clipboard, and external-paste matrix.                                                                                                                                                                                                                                                                                                                        |
| D10 | Trust and provenance      |       P2 | Source complete / environment-gated                                                    | Run packaged local/SSH/provider-parity evidence and visual inspection; keep current denial floors unchanged.                                                                                                                                                                                                                                                                                                                                                      |
| D11 | Local-first MCP Hub       |       P2 | Source complete / environment-gated                                                    | Run surviving-provider local/SSH crash/reload/version-skew, packaged catalog/removal, offline, trust-downgrade, and reconnect smoke.                                                                                                                                                                                                                                                                                                                              |
| D12 | Workspace/Agents surface  |       P0 | Ownership/source complete                                                              | New attachment is retired; preserve saved-pane compatibility. Run remaining SSH/external-runtime release proof separately; interactive native popouts still wait for one-writer state.                                                                                                                                                                                                                                                                            |
| D13 | Settings authority and IA |       P1 | Six-group IA and P1 authority/security source complete                                 | Run packaged OS-keyring and live pinned-SSH proof; continue stable scoped MCP IDs, active-project identity, provider-aware profile validation, and consolidated diagnostics before adding more preferences.                                                                                                                                                                                                                                                           |
| D14 | Main shell and right dock |       P1 | Decisions and P1 source cleanup implemented; MS4 proof and bounded residue open        | All five decisions and the delete/chrome/worktree cleanup loops shipped in 2026-07-30. The 2026-08-01 working tree adds terminal-pane confirmation, acknowledgement-bound Agent Stop and Side Chat cancellation, visible Monitor-open failure, one canonical cancel-pending control, and reviewed repo/host authority guards. Remaining work is MS4 packaged/responsive/accessibility and real Git-host proof, naming polish, and the separate undo design decision recorded in `backlog.md`. |

## Later

- Codex CLI app-server transport (A6): revisit when PacketADE needs long-lived
  app-server capabilities that `codex exec` cannot provide.
- Send to Monitor expansion: read-only Agent + Flight Monitor v1 is
  implemented. Approval/Cost routes, saved bounds, multi-window expansion, and
  PTY attachment remain later. See
  [`dev/send-to-monitor-plan.md`](./dev/send-to-monitor-plan.md).
- Native iOS / TestFlight for Remote Agents: evaluate after the PWA relay,
  auth, push, and mobile UX prove useful.
- Plugin system: community manifest format after distribution and updater work
  are no longer blocked.

## Shipped Foundation

Sprints 0-4, the Flight Deck worktree-attempt runtime, Reviewer Gate,
cooperative Flight graphs, Coordination Inbox, bounded YOLO policy, PacketCode
source integration, workspace panes, Issues, GitHub + Memory,
dictation, cost analytics, cost guardrails / budget thresholds, API-agent
conversations, sidecar protocol v11 (v6→v7 planner-amputation, v7→v8 S8-Phase-B
MCP-over-SSH, v8→v9 targeted edit responses, v9→v10 explicit `cancelled`
terminal marker, v10→v11 frozen MCP trust authority), PacketADE-as-MCP-server
(N3), MCP servers over SSH (S8 A+B),
remote git commands (S7), PTY-backed Codex CLI in remote Workspaces, local
quality gates, and the
conversation-as-tile compatibility foundation (the former "match Claude Code &
Codex" single-surface initiative, now retained only for saved Workspace panes)
are shipped. The
full release narrative lives in [`CHANGELOG.md`](./CHANGELOG.md).

The former autonomous Flight Planner v1 is historical, not a shipped current
surface: its UI/FSM was removed during the July 6 orchestration convergence and
its unreachable Rust/sidecar backend was amputated July 11. Flight Deck now has
the deliberately smaller Option B planning step on the normal conversation
contract; the deleted autonomous runtime remains out of scope.

Run the usual gates before release: `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm e2e`, `cargo check --manifest-path src-tauri/Cargo.toml`, and
`cargo test --manifest-path src-tauri/Cargo.toml`.

## Architectural Debt

- Rust backend test coverage is much stronger after the v0.9.2 / v0.9.3 audit
  waves, but several command/core follow-ups remain in `backlog.md`.
- Store consolidation should be product-led. `historyStore`,
  `projectHistoryStore`, and `promptStore` may overlap; `flightStore` (CRUD)
  and `asyncFlightStore` (runtime) now hold the flight state after
  `orchestrationStore` was pruned and its runtime responsibilities converged
  onto `asyncFlightStore`.
- Mid-session MCP hot-swap is not supported; `enabledMcpServerIds` changes
  apply on the next session start.
- Remote Agents must stay narrow: no generic remote Tauri bridge, no cloud-side
  provider secret handling, and no raw PTY control in the v1 scope.

## Release Path

1. Preserve the completed Workspace/Agents and Settings IA contracts.
2. Finish the main-shell wave: MS1–MS3 shipped 2026-07-30 with the five
   decisions, the UX quick wins and creation-flow fixes in `c3906c7`, and the
   delete cleanup in `8cc2217`; complete MS4 polish/proof plus the remaining
   cleanup holes (Rust worktree-error surfacing, cooperative integration
   worktrees, undo).
3. Run the packaged local/SSH/manual Flight supervision matrices and the
   PacketCode clean-machine release matrix.
4. Resolve the three Remote Agents Sprint-0 decisions, then split work against
   the six-agent runbook.
5. Land a private PWA/relay alpha with desktop-owned execution and audited
   command envelopes.
6. Consume the versioned PacketAgent worker contract when its active separate
   project publishes W1–W9; do not recreate durable execution in PacketADE.
7. Acquire Windows + macOS signing certificates.
8. Wire signing config and the Tauri updater.
9. Expand E2E coverage across workspace session creation, API-agent launch,
   Remote Agents approval flow, and the Flight attempt lifecycle.

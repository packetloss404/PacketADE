# PacketADE Development Plans

Last reconciled: 2026-08-03

This directory contains active implementation plans, proof runbooks, research,
and historical evidence. It is not a second backlog.

Use these documents in order:

1. [`../HANDOFF.md`](../HANDOFF.md) - exact restart state and release artifacts
2. [`../backlog.md`](../backlog.md) - only live item-level task register
3. [`../ROADMAP.md`](../ROADMAP.md) - product direction and ordering
4. [`../docs/reports/state-of-the-ade-2026-07-30.md`](../docs/reports/state-of-the-ade-2026-07-30.md), Section 0 - current consolidated audit state
5. A plan below only when executing its linked backlog item

Do not treat status tokens inside dated audits or files under `archive/` as live
work. Completed work belongs in `CHANGELOG.md`.

## Current release and proof

| Document                                                                     | Status                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`release-v0.10.3.md`](./release-v0.10.3.md)                                 | **CURRENT RELEASE RECORD** - tagged source, final gates, Windows artifacts, hashes, and known unsigned status                                                                             |
| [`proof-audit-2026-08-01.md`](./proof-audit-2026-08-01.md)                   | **DATED SNAPSHOT** - exact August 1 source/package proof; superseded for current counts and package identity by v0.10.3, but still authoritative for why each external gate remained open |
| [`local-quality-gates.md`](./local-quality-gates.md)                         | Current local gate commands and release-check composition                                                                                                                                 |
| [`beta-distribution-trust-runbook.md`](./beta-distribution-trust-runbook.md) | Signing/updater/release-candidate runbook                                                                                                                                                 |
| [`multi-platform-build.md`](./multi-platform-build.md)                       | Windows/macOS/Linux prerequisites and build flow                                                                                                                                          |
| [`updater-setup.md`](./updater-setup.md)                                     | Tauri updater runbook; updater is not enabled                                                                                                                                             |
| [`release-v0.10.2.md`](./release-v0.10.2.md)                                 | Historical immutable release record                                                                                                                                                       |

## Current product contracts

| Area                         | Canonical document                                                                                                         | Status                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Workspace/Agents             | [`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md)                                       | **COMPLETE** - CLI/PacketCode-first Workspaces; first-class same-window Agents; no new Workspace conversation attachments |
| Route/compatibility contract | [`workspace-agents-wa0-route-contract.md`](./workspace-agents-wa0-route-contract.md)                                       | **LOCKED; WA1-WA4 COMPLETE**                                                                                              |
| Handoff evidence             | [`workspace-agents-wa3-handoff-evidence.md`](./workspace-agents-wa3-handoff-evidence.md)                                   | Source complete; local/SSH/external-runtime proof remains                                                                 |
| Attachment retirement        | [`workspace-agents-wa4-dogfood-gate.md`](./workspace-agents-wa4-dogfood-gate.md)                                           | **COMPLETE** - `Open alongside Workspace` retired; saved panes preserved                                                  |
| Completion audit             | [`workspace-agents-completion-audit-2026-07-29.md`](./workspace-agents-completion-audit-2026-07-29.md)                     | **COMPLETE**                                                                                                              |
| Settings                     | [`workspace-agent-settings-decision-2026-07-29.md`](./workspace-agent-settings-decision-2026-07-29.md)                     | Six-group IA and P1 authority/security complete; bounded P2 and packaged/live proof remain                                |
| Main shell/right dock        | [`main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./main-shell-navigation-and-right-panel-audit-2026-07-29.md) | Decisions implemented; MS4 accessibility/responsive proof and bounded residue remain                                      |

The former Tile program is archived under
[`archive/tile-program/`](./archive/tile-program/). It executed useful substrate
work, but its final Agents-tab-retirement direction was explicitly superseded
by the current Workspace/Agents contract. Do not resume it.

## Active implementation and proof plans

| Track                    | Canonical document                                                                                 | Current boundary                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Remote Agents            | [`remoteagents/README.md`](./remoteagents/README.md)                                               | Next major networked product; standalone Rust relay selected; auth and E2EE decisions block implementation          |
| Remote provider parity   | [`sidecar-over-ssh-verification.md`](./sidecar-over-ssh-verification.md)                           | Surviving Claude Agent SDK/OpenAI Agents SDK pinned-SSH matrix remains                                              |
| SSH/workspaces           | [`ssh-remote-loop.md`](./ssh-remote-loop.md)                                                       | S1-S8 shipped; Windows-OpenSSH and larger streamed transfers remain later/environment-gated                         |
| Flight Reviewer          | [`bridgemind/reviewer-gate-loop.md`](./bridgemind/reviewer-gate-loop.md)                           | Source/automated proof complete; RG8 packaged local/SSH/manual gate remains                                         |
| Cooperative Flights      | [`bridgemind/cooperative-flight-graph-loop.md`](./bridgemind/cooperative-flight-graph-loop.md)     | Source/automated proof complete; CG9 landing/release-like gate remains                                              |
| Coordination Inbox       | [`bridgemind/coordination-inbox-loop.md`](./bridgemind/coordination-inbox-loop.md)                 | Source/automated proof complete; CI9 real-runtime matrix remains                                                    |
| Bounded YOLO             | [`bridgemind/autonomy-policy-loop.md`](./bridgemind/autonomy-policy-loop.md)                       | Source/automated proof complete; AP9 adversarial/release-like matrix remains                                        |
| PacketAgent handoff      | [`bridgemind/packetagent-handoff-loop.md`](./bridgemind/packetagent-handoff-loop.md)               | W9 consumer source complete; live close/restart and contract/UI slices remain                                       |
| PacketCode integration   | [`bridgemind/packetcode-bridgecode-loop.md`](./bridgemind/packetcode-bridgecode-loop.md)           | Source hardening complete; published signed release and cross-product proof remain                                  |
| Project Memory           | [`bridgemind/project-local-memory-hub-loop.md`](./bridgemind/project-local-memory-hub-loop.md)     | MH1-MH7 source complete; MH8/MH9 editor/package proof remains                                                       |
| MCP Hub                  | [`bridgemind/local-first-mcp-hub-loop.md`](./bridgemind/local-first-mcp-hub-loop.md)               | Source complete; MCPH3/MCPH8 local/SSH/provider/package proof remains                                               |
| Trust/provenance         | [`bridgemind/trust-provenance-loop.md`](./bridgemind/trust-provenance-loop.md)                     | TP1-TP7 source complete; TP8 environment proof remains                                                              |
| Dictation                | [`bridgemind/dictation-repair-hardening-loop.md`](./bridgemind/dictation-repair-hardening-loop.md) | DV1-DV16 source complete; physical/package matrix remains                                                           |
| Issue-to-Flight          | [`issue-flight-mirror-design.md`](./issue-flight-mirror-design.md)                                 | P0-P3 source complete; packaged GitHub/Gitea proof remains                                                          |
| Monitor                  | [`send-to-monitor-plan.md`](./send-to-monitor-plan.md)                                             | Read-only Agent/Flight v1 source complete; packaged multi-display/denial proof remains                              |
| Local model routing      | [`local-model-routing.md`](./local-model-routing.md)                                               | In progress: Ollama picker gating, auxiliary routing, optional compatible endpoint, and re-scoped measurement       |
| API-agent auth cleanup   | [`oauth-removal-plan.md`](./oauth-removal-plan.md)                                                 | Credential migration complete; explicit retired-conversation provider switch remains                                |
| Cost controls/efficiency | [`cost-efficiency-loop.md`](./cost-efficiency-loop.md)                                             | Reporting surface removed; caching/edit improvements partly complete; live measurement and bounded edit debt remain |
| Packet Control           | [`packet-control-loop.md`](./packet-control-loop.md)                                               | Proposed, not started; shared evidence contract must precede implementation                                         |
| PacketBBS                | [`features-packetbbs-terminal.md`](./features-packetbbs-terminal.md)                               | Proposed later, bounded non-secret connection preset                                                                |

## Research and reference

- [`competitors.md`](./competitors.md) indexes the competitive research.
- [`bridgemind/bridgespace-competitive-brief.md`](./bridgemind/bridgespace-competitive-brief.md)
  and [`bridgemind/bridgeswarm-teardown.md`](./bridgemind/bridgeswarm-teardown.md)
  are product/landscape references, not task registers.
- [`mobile/README.md`](./mobile/README.md) is explicitly superseded for
  implementation by `remoteagents/`; keep it only as earlier research.
- [`zen-workspace/`](./zen-workspace/) contains shipped feature/history notes.
- [`spike-macos-keychain-namespacing.md`](./spike-macos-keychain-namespacing.md)
  remains an environment-gated Mac research task.

## Archive

[`archive/`](./archive/) is cold storage for completed, superseded, or dated
planning material. Notable boundaries:

- Flight Planner v1 documents describe a deleted runtime; do not restore it.
- `archive/tile-program/` describes the superseded plan to retire Agents into
  Workspace conversation tiles. The current product contract reversed that
  direction while preserving saved-pane compatibility.
- Reliability low-finding and July P1/P2 loop documents are complete.
- Historical code reviews and positioning documents may explain decisions but
  do not create work outside `../backlog.md`.

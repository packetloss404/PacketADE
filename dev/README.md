# Dev Planning Docs

Last updated: 2026-07-30

This directory holds **active** planning docs with outstanding work items plus the engineering reference docs that used to live in `docs/`. Completed docs have been moved to `dev/archive/`.

## Planning Ownership

Use these as the trust anchors before reading older plan files:

| Area                                 | Canonical owner                                                                                                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session restart point                | [`../HANDOFF.md`](../HANDOFF.md)                                                                                                                                                                                                     | **CURRENT** — completed product decisions, the five pending main-shell/right-dock choices, environment gates, latest Windows build evidence, guardrails, and recommended first prompt.                                                                                               |
| Live task register                   | [`../backlog.md`](../backlog.md)                                                                                                                                                                                                     | Single source for outstanding work. The July P1/P2 hardening loop is complete.                                                                                                                                                                                                       |
| Reliability remediation              | [`reliability-low-fix-loop-2026-07-19.md`](./reliability-low-fix-loop-2026-07-19.md)                                                                                                                                                 | Completed 30-finding revalidation, fix, regression, and verification record.                                                                                                                                                                                                         |
| Release priorities                   | [`../ROADMAP.md`](../ROADMAP.md)                                                                                                                                                                                                     | Short current summary; detailed plans stay in this folder.                                                                                                                                                                                                                           |
| **Current product contract**         | [`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md)                                                                                                                                                 | **COMPLETE** — CLI/PacketCode-first Workspaces, first-class same-window Agents, attachment producers retired, saved-pane compatibility preserved, and detachable interactivity deferred pending a single-writer contract.                                                            |
| Workspace/Agents WA0 contract        | [`workspace-agents-wa0-route-contract.md`](./workspace-agents-wa0-route-contract.md)                                                                                                                                                 | **LOCKED** — authoritative current/target route matrix, creation ownership, compatibility policy, handoff authority boundaries, detachable-window gate, and WA1–WA4 implementation proof.                                                                                            |
| Workspace/Agents WA3 evidence        | [`workspace-agents-wa3-handoff-evidence.md`](./workspace-agents-wa3-handoff-evidence.md)                                                                                                                                             | **SOURCE COMPLETE** — typed identity-preserving Workspace, Agent, PacketCode, Git, Flight, PacketAgent, and Monitor handoffs; manual local/SSH and live external-runtime proof remain.                                                                                               |
| Workspace/Agents WA4 decision        | [`workspace-agents-wa4-dogfood-gate.md`](./workspace-agents-wa4-dogfood-gate.md)                                                                                                                                                     | **COMPLETE** — owner retired new Workspace conversation attachments; all producers/materializers are removed while saved panes remain load-compatible.                                                                                                                               |
| Workspace/Agents completion audit    | [`workspace-agents-completion-audit-2026-07-29.md`](./workspace-agents-completion-audit-2026-07-29.md)                                                                                                                               | **COMPLETE** — requirement-by-requirement ownership, attachment-removal, hydration, compatibility, handoff, and external-runtime matrix.                                                                                                                                             |
| Workspace/Agents + Settings evidence | [`workspace-agent-settings-decision-2026-07-29.md`](./workspace-agent-settings-decision-2026-07-29.md)                                                                                                                               | Six-group Settings IA **APPROVED AND IMPLEMENTED** with lossless sub-tabs, search, scope badges, and typed recovery routes; placebo/runtime-authority corrections remain open.                                                                                                        |
| Main shell and right-panel audit     | [`main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./main-shell-navigation-and-right-panel-audit-2026-07-29.md)                                                                                                           | **REVIEW COMPLETE** — independent source audit of main navigation, toolbar/status actions, tabs, labels, right-side panel ownership/alignment, remote boundaries, and feature wiring; owner decisions and implementation remain open.                                                  |
| Remote/mobile agent access           | [`remoteagents/README.md`](./remoteagents/README.md)                                                                                                                                                                                 | Supersedes the older `mobile/` investigation for phone/PWA work.                                                                                                                                                                                                                     |
| Multi-monitor operations             | [`send-to-monitor-plan.md`](./send-to-monitor-plan.md)                                                                                                                                                                               | V1 SOURCE COMPLETE — one reusable read-only Agent/Flight Monitor with backend lease, separate shell, narrow plugin capability, and Rust application-command allowlist; packaged multi-display/denial proof and later surfaces remain.                                                |
| Competitor landscape                 | [`competitors.md`](./competitors.md)                                                                                                                                                                                                 | Master competitor index (12 peers). Deep dives: [`bridgemind/bridgespace-competitive-brief.md`](./bridgemind/bridgespace-competitive-brief.md), [`bridgemind/bridgeswarm-teardown.md`](./bridgemind/bridgeswarm-teardown.md). Provider/auth abstraction is the moat the field lacks. |
| Pre-Remote-Agents loop queue         | [`bridgemind/pre-remote-agents-loop-queue.md`](./bridgemind/pre-remote-agents-loop-queue.md)                                                                                                                                         | LOCALLY CONVERGED — source work, full local gates, and unsigned Windows bundles are complete; exact environment/external-runtime proof remains isolated in [`bridgemind/pre-remote-convergence-2026-07-28.md`](./bridgemind/pre-remote-convergence-2026-07-28.md).                   |
| Flight escalation loop               | [`bridgemind/flight-escalation-loop.md`](./bridgemind/flight-escalation-loop.md)                                                                                                                                                     | SHIPPED E1–E9 — assisted escalation (Option B): automatic detection/recommendation with user-approved retry or reassignment.                                                                                                                                                         |
| Reviewer Gate loop                   | [`bridgemind/reviewer-gate-loop.md`](./bridgemind/reviewer-gate-loop.md)                                                                                                                                                             | IMPLEMENTED — RG1–RG7 closed; RG8 retains release-like local/SSH/manual smoke.                                                                                                                                                                                                       |
| Cooperative Flight graph             | [`bridgemind/cooperative-flight-graph-loop.md`](./bridgemind/cooperative-flight-graph-loop.md)                                                                                                                                       | IMPLEMENTED — CG1–CG8 closed; CG9 retains final landing and release-like local/SSH/manual smoke.                                                                                                                                                                                     |
| YOLO autonomy overlay                | [`bridgemind/autonomy-policy-loop.md`](./bridgemind/autonomy-policy-loop.md)                                                                                                                                                         | IMPLEMENTED — AP1–AP8 closed; AP9 retains adversarial and release-like smoke.                                                                                                                                                                                                        |
| Coordination inbox loop              | [`bridgemind/coordination-inbox-loop.md`](./bridgemind/coordination-inbox-loop.md)                                                                                                                                                   | IMPLEMENTED — CI1–CI8 closed; CI9 retains release-like API/PTY/MCP/local/SSH smoke.                                                                                                                                                                                                  |
| PacketAgent handoff loop             | [`bridgemind/packetagent-handoff-loop.md`](./bridgemind/packetagent-handoff-loop.md)                                                                                                                                                 | W9 CONSUMER SOURCE IMPLEMENTED — frozen fixture/digest compatibility, keyring connection, Flight deploy/activate/reconnect/control/evidence projection; live cross-repo close/restart and missing approval-response contract remain.                                                 |
| PacketCode integration loop          | [`bridgemind/packetcode-bridgecode-loop.md`](./bridgemind/packetcode-bridgecode-loop.md)                                                                                                                                             | SOURCE INTEGRATION IMPLEMENTED — PC1–PC4/PC6–PC8 closed; published release, remaining hardening, clean-machine, and PacketAgent compatibility gates remain.                                                                                                                          |
| Project-local Memory Hub             | [`bridgemind/project-local-memory-hub-loop.md`](./bridgemind/project-local-memory-hub-loop.md)                                                                                                                                       | MH1–MH7 SOURCE COMPLETE — Markdown repository, graph/health, unified retrieval, provenance capture, UI, and scoped MCP are implemented; packaged editor/watch interoperability is gated.                                                                                             |
| Local-first MCP Hub                  | [`bridgemind/local-first-mcp-hub-loop.md`](./bridgemind/local-first-mcp-hub-loop.md)                                                                                                                                                 | SOURCE COMPLETE — reviewed catalog, diagnostics, protocol-v11 frozen trust including the Codex CLI MCP trust proxy, audit/reconnect, suite resources, and unified UI; real Codex/local/SSH and packaged MCPH3/MCPH8 proof remains.                                                   |
| Dictation repair loop                | [`bridgemind/dictation-repair-hardening-loop.md`](./bridgemind/dictation-repair-hardening-loop.md)                                                                                                                                   | DV1–DV16 SOURCE COMPLETE — stable device doctor, bounded capture, opt-in shortcut trust, safe editor/PTY insertion, packaging metadata, and private telemetry added; physical/package matrix and DV17 are gated.                                                                     |
| Trust and provenance loop            | [`bridgemind/trust-provenance-loop.md`](./bridgemind/trust-provenance-loop.md)                                                                                                                                                       | TP1–TP7 SOURCE COMPLETE — shared envelope, ingestion/persistence, UI, risky-action gates, downstream lineage, and redacted audit are implemented; packaged provider/SSH parity is gated.                                                                                             |
| Memory v0.9+ loop                    | [`memory-v9-loop.md`](./memory-v9-loop.md)                                                                                                                                                                                           | SHIPPED (M1–M10, merged 2026-07-24) — fleshed out the Memory pane: fixed half-wired gaps (search/task_completed/confidence/retrospective) + shipped the deferred enhancements. Embeddings deferred.                                                                                  |
| Gitea/Forgejo support loop           | [`gitea-support-loop.md`](./gitea-support-loop.md)                                                                                                                                                                                   | SHIPPED (G1–G14, merged 2026-07-25) — self-hosted Gitea/Forgejo alongside GitHub, both configurable at once, resolved per-workspace from the origin remote. Peer-reviewed.                                                                                                           |
| GitHub pane v0.9+ loop               | [`github-pane-v9-loop.md`](./github-pane-v9-loop.md)                                                                                                                                                                                 | SHIPPED GP1–GP7; the follow-on Issue⇄Flight P0–P3 source is now complete and awaits packaged GitHub/Gitea proof.                                                                                                                                                                     |
| SSH & remote workspaces loop         | [`ssh-remote-loop.md`](./ssh-remote-loop.md)                                                                                                                                                                                         | SHIPPED S1–S8 plus the native S7 wire rename (`serverId`, legacy aliases retained). S9/S10/S11 remain environment-gated.                                                                                                                                                             |
| SSH workspace parity                 | [`sidecar-over-ssh-verification.md`](./sidecar-over-ssh-verification.md)                                                                                                                                                             | Test and manual verification contract for subscription providers on remote workspaces.                                                                                                                                                                                               |
| MCP provider transport               | [`mcp-provider-transport.md`](./mcp-provider-transport.md)                                                                                                                                                                           | SHIPPED (N3) — PacketADE-as-MCP-server: reads + opt-in append-only writes. Doc records the cut/deferred tools.                                                                                                                                                                       |
| Build and release ops                | [`multi-platform-build.md`](./multi-platform-build.md), [`updater-setup.md`](./updater-setup.md), [`local-quality-gates.md`](./local-quality-gates.md), [`beta-distribution-trust-runbook.md`](./beta-distribution-trust-runbook.md) | Operational runbooks, not feature backlogs.                                                                                                                                                                                                                                          |
| v0.10.2 release record               | [`release-v0.10.2.md`](./release-v0.10.2.md)                                                                                                                                                                                         | Windows x64 build gates, artifact sizes/hashes, unsigned status, and known non-failing warnings.                                                                                                                                                                                     |
| Historical plans                     | [`archive/`](./archive/)                                                                                                                                                                                                             | Cold storage; do not treat as current unless an active doc links to a specific artifact as background.                                                                                                                                                                               |

### Verification checkpoint — 2026-07-30

The Settings/main-shell source passes `pnpm format:check`, `pnpm lint` (zero
errors; nine existing Fast Refresh warnings), all 1,261 Vitest tests,
`pnpm build`, and all eight Playwright web-mode smokes. The earlier full
deterministic sidecar and Rust gates remain recorded in
[`bridgemind/pre-remote-convergence-2026-07-28.md`](./bridgemind/pre-remote-convergence-2026-07-28.md).
On 2026-07-30, `pnpm tauri build` from functional commit `a7feb4a` produced
fresh unsigned v0.10.2 Windows EXE/MSI/NSIS artifacts and
`pnpm sidecar:install` restored development dependencies. Exact hashes and the
post-tag-build distinction are in [`../HANDOFF.md`](../HANDOFF.md#latest-windows-build).
Live microphone/SSH/provider/external-editor, real Codex MCP, PacketAgent,
other-platform, signing, updater, and manual packaged proof remain open exactly
where the loop ledgers say they do.

## Reference

Technical runbooks and how-tos. Not backlog items themselves (those live in [`/backlog.md`](../backlog.md)), but the docs the backlog points at.

- `local-quality-gates.md` — preflight / full-check pipeline, individual gate commands
- `multi-platform-build.md` — macOS / Linux / Windows prerequisites + build flow + cross-compile notes
- `beta-distribution-trust-runbook.md` — beta release trust gates, signing/updater credential checks, and release-candidate flow
- `sidecar-over-ssh-verification.md` — test and manual checklist for Sidecar-over-SSH provider parity
- `updater-setup.md` — runbook for wiring up the Tauri v2 auto-updater (currently not enabled)
- `bridgemind/swarm-orchestration-plan.md` — shipped human-in-the-loop escalation design record
- `bridgemind/packetade-mcp-server-plan.md` / `mcp-provider-transport.md` — shipped PacketADE MCP-provider design records; future Hub expansion belongs to `bridgemind/local-first-mcp-hub-loop.md`
- `ssh-tech-debt.md` — redirect to `/backlog.md` (left for old links)
- `p1-p2-fix-loop-spec.md` / `session-resume-2026-07-19.md` — completed July hardening loop and verification record

> Dated `code-review-YYYY-MM-DD.md` files (e.g. `code-review-2026-05-31.md`, `code-review-2026-06-07.md`) are intentionally left unindexed point-in-time audit artifacts; actionable items from them land in `/backlog.md`.

## Active (Outstanding Items)

### Current goal and decision gates

- The current owner conversation is the five-decision main-shell/right-dock
  review in [`../HANDOFF.md`](../HANDOFF.md) and
  [`main-shell-navigation-and-right-panel-audit-2026-07-29.md`](./main-shell-navigation-and-right-panel-audit-2026-07-29.md).
  Do not start its implementation loop until those choices are confirmed.
- Workspace/Agents restructuring is complete. The canonical contract and
  evidence are in
  [`workspace-agents-restructuring-goal.md`](./workspace-agents-restructuring-goal.md),
  [`workspace-agents-wa0-route-contract.md`](./workspace-agents-wa0-route-contract.md),
  and
  [`workspace-agents-completion-audit-2026-07-29.md`](./workspace-agents-completion-audit-2026-07-29.md).
  SSH and external-runtime sign-off remain separate release gates.
- Remote Agents remains preserved and paused on its three Sprint-0 choices:
  auth provider, E2EE timing, and code location.
- The six-group Settings information architecture is implemented. The remaining
  authority and capability corrections are tracked in
  [`workspace-agent-settings-decision-2026-07-29.md`](./workspace-agent-settings-decision-2026-07-29.md).
- Flight Deck Option B is implemented: upfront read-only
  `AgentConversation`-backed planning with an explicit apply step. The old
  autonomous Planner v1 remains historical, not a restoration candidate.
- Distribution remains blocked on Windows and macOS signing credentials.
- The mechanical G33/F53/G01/Unix-SSH/G09 hardening loop and deploy-backend cleanup are complete.
- The 30 low-rated Reliability audit findings are closed; `backlog.md` no longer carries them.

### Flight Planner (archived — backend amputated 2026-07-11)

The Flight Planner planning docs are now in [`archive/`](./archive/). The Rust
flight-planner backend's fate was resolved and executed: the shared executor
money path was extracted into `commands/flight_cost.rs`, then the
genuinely-dead planner command family, prompts, journal, and the sidecar's
in-process planner MCP surface were deleted (sidecar protocol bumped to v7).
See [`../backlog.md`](../backlog.md#flight-deck) for the current audit and
remaining decisions. Do not resume this work from the archived docs — they describe the
deleted v1 planner surface.

The live Flight Deck is the smaller worktree-attempt system
(`flightStore.ts` + `asyncFlightStore.ts` + `commands/flight_attempts.rs`), not
the archived autonomous Planner. A 2026-07-19 audit verified that separation and
fixed launch-persistence, pre-cleanup draft-PR publishing, and SSH terminal
cleanup races. Option B subsequently added a lightweight explicit planning step
on the normal `AgentConversation` contract; plans are user-applied and attempts
remain user-launched. Do not restore archived Planner v1.

- `archive/flight-planner-v1-acceptance-runbook.md` — manual sign-off runbook (v1, deleted backend)
- `archive/flight-planner-reliability-continuity-pack.md` — reliability + continuity contract for Flight Planner journals (deleted backend)
- `archive/flight-planner-plan.md` and `archive/flight-planner-spike-retro.md` — locked v1 design/reference (deleted backend)

### Workspace UX

- `zen-workspace/features-git-workspace.md` and
  `zen-workspace/features-prompt-library.md` remain design/history references;
  direct review-packet diff opening and command-palette prompt launch are now
  implemented.

### Remote Agents

- `remoteagents/README.md` — cloud-relayed PWA Remote Agents plan, architecture, security, protocol, implementation sprints, and six-agent runbook

### Monitor Windows

- `send-to-monitor-plan.md` — implemented v1 Agent/Flight Monitor record plus
  later Approval/Cost, multi-window, saved-bounds, and PTY-attachment work

### Superseded / Research

- `mobile/README.md` — prior mobile companion investigation, superseded for implementation by `remoteagents/README.md`
- `archive/v0.8-github-and-memory.md` — historical v0.8 plan (archived); current open items belong in `/backlog.md`

## Archive

`dev/archive/` contains completed planning docs preserved for historical reference. Many archived files intentionally keep the former PacketCode name because they describe research and decisions made before the rename:

- `archive/backlog.md`, `archive/cross-competitor-map.md`, `archive/positioning-notes.md`, `archive/priority-resolution.md`
- `archive/agents-tab-modernization-plan.md` — 314-finding review that seeded the Agents-tab Waves 1–4 (surface since folded into the tile composer)
- `archive/flight-planner-plan.md`, `archive/flight-planner-spike-retro.md`, `archive/flight-planner-v1-acceptance-runbook.md`, `archive/flight-planner-reliability-continuity-pack.md` — Flight Planner v1 design/reference/runbooks (backend amputated 2026-07-11, see `/backlog.md`)
- `archive/v0.8-github-and-memory.md` — locked v0.8 GitHub + Memory design/scope
- `archive/sprints-2026-06-15.md` — post-rename sprint plan; residual open items folded into `/backlog.md`
- `archive/moat/` — memory layer, insights, deploy, scaffold, analytics, cost unification specs
- `archive/bridgemind/` — gap analysis, workspace editor scale, positioning notes
- `archive/quadcode/` — gap analysis, terminal features, AI platform features
- `archive/zen-workspace/` — workspace model plan, gap analysis, research, project-workspaces feature spec
- `archive/vibetotext/` — sprint plan, features spec, README

> Dated `code-review-YYYY-MM-DD.md` files (e.g. `code-review-2026-05-31.md`, `code-review-2026-06-07.md`) are intentionally unindexed: they are point-in-time audit artifacts, not active planning docs. Outstanding items they surfaced are tracked in [`/backlog.md`](../backlog.md).

## Tracks (All Implemented)

All five product tracks have been implemented:

- **W** — Workspace Foundation (workspace-per-project) ✅
- **X** — Workspace UX (templates, editor, git, prompts) ✅
- **S** — Swarm Orchestration (roles, ownership, coordination) ✅
- **M** — MCP Provider (frontend + Rust MCP server transport) ✅ (N3 shipped)
- **T** — TUI Evolution (polling, search, leader key) ✅

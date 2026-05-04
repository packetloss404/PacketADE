# PacketADE Roadmap

Last updated: 2026-05-04

This file replaces the prior `dev/REMAINING-WORK.md`, `dev/PROJECT-STATUS.md`, `dev/SPRINT-04-MISSION-WORKSPACE.md`, and `dev/ARCHITECTURE.md` planning docs. For architectural conventions, see `CLAUDE.md`.

Detailed strategic planning now lives under `dev/`. `ROADMAP.md` remains the top-level summary of release blockers, active product priorities, and known gaps.

## Status

Sprints 0–4 are shipped. Mission/Flight Deck work, workspace panes, API-agent conversations, sidecar v2, crash reporting, dictation, cost analytics, and Playwright E2E infrastructure are in place. The **Agents-pane "match Claude Code & Codex"** initiative shipped in May 2026 across 25+ slices: Tier 1 polish, Tier 2 killer features (durable profiles, Plan panel, hunk-level diffs, reviewer subagent, agent tray, AGENTS.md, memory editor), Tier 3 sidecar protocol v3 → v4 (plan_block / tool_output_extended / turn_summary events, mergedContent / cancel_pending_tools requests, resume tokens, auto-failover, worktree-per-conversation), F1–F10 follow-ups (auto-resume, in-process per-hunk parity, MCP toggle, Plan-first Spec stage, etc.), and the **Codex Spring 2026 absorption** (todo_list → plan_block, reasoning_tokens, sub-agent attribution, AGENTS.md cascading resolver, ProjectRulesCard, hover-`+` diff comments, smart-approval prefix proposal, composer Local/Worktree/Cloud picker, right-rail tabbed mode, persistent goals bridged to Missions, live spend HUD, Plan-with-Claude → Execute-with-Codex handoff, old-model pinning). Only A6 (Codex CLI app-server transport migration) deferred. Phase 3 distribution prep remains the major release track.

Run the usual gates before release: `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm e2e`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

## Remaining Work

### Active Product Priorities

| ID  | Task                                       | Priority | Status  | Notes                                                                                                                                                                          |
| --- | ------------------------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0  | Agents pane — match Claude Code & Codex    | High     | Shipped | Tier 1 + Tier 2 + Tier 3 + F1–F10 + Codex Spring 2026 absorption (A1–A5 + B1–B9) all landed across May 2026 commits `80c79f8` → `8f49083`. Sidecar protocol v4. Only A6 (Codex CLI app-server transport) deferred — current shell-out works, no consumer pulls for app-server capabilities yet. |
| P1  | Swarm orchestration escalation             | High     | Partial | Roles, owned paths, collision detection, coordination feed, and handoff logs are implemented; automatic reassignment remains deferred. See `dev/bridgemind/swarm-orchestration-plan.md`. |
| P2  | PacketADE MCP server transport             | High     | Deferred | Frontend provider config/resource/tool definitions exist; Rust transport and external-client serving are deferred. See `dev/mcp-provider-transport.md`. |
| P3  | Git review packet integration              | Medium   | Partial | Workspace GitDashboard exists; review packet and flight approval ties are not fully wired. See `dev/zen-workspace/features-git-workspace.md`. |
| P4  | Cost alerts                                | Medium   | Not started | Cost dashboard reads backend usage analytics + LiveSpendChip surfaces today's spend; budget/alert workflows on top of that remain nice-to-have. See `dev/moat/cost-dashboard-plan.md`. |
| P5  | Codex CLI app-server transport (A6)        | Low      | Deferred | Migrate the Codex sidecar from per-turn `codex exec` shell-out to the long-lived `codex app-server` JSON-RPC transport. Unlocks multi-environment per-turn, FS RPCs, streaming PTY, structured elicitations. Re-evaluate when a PacketADE feature actually needs one of these. |

### Strategy Notes

- **Voice / dictation** has a local Whisper-backed module now. Broader desktop-wide voice workflows remain backlog material; the original backlog notes live in `dev/archive/backlog.md`.
- **Local-first** remains the product stance. PacketADE should compete as a local-first orchestration tool, not a cloud-first product suite. Historical positioning notes live in `dev/archive/positioning-notes.md`.

### Phase 3 — Distribution

| ID  | Task                       | Priority | Status        | Notes                                                                                                                                                  |
| --- | -------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Code signing (Win + macOS) | Critical | Blocked       | Needs EV/OV certificate (Windows) and Apple Developer ID. External dependency. Add signing config to `src-tauri/tauri.conf.json` once cert is in hand. |
| D2  | Auto-updater               | High     | Blocked on D1 | Setup is documented in `docs/updater-setup.md`; plugin wiring, release manifest hosting, and UI prompt remain deferred.                                |
| D4  | Plugin system              | Low      | Not started   | Community manifest format. Data versioning groundwork already done in Sprint 2. Modules in `src/modules/registry.ts` are the starting point.           |

### Sprint 4 — Deferred

| ID  | Task                       | Priority | Status      | Notes                                                                                        |
| --- | -------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------- |
| B2  | Multi-model A/B comparison | Low      | Not started | "Dual fire" — same prompt to two agents, side-by-side diff with cost/token/duration metrics. The agent tray + worktree-per-conversation foundation makes this small. |

### Architectural Debt

- **Rust test coverage** — 50 Rust tests; several command modules still untested. Frontend store coverage is now solid (197 unit tests across most stores).
- **Store consolidation (residual)** — `historyStore` / `projectHistoryStore` / `promptStore` may have real overlap; needs product review before merging. `flightStore` / `orchestrationStore` split is justified (clean CRUD vs runtime boundary) — leave it unless the flight execution pipeline is being reworked.

### Known Gaps Not Yet Scheduled

- Inline file preview from terminal output
- Crash report upload (local viewer ships in D3; no remote sink yet)
- Per-tool-id ownership tracking for `cancel_pending_tools` in the in-process Rust path (today drains the whole `state.pending_*` maps; fine while only one session-with-pending-tools at a time, but not multi-session-safe)
- Mid-session MCP hot-swap — the sidecar protocol has no `set_mcp_servers`, so `enabledMcpServerIds` flips apply on the next session start
- A small "Resume" button for hydrated conversations that have a `resumeToken` but no live listeners — today resume is lazy (fires when the user sends), but a one-click Resume that doesn't require typing would be a nice polish
- Tabbed-rail v2: Files + Preview tabs and a drag-resize handle (v1 ships Plan / Diff / Inspector with a fixed 340 px width)
- Goals v2: pause/resume semantics that spawn a new conversation seeded from the goal checklist when the original conversation is closed; v3 brings in Codex's own `/goal` resume-token bridge once the app-server transport (A6) lands

## Critical Path to 1.0 Release

1. Acquire Windows + macOS signing certificates (D1 blocker)
2. Wire signing config + auto-updater (D1, D2)
3. Expand E2E coverage to full workspace session creation / flight launch / approval cycle
4. Ship

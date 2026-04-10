# PacketCode Roadmap

Last updated: 2026-04-09

This file replaces the prior `dev/REMAINING-WORK.md`, `dev/PROJECT-STATUS.md`, `dev/SPRINT-04-MISSION-WORKSPACE.md`, and `dev/ARCHITECTURE.md` planning docs. For architectural conventions, see `CLAUDE.md`.

Detailed strategic planning now lives under `dev/`. `ROADMAP.md` remains the top-level summary of release blockers, active product priorities, and known gaps.

## Status

Sprints 0–4 are shipped. All Sprint 4 feature work (Mission Workspace, SessionInspect, AgentChatPanel, TerminalPane decomposition, notification wiring, bundle splitting, crash reporting) is complete. Phase 3 distribution prep is underway: Apache 2.0 licensing and Playwright E2E infrastructure are in place.

Gates currently green: `pnpm lint`, `pnpm build`, `pnpm test` (197 unit), `pnpm e2e` (6 E2E), `cargo check`, `cargo test` (50).

## Remaining Work

### Active Product Priorities

| ID  | Task                                       | Priority | Status  | Notes                                                                                                                                                                          |
| --- | ------------------------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Swarm orchestration roles                  | High     | Planned | Add explicit `coordinator` / `builder` / `reviewer` / `scout` task roles on top of the existing flight/task orchestration model. See `dev/swarm-orchestration-plan.md`.        |
| P2  | File ownership and collision prevention    | High     | Planned | Add task-level owned paths and scheduler conflict checks so concurrent agents do not step on the same files. See `dev/swarm-orchestration-plan.md`.                            |
| P3  | PacketCode MCP server                      | High     | Planned | Evolve PacketCode from MCP config management to a true MCP provider exposing flights, tasks, memory, and reviews to external clients. See `dev/packetcode-mcp-server-plan.md`. |
| P4  | Workspace templates and lightweight editor | Medium   | Planned | Improve workspace packaging, scale, and file editing without turning PacketCode into a full editor fork. See `dev/workspace-editor-scale-plan.md`.                             |

### Strategy Notes

- **Voice** stays in backlog for now. Current decision: do not build partial voice features unless PacketCode is ready for a real desktop-wide workflow. See `dev/backlog.md`.
- **Local-first** remains the product stance. PacketCode should compete as a local-first orchestration tool, not a cloud-first product suite. See `dev/positioning-notes.md`.

### Phase 3 — Distribution

| ID  | Task                       | Priority | Status        | Notes                                                                                                                                                  |
| --- | -------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Code signing (Win + macOS) | Critical | Blocked       | Needs EV/OV certificate (Windows) and Apple Developer ID. External dependency. Add signing config to `src-tauri/tauri.conf.json` once cert is in hand. |
| D2  | Auto-updater               | High     | Blocked on D1 | Install `tauri-plugin-updater`, wire check-on-launch + manual check button in Tools view.                                                              |
| D4  | Plugin system              | Low      | Not started   | Community manifest format. Data versioning groundwork already done in Sprint 2. Modules in `src/modules/registry.ts` are the starting point.           |

### Sprint 4 — Deferred

| ID  | Task                       | Priority | Status      | Notes                                                                                        |
| --- | -------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------- |
| B2  | Multi-model A/B comparison | Low      | Not started | "Dual fire" — same prompt to two agents, side-by-side diff with cost/token/duration metrics. |

### Architectural Debt

- **Rust test coverage** — 50 Rust tests; several command modules still untested. Frontend store coverage is now solid (197 unit tests across most stores).
- **Store consolidation (residual)** — `historyStore` / `projectHistoryStore` / `promptStore` may have real overlap; needs product review before merging. `flightStore` / `orchestrationStore` split is justified (clean CRUD vs runtime boundary) — leave it unless the flight execution pipeline is being reworked.

### Known Gaps Not Yet Scheduled

- Session persistence / reconnection across app restarts
- Inline file preview from terminal output
- Crash report upload (local viewer ships in D3; no remote sink yet)

## Critical Path to 1.0 Release

1. Acquire Windows + macOS signing certificates (D1 blocker)
2. Wire signing config + auto-updater (D1, D2)
3. Expand E2E coverage to full session creation / flight launch / approval cycle
4. Ship

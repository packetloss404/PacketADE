# PacketADE Roadmap

Last updated: 2026-04-28

This file replaces the prior `dev/REMAINING-WORK.md`, `dev/PROJECT-STATUS.md`, `dev/SPRINT-04-MISSION-WORKSPACE.md`, and `dev/ARCHITECTURE.md` planning docs. For architectural conventions, see `CLAUDE.md`.

Detailed strategic planning now lives under `dev/`. `ROADMAP.md` remains the top-level summary of release blockers, active product priorities, and known gaps.

## Status

Sprints 0–4 are shipped. Mission/Flight Deck work, workspace panes, API-agent conversations, sidecar v2, crash reporting, dictation, cost analytics, and Playwright E2E infrastructure are in place. Phase 3 distribution prep remains the major release track.

Run the usual gates before release: `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm e2e`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path src-tauri/Cargo.toml`.

## Remaining Work

### Active Product Priorities

| ID  | Task                                       | Priority | Status  | Notes                                                                                                                                                                          |
| --- | ------------------------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Swarm orchestration escalation             | High     | Partial | Roles, owned paths, collision detection, coordination feed, and handoff logs are implemented; automatic reassignment remains deferred. See `dev/bridgemind/swarm-orchestration-plan.md`. |
| P2  | PacketADE MCP server transport             | High     | Deferred | Frontend provider config/resource/tool definitions exist; Rust transport and external-client serving are deferred. See `dev/mcp-provider-transport.md`. |
| P3  | Git review packet integration              | Medium   | Partial | Workspace GitDashboard exists; review packet and flight approval ties are not fully wired. See `dev/zen-workspace/features-git-workspace.md`. |
| P4  | Cost alerts                                | Medium   | Not started | Cost dashboard reads backend usage analytics; budget/alert workflows remain nice-to-have. See `dev/moat/cost-dashboard-plan.md`. |

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
3. Expand E2E coverage to full workspace session creation / flight launch / approval cycle
4. Ship

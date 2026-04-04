# Claude Handoff

## Mission

Implement the NextGen plan from `dev/nextgen/` safely and incrementally. The goal is to harden the control plane and then build the new product surfaces on top of it.

## Read This First

1. `dev/report/00-executive-summary.md`
2. `dev/report/07-debate-and-consensus.md`
3. `dev/report/08-prioritized-recommendations.md`
4. `dev/report/01-codebase-map.md`
5. `dev/nextgen/masterplan.md`

## Non-Negotiables

- Rust core becomes the only orchestration authority.
- TS stores and views become projection layers, not a second scheduler.
- `Flight` remains the canonical domain object.
- do not create a separate persisted `Mission` model.
- pause, cancel, stop, detach, approval, and review must be canonical runtime state.
- do not regress detached-session recovery or transcript replay.
- do not restore unsafe stage-all commit behavior.
- keep TS and Rust contracts aligned on every lifecycle change.

## Start Here

Touch these first:

- `src-tauri/src/core/orchestrator.rs`
- `src-tauri/src/commands/orchestration.rs`
- `src-tauri/src/core/pty.rs`
- `src-tauri/src/commands/pty.rs`
- `src/lib/tauri.ts`
- `src/stores/orchestrationStore.ts`
- `src/components/session/TerminalPane.tsx`
- `src/stores/flightStore.ts`
- `src-tauri/src/core/storage.rs`

## Execution Order

1. canonicalize orchestration lifecycle in Rust
2. make PTY stop and detach semantics atomic
3. promote approval into canonical runtime state
4. tighten persistence ownership and TS/Rust mappings
5. harden git safety flows
6. expand `Flight` for mission metadata and review packets
7. build Mission Workspace
8. rebuild dashboard into FlightDeck Overview
9. add OpenCode mission chat v1

## Guardrails

- prefer small vertical slices over big rewrites
- verify each slice with the smallest relevant tests plus `pnpm lint` and `pnpm build`
- keep desktop and TUI semantics aligned even if feature parity lags
- update doc assumptions if implementation realities change
- never bypass runtime APIs for convenience from the UI layer

## Open Questions To Resolve Explicitly

- should final successful execution land in `review`, `done`, or a split completion model?
- should pause always kill PTY processes, or should detached paused sessions exist?
- should backend persistence become the only durable source, with frontend storage as cache only?
- how much desktop/TUI parity is required during transition?

## Done Means

- no split-brain orchestration semantics
- PTY lifecycle matches task and flight state reliably
- approval is canonical and durable
- git flow is safer by default
- Mission Workspace and Overview sit on hardened runtime behavior

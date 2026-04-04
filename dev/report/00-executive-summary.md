# FlightDeck Review - Executive Summary

- Date: 2026-03-30
- Review swarm: 20 code review lanes, 20 senior AI agentic engineer lanes, 10 HTML5 report-design lanes
- Validation run: `pnpm lint`, `pnpm build`, `cargo test`
- Output set: this markdown pack plus `dev/report/index.html`

## Verdict

FlightDeck is a promising alpha with a strong product thesis, a useful session recovery story, and a credible provider-agnostic agent model. It is not yet ready for broad external usage.

The highest-risk gaps are not cosmetic. They are control-plane issues:

1. orchestration state and live PTY process state can drift apart
2. desktop and Rust core each implement their own scheduler/lifecycle logic
3. approval handling is only partially canonical
4. git actions are too easy to run unsafely in an autonomous-agent workspace
5. persistence is vulnerable to cross-store overwrite races

## Validation Snapshot

- `pnpm build`: passed
- `cargo test`: passed, 7 Rust tests, all in statusline parsing/helpers
- `pnpm lint`: failed
  - `src/agents/types.ts` - `no-control-regex`
  - `src/components/views/FlightDeckView.tsx` - memoization/dependency mismatch around `getAttentionFlights`

## Strongest Consensus Findings

### P0 - Fix before wider rollout

- PTY lifecycle is not owned cleanly by orchestration. `pauseFlight` and `cancelFlight` mutate store state but do not reliably stop live sessions in `src/stores/orchestrationStore.ts`.
- Desktop and backend orchestration already diverge. The desktop store and `src-tauri/src/core/orchestrator.rs` disagree on lifecycle semantics, especially around `review` vs `done`.
- Approval flow is incomplete. Approval detection lives in terminal UI logic, but it is not consistently promoted into canonical task/flight state.
- The in-app git flow is unsafe for an ADE. Toolbar commit stages everything, then commits with a prompt, and push/pull lack strong preflight checks.
- State persistence has a last-write-wins race. Multiple stores load and rewrite the same full persisted blob.

### P1 - High-leverage product gaps

- Planning UX cannot express core model power. `dependsOn` and milestone validation exist in the model, but the desktop planning/detail flows barely expose them.
- Session trust is weaker than it looks. Tabs can detach without stopping work, failed exits can look like success, and the exact launch prompt is not clearly auditable.
- Cost, token, and review evidence are underdeveloped. The data model has room for them, but the operator surfaces do not make them trustworthy yet.

### P2 - Important next-wave improvements

- Normalize contracts between TypeScript and Rust.
- Reduce frontend/store duplication and large monolithic files.
- Improve scalability for many flights, tasks, and panes.
- Turn the report/review surfaces into explicit evidence-backed decision points.

## Biggest Strengths

- The product abstraction is strong. Flights, milestones, tasks, attention queues, milestone gating, and session panes map to a real ADE workflow.
- Provider-agnostic agent support is real. The repo supports built-in agents plus a generic fallback.
- Session recovery is notably good. Startup reconciliation, transcript replay, and detached-session reattachment are differentiators.
- The Rust shared-core direction is right. Tauri and TUI already share important backend/domain pieces.

## Release Readiness

Current state: promising alpha / internal dogfood / design partner preview.

Not yet ready for broad external rollout because of:

- unsafe process-control semantics
- weak git safety rails
- thin automated test coverage
- incomplete approval/review wiring
- split orchestration ownership

## Recommended Order Of Operations

1. move orchestration ownership into one canonical runtime, preferably Rust core
2. make PTY/session lifecycle authoritative and atomic with task/flight state changes
3. harden approval and git flows for unattended agent work
4. expose dependency editing, milestone validation, and richer review evidence
5. add serious tests for orchestration, persistence, PTY lifecycle, and git safety

## Key Files To Watch First

- `src/stores/orchestrationStore.ts`
- `src/stores/flightStore.ts`
- `src/components/session/TerminalPane.tsx`
- `src/components/views/FlightDetailView.tsx`
- `src/components/views/FlightCreateWizard.tsx`
- `src-tauri/src/core/orchestrator.rs`
- `src-tauri/src/core/pty.rs`
- `src-tauri/src/core/storage.rs`
- `src-tauri/src/core/git.rs`
- `src/lib/tauri.ts`

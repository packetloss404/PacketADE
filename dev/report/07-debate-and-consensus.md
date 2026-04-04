# FlightDeck Review - Debate And Consensus

This section is the synthesized "all 40 in a room" record: where the code-review lanes and senior AI-agentic-engineer lanes converged, where they partly disagreed, and what decision the report recommends.

## Strong Consensus

### 1. One canonical orchestration engine is needed

- Agreement level: very high
- Why: both the desktop store and Rust core currently implement lifecycle logic.
- Evidence: `src/stores/orchestrationStore.ts`, `src-tauri/src/core/orchestrator.rs`
- Decision: make Rust core authoritative for scheduling and lifecycle state.

### 2. PTY lifecycle must become atomic with orchestration state

- Agreement level: very high
- Why: pause/cancel/detach semantics are not trustworthy enough today.
- Evidence: `src/stores/orchestrationStore.ts`, `src/components/session/TerminalPane.tsx`, `src-tauri/src/core/pty.rs`
- Decision: state transitions that imply stopping work must kill or explicitly detach PTYs in the same transaction path.

### 3. Approval handling is underwired

- Agreement level: very high
- Why: approval is detected in session UI and tabs, but not consistently elevated into canonical task/flight state.
- Evidence: `src/hooks/usePtyStateDetector.ts`, `src/components/session/TerminalPane.tsx`, `src/stores/orchestrationStore.ts`
- Decision: approval-needed must be a first-class runtime event and state transition.

### 4. Git UX needs real safety rails

- Agreement level: very high
- Why: stage-all commit plus prompt-driven flow is not safe enough for multi-agent work.
- Evidence: `src/components/layout/Toolbar.tsx`, `src-tauri/src/core/git.rs`
- Decision: require reviewed/scoped commit and stronger push/pull preflight.

### 5. Planning UI underuses the domain model

- Agreement level: high
- Why: dependencies and validation criteria exist in the model but not in the operator UX.
- Evidence: `src/types/flight.ts`, `src/components/views/FlightCreateWizard.tsx`, `src/components/views/FlightDetailView.tsx`
- Decision: expose dependency authoring and milestone validation before deeper AI-planning investments.

## Partial Consensus / Product Strategy Debates

### A. Keep both desktop and TUI vs reduce one surface

- Shared view: both surfaces are worth keeping
- Tension: feature parity is drifting
- Recommended decision: keep both, but unify runtime semantics and allow UI-level specialization.

### B. Arbitrary CLI spawning as a feature vs as a security liability

- One side: generic PTY spawning is central to a provider-agnostic ADE
- Other side: renderer-to-host execution surface is too broad
- Recommended decision: preserve generic execution, but add explicit trust boundaries, operator consent, and tighter default capabilities.

### C. Mirrored persistence for resilience vs one durable source of truth

- One side: browser fallback/local persistence helps resilience
- Other side: duplicated writes create race conditions and complexity
- Recommended decision: consolidate durable ownership in the backend, keep browser/local caches as projections only.

### D. `review` vs `done` as final state

- One side: human signoff should keep successful work in `review`
- Other side: the engine should mark successful runs `done`
- Recommended decision: separate `execution_complete` from `human_approved_complete`, then model `review` explicitly and consistently in both TS and Rust.

## Consensus Ranking Of Hotspots

1. `src/stores/orchestrationStore.ts`
2. `src/components/session/TerminalPane.tsx`
3. `src-tauri/src/core/orchestrator.rs`
4. `src-tauri/src/core/pty.rs`
5. `src/stores/flightStore.ts`
6. `src/components/views/FlightDetailView.tsx`
7. `src/components/views/FlightCreateWizard.tsx`
8. `src/lib/tauri.ts`
9. `src-tauri/src/core/storage.rs`
10. `src/components/layout/Toolbar.tsx`

## Final Synthesis

FlightDeck does not need a new product direction. It needs hardening and consolidation around the direction it already has.

The product thesis survived the debate.

The implementation ownership model did not.

# FlightDeck Review - Prioritized Recommendations

## P0 - Control Plane Hardening

### 1. Canonicalize orchestration in Rust core

- Why: duplicated desktop/backend schedulers are already diverging
- Files:
  - `src/stores/orchestrationStore.ts`
  - `src-tauri/src/core/orchestrator.rs`
  - `src/lib/tauri.ts`
- Outcome: one runtime truth for scheduling, approvals, lifecycle, and recovery

### 2. Make PTY control atomic with state transitions

- Why: paused/cancelled work can keep running
- Files:
  - `src/stores/orchestrationStore.ts`
  - `src/components/session/TerminalPane.tsx`
  - `src-tauri/src/core/pty.rs`
- Outcome: trustworthy operator controls

### 3. Turn approval into a first-class runtime event

- Why: current approval handling is too UI-local and too hardcoded
- Files:
  - `src/hooks/usePtyStateDetector.ts`
  - `src/components/session/TerminalPane.tsx`
  - `src/types/agent.ts`
- Outcome: human-in-the-loop controls become dependable across all agents

### 4. Rebuild git actions around review and safety

- Why: stage-all commit and thin push/pull are too risky
- Files:
  - `src/components/layout/Toolbar.tsx`
  - `src-tauri/src/core/git.rs`
- Outcome: safer ADE-grade source-control workflow

### 5. Add tests around orchestration, persistence, and PTY lifecycle

- Why: current coverage is too narrow for the risk surface
- Files:
  - `package.json`
  - `.github/workflows/ci.yml`
  - `src-tauri/src/commands/statusline/mod.rs`
- Outcome: safer refactoring velocity

## P1 - Product Fit Improvements

### 6. Expose dependency editing and milestone validation in the UI

- Why: the model is ahead of the UX
- Files:
  - `src/components/views/FlightCreateWizard.tsx`
  - `src/components/views/FlightDetailView.tsx`
  - `src/types/flight.ts`
- Outcome: better planning quality and more meaningful orchestration

### 7. Make session context auditable

- Why: users need to know what prompt, repo, branch, and task context a session really started with
- Files:
  - `src/stores/orchestrationStore.ts`
  - `src/components/session/TerminalPane.tsx`
  - `src/stores/layoutStore.ts`
- Outcome: higher operator trust

### 8. Add real review packets

- Why: review should be evidence-backed, not status-only
- Files:
  - `src/types/flight.ts`
  - `src/components/views/FlightDetailView.tsx`
  - `src/components/views/FlightDeckView.tsx`
- Outcome: better human signoff loops

### 9. Make repo/branch/worktree context first-class per flight/session

- Why: multi-flight and multi-repo execution need stronger isolation
- Files:
  - `src/types/flight.ts`
  - `src/components/layout/Toolbar.tsx`
  - `src/components/session/TerminalPane.tsx`
- Outcome: FlightDeck becomes more than a global terminal launcher

## P2 - Maintainability And Scale

### 10. Split large files and duplicated domains

- Primary targets:
  - `src/components/session/TerminalPane.tsx`
  - `src/components/views/FlightDetailView.tsx`
  - `src/components/views/FlightCreateWizard.tsx`
  - `src-tauri/src/tui/app.rs`
  - `src/lib/tauri.ts`

### 11. Normalize cross-layer contracts

- Why: TS/Rust DTO drift risk will grow with product complexity
- Files:
  - `src/types/flight.ts`
  - `src-tauri/src/core/flight.rs`
  - `src/lib/tauri.ts`

### 12. Optimize for many sessions and large histories

- Why: current session/grid/persistence model will strain under larger workloads
- Files:
  - `src/components/layout/PaneContainer.tsx`
  - `src/components/views/SessionsView.tsx`
  - `src-tauri/src/core/pty.rs`

## Suggested Delivery Sequence

### Milestone 1

- canonical orchestrator
- PTY lifecycle hardening
- approval state wiring
- git safety rail redesign

### Milestone 2

- planning UX for dependencies/validation
- review packet generation
- repo/branch/worktree per flight
- test suite expansion

### Milestone 3

- file/module refactors
- cross-layer contract cleanup
- scale/performance improvements
- collaboration-ready data model groundwork

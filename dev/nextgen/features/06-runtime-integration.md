# Runtime Integration

## Problem

Desktop orchestration and Rust orchestration already diverge. PTY lifecycle is not fully atomic with task and flight state.

## Scope

- make Rust core the single orchestration runtime
- move launch, tick, pause, cancel, review, approval, and recovery semantics into canonical runtime APIs
- make PTY lifecycle atomic with lifecycle transitions

## UX

- operators see trustworthy running, paused, approval-needed, and stopped states everywhere
- milestone gating and review behave the same across surfaces

## Technical Changes

- reduce `orchestrationStore` to projection and command dispatch
- formalize runtime commands and events for React and TUI
- centralize session registry and task-session binding

## Dependencies

- foundational; required by all other next-gen features

## Risks

- highest-complexity refactor in the roadmap
- temporary split-brain behavior during migration

## Acceptance Criteria

- there is one authoritative scheduler and lifecycle state machine
- pause, cancel, approval, and recovery behave consistently across restarts and surfaces
- session exit updates canonical runtime state first

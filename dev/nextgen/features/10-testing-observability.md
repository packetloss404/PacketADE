# Testing / Observability

## Problem

Coverage is too narrow for the current risk surface, and the runtime is not observable enough for confident autonomous workflow operations.

## Scope

- add tests for orchestration, PTY lifecycle, persistence, approvals, and git safety
- add structured diagnostics for lifecycle events and recovery
- add release gates for mission-critical scenarios

## UX

- clearer operator-visible diagnostics for failures and recovery
- stronger confidence in mission and session state

## Technical Changes

- expand frontend tests
- add Rust integration tests
- add TS/Rust contract tests
- emit structured runtime events and logs for core lifecycle paths

## Dependencies

- all other next-gen workstreams rely on this for safe rollout

## Risks

- PTY-heavy end-to-end tests can be flaky
- diagnostics can expose sensitive data if not curated carefully

## Acceptance Criteria

- CI covers orchestration, pause/cancel/recovery, approval, persistence migration, and git safety
- runtime emits actionable diagnostics for core lifecycle events
- release readiness is based on mission-critical workflows, not only build success

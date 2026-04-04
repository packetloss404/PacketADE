# Flight Domain Evolution

## Problem

The current `Flight` model is promising but underspecified for mission chat, review packets, explicit approval semantics, and repo/worktree context.

## Scope

- evolve `Flight`, `Milestone`, `Task`, and `TaskResult`
- add review and execution state clarity
- add repo, branch, and worktree context per flight
- add durable mission conversation metadata attached to `Flight`

## UX

- clearer lifecycle stages for planning, launch readiness, execution, review, and completion
- richer evidence visible at task and milestone level

## Technical Changes

- update TS and Rust contracts together
- add migration strategy and versioned state handling
- remove UI-only inferred lifecycle behavior where possible

## Dependencies

- `06-runtime-integration.md`
- `09-persistence-contracts.md`

## Risks

- migration complexity
- status explosion if the lifecycle becomes too granular

## Acceptance Criteria

- `Flight` remains canonical while supporting mission chat metadata
- review state is explicit rather than guessed
- contracts round-trip cleanly across TS, Rust, and persistence

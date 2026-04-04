# FlightDeck NextGen Master Plan

## Intent

FlightDeck evolves from a dashboard-first orchestration console into a chat-first Mission Workspace plus a FlightDeck Overview for orchestrated execution.

The core decision is simple: `Flight` remains the single evolving domain object. "Mission" is product language for how a flight is created, refined, launched, reviewed, and completed.

## Why This Change

The current codebase already has a strong orchestration thesis, but the strongest future surface is conversational planning plus trustworthy execution.

The review pack in `dev/report/` shows five recurring issues:

1. orchestration state and PTY state can drift
2. desktop and Rust both carry scheduler logic
3. approval handling is not canonical enough
4. git flows are too risky for agent work
5. persistence is vulnerable to last-write-wins races

NextGen keeps FlightDeck's strengths while fixing those control-plane weaknesses.

## Product Shape

### Mission Workspace

Primary surface for work authoring and operation.

- start from an objective in chat
- refine milestones, tasks, dependencies, and validation criteria
- inspect evidence, approvals, and review packets
- launch orchestrated work when ready

### FlightDeck Overview

Primary surface for supervision after launch.

- portfolio view of active flights
- attention queue for approvals, failures, review, and blocked work
- mission health, cost, and progress visibility
- deep links into mission workspace and live sessions

### Sessions / Inspect

Task and session drill-down surface.

- terminal view
- prompt and launch context
- transcript and evidence
- approval history
- exit reason and recovery state

## Goals

- make Mission Workspace the default way to create and refine a `Flight`
- preserve `Flight` as the canonical domain object across UI, runtime, and persistence
- move orchestration ownership into Rust core
- ship a scoped v1 mission chat experience using OpenCode only
- keep launched work on structured task runtimes with milestone gating and review loops
- improve operator trust through explicit runtime events, auditable prompts, and safer git controls

## Non-Goals

- no separate `Mission` persistence model
- no hosted auth, billing, or account system in v1
- no mission chat support for every runtime in v1
- no removal of provider-agnostic task execution
- no UI-only redesign before runtime hardening

## Architecture Principles

1. `Flight` is canonical.
2. Rust is the runtime authority.
3. chat plans, runtime executes.
4. Mission chat is OpenCode only in v1.
5. auth piggybacks on existing CLI and env setup in v1.
6. Overview is an operational control plane, not just a dashboard.
7. review and completion must be evidence-backed.
8. safety wins over autonomy.

## V1 Product Contract

- Mission Workspace is the default entry point.
- FlightDeck Overview is the default monitoring surface after launch.
- OpenCode powers mission chat.
- Claude Code, Codex, OpenCode, and generic runtimes can still execute structured tasks.
- provider keys are not stored by FlightDeck in v1.
- review packets and approval state are part of normal operation.

## Target Technical Direction

### Domain

Canonical entities remain:

- `Flight`
- `Milestone`
- `Task`
- `TaskResult`
- session metadata linked to tasks and flights

Expected additions:

- mission conversation metadata attached to `Flight`
- launch readiness state
- review packet summaries
- repo, branch, and worktree context per flight
- explicit distinction between execution complete and human-approved complete

### Runtime

Rust core should own:

- flight lifecycle transitions
- dependency resolution
- milestone gating
- approval-needed and approval-resolved events
- PTY lifecycle coordination
- durable persistence
- recovery and reconciliation

React and TUI should become projections over canonical runtime state.

## Delivery Phases

### Phase 0 - Alignment

- freeze v1 scope
- freeze terminology and domain rules
- publish this doc set

### Phase 1 - Control Plane Hardening

- canonicalize orchestration in Rust
- make PTY lifecycle atomic with state transitions
- promote approval into runtime events
- fix persistence ownership and patch flows
- harden git safety

### Phase 2 - Flight Model Expansion

- evolve `Flight` to support mission chat metadata
- add review packet structures
- normalize TS/Rust contracts and migrations

### Phase 3 - Mission Workspace V1

- unify create/detail/edit flows into one mission surface
- add mission chat powered by OpenCode
- allow plan drafting, refinement, and launch

### Phase 4 - FlightDeck Overview V1

- rebuild dashboard into supervision surface
- add review queue, blocked queue, approval queue, and mission health

### Phase 5 - Release Hardening

- expand tests
- harden migration and recovery
- polish review, git safety, and diagnostics

## Team Model

Planning assumption: each sprint is tackled by a team of 10.

Recommended standing workstreams:

- runtime core
- mission workspace
- overview and sessions
- safety, testing, and release

Suggested staffing per sprint:

- PM: 1
- Design: 1
- Frontend: 3
- Backend/Rust: 3
- Runtime/Integrations: 1
- QA/Release: 2

The exact split can vary by sprint, but Rust/runtime ownership must stay continuously staffed.

## Risks

- a visual redesign starts before runtime hardening finishes
- a second `Mission` object gets introduced by accident
- mission chat bypasses structured launch semantics
- overview becomes shallow again because evidence models are weak
- TS/Rust contracts drift during migration
- persistence migration breaks existing local state

## Mitigations

- require runtime and contract signoff before major UI changes
- make `Flight` invariants explicit in all specs
- force all mutations through canonical runtime APIs
- add migration and contract tests early
- keep recovery and transcript replay as protected behaviors

## Success Metrics

- most new work starts in Mission Workspace rather than legacy create/detail flows
- pause, cancel, review, and approval state remain consistent across restarts
- all launched tasks show auditable prompt, repo/worktree, and session linkage
- review packets exist for the majority of completed tasks
- operators can supervise many active flights without detached-session confusion

## Release Criteria

V1 is ready when:

- Mission Workspace is the primary authoring flow
- FlightDeck Overview is the primary supervision flow
- Rust is the only orchestration authority
- approval and review are canonical and durable
- migration from current local state is proven
- git safety is materially better than the current toolbar flow

## Recommended Execution Order

1. harden runtime semantics
2. normalize contracts and persistence
3. evolve `Flight` for mission metadata
4. build Mission Workspace
5. build FlightDeck Overview
6. harden testing, diagnostics, and release flow

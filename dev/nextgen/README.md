# FlightDeck NextGen

## Purpose

This directory is the execution plan for the next-generation FlightDeck product direction.

The product shift is:

- from dashboard-first to chat-first
- from split orchestration ownership to Rust-core runtime authority
- from separate planning/detail surfaces to a unified Mission Workspace
- from a generic dashboard to a true FlightDeck Overview for supervision

`Flight` remains the canonical domain object. "Mission" is the user-facing workflow and surface model, not a second data model.

## Read Order

Start here:

1. `dev/report/00-executive-summary.md`
2. `dev/report/07-debate-and-consensus.md`
3. `dev/report/08-prioritized-recommendations.md`
4. `dev/report/01-codebase-map.md`

Then execute this pack in order:

1. `dev/nextgen/masterplan.md`
2. `dev/nextgen/features/05-flight-domain-evolution.md`
3. `dev/nextgen/features/06-runtime-integration.md`
4. `dev/nextgen/features/09-persistence-contracts.md`
5. `dev/nextgen/features/07-review-approval-loops.md`
6. `dev/nextgen/features/08-git-safety.md`
7. `dev/nextgen/features/01-mission-workspace.md`
8. `dev/nextgen/features/02-flightdeck-overview.md`
9. `dev/nextgen/features/03-sessions-inspect.md`
10. `dev/nextgen/features/04-agents-providers.md`
11. `dev/nextgen/features/10-testing-observability.md`
12. `dev/nextgen/sprints/01-control-plane-hardening-foundation.md`
13. `dev/nextgen/sprints/02-mission-workspace-v1.md`
14. `dev/nextgen/sprints/03-overview-and-review-surface.md`
15. `dev/nextgen/sprints/04-opencode-mission-chat-v1.md`
16. `dev/nextgen/claude-handoff.md`

## Non-Negotiables

- Rust core becomes the only orchestration authority.
- `Flight` stays canonical; do not create a parallel `Mission` domain object.
- v1 mission chat runtime is OpenCode only.
- v1 auth piggybacks on existing CLI and environment auth.
- launched work remains structured task execution, not freeform mission chat execution.
- approval, pause, cancel, detach, and review must become canonical runtime state.
- git flows must become safer, never more permissive.

## Deliverables In This Folder

- `masterplan.md` - product and architecture plan
- `features/` - feature-level specs
- `sprints/` - implementation plan split for teams of 10
- `claude-handoff.md` - execution guardrails for Claude takeover

## Execution Style

- deliver in small vertical slices
- prefer adapters and migrations over big-bang rewrites
- keep desktop and TUI runtime semantics aligned
- verify every major slice with lint, build, and relevant Rust tests

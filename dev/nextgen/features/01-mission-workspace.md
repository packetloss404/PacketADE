# Mission Workspace

## Problem

Flight creation and flight detail are split today, while the data model already wants a unified planning and execution workspace.

## Scope

- merge create, edit, and detail into one mission surface
- support objective, milestones, tasks, dependencies, validation criteria, and agent assignment
- surface launch readiness, review, and runtime context in one place

## UX

- chat-first center panel
- structured flight plan panel bound to the current `Flight`
- evidence and session context panel for review and intervention

## Technical Changes

- replace the role of `FlightCreateWizard` and much of `FlightDetailView`
- add mission-oriented view state without creating a new domain object
- route all mutations through canonical runtime and persistence paths

## Dependencies

- `05-flight-domain-evolution.md`
- `06-runtime-integration.md`
- `09-persistence-contracts.md`

## Risks

- overloading one screen with too many jobs
- leaking "Mission" terminology into domain contracts

## Acceptance Criteria

- users can create, refine, launch, pause, review, and resume a flight from one workspace
- dependencies and validation criteria are editable before launch
- runtime status and approvals are visible without leaving the workspace

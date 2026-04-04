# Sprint 2 - Mission Workspace V1

## Goal

Ship the unified Mission Workspace as the primary authoring and execution context while keeping `Flight` canonical.

## Scope

- merge planning and detail flows into one workspace
- expose milestones, tasks, dependencies, validation criteria, and launch readiness
- show auditable session and runtime context inside the workspace

## Team Of 10 Split

1. Information architecture and UX shell - 2 people
2. Planning authoring and structured editing - 2 people
3. Execution and evidence panel - 2 people
4. View-model and mutation-path cleanup - 2 people
5. QA and migration polish - 2 people

## Dependencies

- Sprint 1 complete

## Definition Of Done

- users can create, refine, and launch a flight from one workspace
- dependencies and validation criteria are visible and editable
- mission terminology stays in the UI layer, not the canonical domain layer

## Risks

- overly dense screen design
- accidental leakage of new terminology into persistence and contracts

## Demo Outcome

- create a mission, refine its plan, launch it, and inspect runtime evidence without leaving the workspace

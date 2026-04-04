# Review / Approval Loops

## Problem

Approval is too UI-local and review is still too status-driven. Human-in-the-loop control needs stronger evidence and canonical semantics.

## Scope

- make approval-needed a first-class runtime event and persisted state
- add review packets at task, milestone, and mission level
- support approve, reject, request changes, and override-with-reason flows

## UX

- dedicated review queue
- evidence-backed review packets
- visible audit trail of approval and override decisions

## Technical Changes

- persist approval events and review outcomes
- generate structured review packets from task results, git evidence, and validation results

## Dependencies

- `06-runtime-integration.md`
- `08-git-safety.md`
- `09-persistence-contracts.md`

## Risks

- weak evidence if result capture is thin
- too much gating can create friction if defaults are heavy-handed

## Acceptance Criteria

- approval-needed is visible in mission workspace, overview, and inspect surfaces
- review packets contain evidence, not only labels
- operators can approve, reject, or request follow-up with durable audit history

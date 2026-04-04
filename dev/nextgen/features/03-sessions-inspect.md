# Sessions / Inspect

## Problem

Sessions are powerful but still too opaque. Operators need to know what launched, where it launched, what it changed, and whether it really stopped.

## Scope

- durable inspect surface for each session
- show launch prompt, repo/worktree, branch, agent, model, approvals, transcript, and exit reason
- make attach, detach, and recovery explicit

## UX

- terminal plus inspect panel
- tabs for context, transcript, changes, approvals, and result
- detached-session banners with recovery actions

## Technical Changes

- promote session metadata beyond pane-local state
- persist prompt provenance and lifecycle events
- split `TerminalPane` into smaller runtime and presentation units

## Dependencies

- `06-runtime-integration.md`
- `09-persistence-contracts.md`

## Risks

- transcript volume and storage cost
- secret-bearing context appearing in inspect surfaces

## Acceptance Criteria

- every session has auditable launch context and exit state
- detached live sessions are visible and attachable
- approval actions are visible after the fact

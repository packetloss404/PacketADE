# Git Safety

## Problem

Current git flows are too risky for agent-driven development work, especially around commit scope, push safety, and repo/worktree ambiguity.

## Scope

- replace stage-all behavior with review-first flows
- add preflight checks for branch state, staged files, upstream status, and protected branches
- make repo, branch, and worktree context visible per flight and session

## UX

- reviewed commit panel
- explicit file scope and diff summary before commit
- structured push and pull preflight warnings

## Technical Changes

- move git policy deeper into Rust core with structured responses
- stop treating raw git status strings as the only contract

## Dependencies

- `05-flight-domain-evolution.md`
- `07-review-approval-loops.md`

## Risks

- git edge cases across worktrees and submodules
- over-restrictive defaults frustrating experienced users

## Acceptance Criteria

- commit no longer stages everything by default
- operators can review exact scope before commit and push
- repo and worktree context is visible on each flight and session

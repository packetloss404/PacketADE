# FlightDeck Overview

## Problem

The current dashboard is useful, but it is still too shallow to serve as real mission control.

## Scope

- redesign overview around attention, health, progress, and evidence
- surface approvals, failures, blocked work, detached sessions, and review gates
- support filtering by status, repo, priority, and runtime

## UX

- summary strip for active missions, approvals, failures, and spend
- attention queue ordered by urgency
- mission cards with progress, health, and next action

## Technical Changes

- add derived overview projections from canonical runtime state
- stop relying on ad hoc store-local status logic

## Dependencies

- `06-runtime-integration.md`
- `07-review-approval-loops.md`
- `10-testing-observability.md`

## Risks

- aggregation can drift from real runtime state
- performance can degrade under many live sessions

## Acceptance Criteria

- overview accurately highlights approvals, failures, review, and detached sessions
- counts and mission status match canonical runtime state
- operators can move directly from overview into the right mission or session context

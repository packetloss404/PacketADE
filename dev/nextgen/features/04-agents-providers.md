# Agents & Providers

## Problem

FlightDeck is provider-agnostic in principle, but the current agent model is still too thin for strong operator trust and task routing.

## Scope

- evolve agent config into clearer runtime and provider catalog behavior
- show install state, capabilities, default models, and approval behavior
- keep v1 mission chat runtime scoped to OpenCode only

## UX

- clearer agent catalog with built-in, generic, and experimental labeling
- better per-task assignment guidance
- explicit separation between mission chat runtime and task runtimes

## Technical Changes

- expand metadata around capabilities and launch defaults
- keep provider identity, CLI adapter, and task runtime concerns separate

## Dependencies

- `05-flight-domain-evolution.md`
- `06-runtime-integration.md`

## Risks

- stale capability metadata
- generic runtimes remaining too permissive without guidance

## Acceptance Criteria

- operators can tell which runtimes are installed, supported, and suitable for each task
- per-task runtime and model selection persists and launches correctly
- mission chat runtime remains OpenCode-only in v1

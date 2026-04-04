# Persistence / Contracts

## Problem

Multiple frontend stores rewrite overlapping persisted state. TS and Rust mappings will become more fragile as the domain grows.

## Scope

- make backend persistence the durable source of truth
- move frontend persistence toward projection and cache behavior
- add stronger TS/Rust contract discipline and migration strategy

## UX

- more trustworthy recovery after restart
- clearer hydration and migration failures when they happen

## Technical Changes

- replace full-blob rewrites with narrower patch-oriented persistence flows where possible
- add contract tests for TS/Rust round trips
- separate runtime/session durability from purely local UI layout concerns

## Dependencies

- `05-flight-domain-evolution.md`
- `06-runtime-integration.md`

## Risks

- migration bugs on existing local state
- temporary dual-write complexity during transition

## Acceptance Criteria

- frontend no longer performs overlapping full-state rewrites for shared persisted blobs
- TS and Rust contracts round-trip without field drift
- restart recovery is consistent across flights, sessions, and settings

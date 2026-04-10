# PacketCode MCP Server Plan

Last updated: 2026-04-09

## Goal

Evolve PacketCode from an MCP configuration manager into a real MCP provider that exposes PacketCode context and workflows to external AI clients.

## Current State

PacketCode currently supports MCP in one narrow sense:

- reading MCP server config from `~/.claude/settings.json`
- reading project MCP config from `.mcp.json`
- writing and deleting those config entries

Relevant code:

- `src-tauri/src/commands/mcp.rs`

That is useful, but it does not make PacketCode itself part of the MCP network.

## Product Outcome

The target outcome is:

- Claude Code, Codex, Cursor, or other MCP clients can ask PacketCode for project state
- PacketCode becomes the source of truth for flights, issues, memory, and reviews
- external agents can participate in PacketCode workflows instead of PacketCode only launching local sessions

## Why This Matters

This is the cleanest response to BridgeMind's `BridgeMCP` claim.

PacketCode already has rich local state that external agents would benefit from:

- flights
- milestones and tasks
- review queue
- learned memory and context
- workspaces
- Git and deploy context

The missing layer is protocol exposure.

## Proposed Capability Surface

## Resources

Expose read-oriented PacketCode state first:

- active project metadata
- flights
- milestones and tasks
- review packets
- issue board state
- memory summaries and learned patterns
- active workspaces

## Tools

Expose minimal workflow tools second:

- get active flight
- list runnable tasks
- read task details
- append task handoff
- request review
- mark task blocked
- read PacketCode memory context
- list workspaces

## Optional later tools

- claim task ownership
- reserve file paths
- create flight from spec
- create workspace from template

## Rollout Plan

## Phase 1: Local read-only server

Deliver a local MCP server with read-only access to PacketCode state.

Objectives:

- prove the shape of the API
- keep risk low
- make PacketCode state useful to external agents quickly

## Phase 2: Safe workflow tools

Add low-risk write operations that align with existing PacketCode UI flows.

Examples:

- append handoff
- request review
- mark task blocked

## Phase 3: Ownership-aware workflow tools

After file ownership exists in the core model, add MCP tools that can safely participate in swarm coordination.

Examples:

- claim task
- reserve file paths
- release reservation

## Security Model

PacketCode should not copy a cloud-first default here.

Recommended defaults:

- local-only transport by default
- project-scoped access
- explicit enablement in settings
- explicit per-tool permissions where writes are possible
- clear audit trail in PacketCode activity/history UI

## Architecture Notes

Likely implementation shape:

- new backend module under `src-tauri/src/commands/` or adjacent MCP runtime module
- tool handlers map to existing stores and persisted backend state
- PacketCode stays the local source of truth
- frontend settings UI controls enablement, visibility, and allowed scopes

## Good First Slice

The smallest useful first release is:

1. `packetcode.get_active_project`
2. `packetcode.list_flights`
3. `packetcode.get_flight`
4. `packetcode.list_tasks`
5. `packetcode.get_memory_context`

That already makes PacketCode materially useful as an MCP provider.

## Open Questions

- should PacketCode expose one MCP server per project or one process with project-scoped resources?
- should review packets be modeled as tools, resources, or both?
- how much state should be writable before file ownership and task claiming exist?

## Success Criteria

- an external MCP client can consume PacketCode planning context without scraping local files
- PacketCode state becomes reusable across agent tools
- PacketCode gains a credible answer to the "shared context layer" category without abandoning local-first principles

# PacketADE MCP Server Plan

Last updated: 2026-06-15

Status: **strategy/reference**. The implementation owner for deferred transport
work is [`../archive/mcp-provider-transport.md`](../archive/mcp-provider-transport.md); keep
this file for product context and BridgeMind positioning.

> **2026-07-28 product update:** the transport described here shipped under N3.
> The approved, non-primary BridgeMCP response is now the local-first Hub
> expansion in
> [`local-first-mcp-hub-loop.md`](./local-first-mcp-hub-loop.md). Do not use
> this historical plan to recreate shipped transport work.

## Implementation Status — 2026-06-15

The Phase-1 **frontend store is live**: tool/resource definitions ship today in
[`src/stores/mcpProviderStore.ts`](../../src/stores/mcpProviderStore.ts)
(`PROVIDER_TOOLS`), which is the canonical source of truth for the exposed tool
names below. Only the **backend transport is deferred** — see
[`../archive/mcp-provider-transport.md`](../archive/mcp-provider-transport.md). The "Frontend
only" / "Frontend definitions done" rows therefore mean *implemented but not yet
wired to a server*, not unstarted.

| Item | Status | Notes |
|------|--------|-------|
| MCP config management | ✅ Done | mcp.rs reads/writes/deletes server configs |
| PacketADE as MCP provider | ⚠️ Phase 1 done | Frontend types/store/settings UI (`mcpProviderStore.ts`) |
| MCP resources (flights, tasks, memory) | ⚠️ Frontend definitions done | Defined in `PROVIDER_TOOLS` store; transport deferred to mcp-provider-transport.md |
| MCP tools (`get_active_flight`, etc.) | ⚠️ Frontend definitions done | Live names in `mcpProviderStore.ts`; transport deferred |
| Phase 1: Local read-only server | ⚠️ Frontend live, transport deferred | Store shipped; server transport in mcp-provider-transport.md |
| Phase 2: Workflow tools | ❌ Deferred | — |
| Phase 3: Ownership-aware tools | ❌ Deferred | — |

## Goal

Evolve PacketADE from an MCP configuration manager into a real MCP provider that exposes PacketADE context and workflows to external AI clients.

## Current State

PacketADE currently supports MCP in one narrow sense:

- reading MCP server config from `~/.claude/settings.json`
- reading project MCP config from `.mcp.json`
- writing and deleting those config entries

Relevant code:

- `src-tauri/src/commands/mcp.rs`

That is useful, but it does not make PacketADE itself part of the MCP network.

## Product Outcome

The target outcome is:

- Claude Code, Codex, Cursor, or other MCP clients can ask PacketADE for project state
- PacketADE becomes the source of truth for flights, issues, memory, and reviews
- external agents can participate in PacketADE workflows instead of PacketADE only launching local sessions

## Why This Matters

This is the cleanest response to BridgeMind's `BridgeMCP` claim.

PacketADE already has rich local state that external agents would benefit from:

- flights
- milestones and tasks
- review queue
- learned memory and context
- workspaces
- Git and deploy context

The missing layer is protocol exposure.

## Proposed Capability Surface

## Resources

Expose read-oriented PacketADE state first:

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
- read PacketADE memory context
- list workspaces

## Optional later tools

- claim task ownership
- reserve file paths
- create flight from spec
- create workspace from template

## Rollout Plan

## Phase 1: Local read-only server

Deliver a local MCP server with read-only access to PacketADE state.

Objectives:

- prove the shape of the API
- keep risk low
- make PacketADE state useful to external agents quickly

## Phase 2: Safe workflow tools

Add low-risk write operations that align with existing PacketADE UI flows.

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

PacketADE should not copy a cloud-first default here.

Recommended defaults:

- local-only transport by default
- project-scoped access
- explicit enablement in settings
- explicit per-tool permissions where writes are possible
- clear audit trail in PacketADE activity/history UI

## Architecture Notes

Likely implementation shape:

- new backend module under `src-tauri/src/commands/` or adjacent MCP runtime module
- tool handlers map to existing stores and persisted backend state
- PacketADE stays the local source of truth
- frontend settings UI controls enablement, visibility, and allowed scopes

## Good First Slice

The smallest useful first release maps to the read-oriented tools already
defined in `PROVIDER_TOOLS` (`src/stores/mcpProviderStore.ts`):

1. `get_active_flight` (renamed from the earlier `get_active_mission`)
2. `list_runnable_tasks`
3. `read_task_details`
4. `read_memory_context`
5. `list_workspaces`

These names are exact as shipped in the live frontend store. That already makes
PacketADE materially useful as an MCP provider once the transport
([`../archive/mcp-provider-transport.md`](../archive/mcp-provider-transport.md)) lands.

## Open Questions

- should PacketADE expose one MCP server per project or one process with project-scoped resources?
- should review packets be modeled as tools, resources, or both?
- how much state should be writable before file ownership and task claiming exist?

## Success Criteria

- an external MCP client can consume PacketADE planning context without scraping local files
- PacketADE state becomes reusable across agent tools
- PacketADE gains a credible answer to the "shared context layer" category without abandoning local-first principles

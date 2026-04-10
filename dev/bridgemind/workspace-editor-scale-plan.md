# Workspace, Editor, and Scale Plan

Last updated: 2026-04-09

## Context

> This plan complements `dev/zen-workspace/workspace-project-model-plan.md`. Workspace templates, pane UX, and editor features in this doc build on top of the workspace-per-project model. Complete Phase 1 of that plan before starting work here.

## Goal

Strengthen PacketCode's workspace product so it feels purpose-built for multi-agent execution, not just a generic grid of terminals.

This plan covers the practical gap areas surfaced by the BridgeMind comparison:

- clearer workspace packaging and presets
- better scaling for multi-agent layouts
- a lightweight editor surface that complements terminals

## Current State

PacketCode already has:

- workspace creation
- multi-agent grid layouts
- a workspace sidebar
- keep-terminals-alive behavior
- a file explorer

Relevant code:

- `src/types/workspace.ts`
- `src/lib/gridLayout.ts`
- `src/stores/workspaceStore.ts`
- `src/components/workspace/WorkspaceCreationModal.tsx`
- `src/components/views/WorkspaceView.tsx`
- `src/components/explorer/FileExplorer.tsx`

This is a strong base. The missing piece is a more intentional workspace UX.

## Problem Statement

Current workspaces are functional, but they are still missing several things users expect once multi-agent work becomes serious:

- named setup patterns for common team shapes
- faster launch flows for preconfigured work
- a simple file editing surface next to terminals
- stronger visibility into what each pane is for

## Workstream 1: Workspace Templates

## Goal

Make workspace creation much faster for repeatable workflows.

## Proposed templates

- `solo` — one primary agent plus one plain terminal
- `duo` — two builders side-by-side
- `review-trio` — builder, reviewer, terminal
- `research-trio` — scout, builder, reviewer
- `swarm` — four or more role-oriented panes

## Product behavior

- users can pick a template instead of manually selecting every slot
- template names communicate intent, not just grid shape
- templates prefill recommended agent mix and profile defaults

## Workstream 2: Higher-Density Layout Options

## Goal

Support bigger multi-agent sessions without making the UI feel improvised.

## Proposed additions

- explicit named density presets in the creation flow
- small, medium, large layout modes
- optional compact pane chrome for dense sessions
- role labels on panes so users can scan the grid quickly

## Notes

`computeGridLayout()` already supports generic layouts. The main work here is productizing density and clarity.

## Workstream 3: Lightweight Editor Pane

## Goal

Close the gap between file explorer and terminal without turning PacketCode into a full editor fork.

## Proposed first release

- open file from explorer into an editor pane
- edit and save text files
- quick open by path
- open file from review packet or diff context

## Important constraint

Keep this intentionally small.

The target is:

- read
- edit
- save
- jump to file

The target is not:

- full IDE parity
- language server integration
- a complex plugin system

## Workstream 4: Better Workspace Context

## Goal

Make each pane's purpose obvious.

## Proposed additions

- pane purpose labels
- optional task binding for a pane
- role badge in pane headers
- visible current task or flight context

This makes dense workspaces much easier to supervise.

## Suggested Delivery Order

1. templates
2. role-aware pane labels
3. lightweight editor pane
4. dense-layout polish

## Suggested UI Entry Points

- `WorkspaceCreationModal.tsx`
- `WorkspaceView.tsx`
- `WorkspaceGrid.tsx`
- `WorkspacePane.tsx`
- `FileExplorer.tsx`

## Success Criteria

- users can launch a useful multi-agent workspace in one or two decisions
- pane purpose is obvious at a glance
- common file edits no longer require leaving PacketCode or relying entirely on shell editors
- larger workspace layouts remain understandable under real use

## Non-Goals

- replacing the main session architecture
- building a full editor competitor to Cursor or VS Code
- adding workspace complexity without role clarity

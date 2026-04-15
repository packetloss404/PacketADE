# Workspace Project Model Plan

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| Phase 1: Project picker in WorkspaceCreationModal | ✅ Done | Project picker integrated in workspace creation |
| Phase 2: setActiveWorkspace→project context | ✅ Done | Workspace activation syncs project context |
| Phase 3: PaneConfig.projectPath | ✅ Done | Field enforced at pane startup |
| Phase 4: Workspace-scoped git/file context | ✅ Done | — |
| WorkspaceSidebar reverse binding | ✅ Done | Sets project on workspace click |

> Research date: 2026-04-09

## Context

> This plan is the foundation for `dev/bridgemind/workspace-editor-scale-plan.md`. Complete Phase 1 of this plan (project picker in workspace creation) before starting the workspace UX workstream there.

## Goal

Make each PacketCode workspace own a separate project, with its own terminals, file context, and git context.

This plan is driven partly by the Zen Workspace comparison, but it intentionally goes further than Zen's current global project model.

## Desired User Experience

1. create a workspace for project A
2. create a different workspace for project B
3. each workspace launches and keeps its own terminals
4. switching workspaces also switches the active project context
5. explorer, git, prompt, and agent actions resolve against the active workspace's project

## Current PacketCode State

Good news:

- `Workspace.projectPath` already exists in `src/types/workspace.ts`
- `workspaceStore.createWorkspace()` already accepts and stores `projectPath`

Current blockers:

- `layoutStore.ts` still owns a single global `projectPath`
- `PaneConfig` has no `projectPath`
- `layoutStore.addPane()` accepts `projectPath` in its options type but does not store it
- `WorkspaceCreationModal.tsx` creates a workspace from the current global project rather than making project selection a first-class part of workspace creation
- `WorkspaceSidebar.tsx` does not bind workspace activation to project activation

## Recommended Architecture Direction

The active workspace should become the source of truth for project context.

That means:

- global `layoutStore.projectPath` should stop being the primary project authority
- panes and workspace launches should inherit project context from their workspace
- workspace activation should synchronize the rest of the UI to the workspace's project

## Proposed Phases

## Phase 1: Make project selection explicit in workspace creation

Changes:

- add project picker to `WorkspaceCreationModal.tsx`
- default to the current project, but allow choosing another recent/scanned project
- display selected project path in the creation summary

Outcome:

- every new workspace is intentionally tied to a project, not accidentally tied to the current global folder

## Phase 2: Bind workspace activation to project activation

Changes:

- when `setActiveWorkspace()` is called, update the effective active project context from `workspace.projectPath`
- synchronize explorer root and project UI from the active workspace
- make the workspace header and cards display their project name or path

Outcome:

- changing workspaces changes project context automatically

## Phase 3: Add project context to pane state

Changes:

- extend `PaneConfig` with `projectPath`
- make `layoutStore.addPane()` persist `projectPath`
- ensure pane/session startup uses the pane's project path instead of assuming one global path

Outcome:

- terminals become truly workspace-scoped rather than only visually grouped

## Phase 4: Make workspace-scoped git and file context first-class

Changes:

- git queries resolve from active workspace project
- file explorer resolves from active workspace project
- prompt targeting can resolve to active workspace or selected workspace pane

Outcome:

- the workspace becomes the operational container for a project

## Suggested Data Model Changes

Candidate additions:

- `PaneConfig.projectPath: string`
- optional `Workspace.lastOpenedAt`
- optional `Workspace.displayProjectName`

These changes are small and align with the current model instead of replacing it.

## UI Changes

Recommended updates:

- `WorkspaceCreationModal.tsx`
  - add project picker
- `WorkspaceView.tsx`
  - show project label on workspace cards and active header
- `WorkspaceSidebar.tsx`
  - tie workspace selection to project context
  - reduce duplication between Projects and Workspaces sections over time

## Important Product Decision

If workspaces become the main project container, the Projects list should become secondary.

Good options:

1. keep Projects as a recent-project source used when creating a workspace
2. keep Projects as a quick-jump list that opens or creates a workspace for that project

Bad option:

- maintain two separate competing notions of "active project" and "active workspace"

## Recommended Delivery Order

1. project picker in workspace creation
2. workspace activation updates effective project context
3. pane-level project path support
4. workspace-scoped git and prompt UX

## Success Criteria

- each workspace can point at a different project path
- terminals in a workspace stay attached to that workspace's project
- switching workspaces switches project context cleanly
- users no longer need to think about a separate global project when working inside the workspace view

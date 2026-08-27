# Zen Feature Notes — Project-Centric Workspaces

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| Workspace.projectPath | ✅ Done | Field exists and used in workspace creation |
| Project picker in creation | ✅ Done | In WorkspaceCreationModal |
| Workspace activation→project switch | ✅ Done | layoutStore sync |
| Projects list as secondary | ✅ Done | Sidebar groups by project |

> Research date: 2026-04-09
> Source repo: [riftzen-bit/zen-workspace-ide](https://github.com/riftzen-bit/zen-workspace-ide)

## What Zen Has

Zen has a dedicated projects surface:

- `src/renderer/src/components/projects/ProjectList.tsx`
- `src/renderer/src/store/useProjectStore.ts`

Observed features:

- add project by directory
- pinned projects
- recent projects
- rename project
- remove project
- activate project

Project activation updates the active workspace directory and file tree.

## What PacketBench Has Today

PacketBench already has several relevant pieces:

- `src/stores/projectHistoryStore.ts` for recent and scanned projects
- `src/components/workspace/WorkspaceSidebar.tsx` for projects and workspaces UI
- `src/types/workspace.ts` with `projectPath` on every workspace

This means PacketBench is already closer to project-centric workspaces than Zen in one important way: the workspace type itself already owns a project path.

## Current PacketBench Constraint

Even though `Workspace.projectPath` exists, project context still behaves globally in several places:

- `layoutStore.ts` stores one global `projectPath`
- `WorkspaceCreationModal.tsx` uses the current global project to create a workspace
- `WorkspaceSidebar.tsx` treats Projects and Workspaces as separate peer lists
- pane state itself does not retain project context

## Why The User Direction Is Correct

The desired direction is:

- each PacketBench workspace should map to one project
- each workspace should own its own terminals
- switching workspaces should switch project context automatically

That direction is better than Zen's current model because it matches PacketBench's existing workspace domain instead of introducing a second parallel project system.

## Practical Implication

PacketBench should not stop at adding a nicer project list.

PacketBench should make workspaces the primary project container.

Projects then become:

- either lightweight records used when creating a workspace
- or simply the path owned by a workspace

## Recommendation

Treat project selection as part of workspace creation and workspace activation.

The active workspace should determine:

- project path
- explorer root
- git context
- workspace panes and terminals
- prompt targeting where relevant

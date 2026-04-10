# Zen Workspace vs PacketCode — Gap Analysis

> Research date: 2026-04-09
> Source repo: [riftzen-bit/zen-workspace-ide](https://github.com/riftzen-bit/zen-workspace-ide)

## Scope

This comparison focuses on three Zen Workspace capabilities that matter most for PacketCode right now:

1. richer git workspace UX
2. prompt library UX
3. project-centric workspaces

This is not a broad product comparison. It is a targeted comparison against PacketCode's current workspace direction.

## Gap Summary

| Gap                                            | Priority | Effort       | Notes                                                                                                                                                  |
| ---------------------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace-scoped git dashboard and diff editor | High     | Medium       | Strong practical gap. PacketCode has git operations and GitHub integration, but not a workspace-native git review surface.                             |
| Prompt library workflow                        | Medium   | Small-Medium | PacketCode already has prompt templates, so this is a workflow gap rather than a storage gap.                                                          |
| Workspace-as-project container                 | High     | Medium-High  | The most important architectural direction. PacketCode already stores `Workspace.projectPath`, but the runtime still treats project context as global. |

## 1. Git Workspace Surface

Zen has:

- `GitDashboard.tsx`
- `GitDiffEditor.tsx`

Zen behavior includes:

- staged and unstaged file lists
- stage and unstage actions
- branch display
- diff view
- AI-generated commit messages
- in-app commit flow

PacketCode has:

- git commands and safety wrappers in `src/lib/tauri.ts`
- GitHub integration
- review and approval concepts elsewhere in the product

PacketCode does not currently appear to have:

- an embedded diff editor
- a file-level git workspace panel

Assessment:

- this is a real UX gap
- PacketCode can make it more useful than Zen by tying diffs to task review and approvals

## 2. Prompt Library

Zen has a real prompt library workflow:

- built-in presets
- custom prompts
- search
- send to chat
- send to terminal

PacketCode overlap:

- `promptStore.ts`
- template management in `ToolsView.tsx`
- template picker in `WorkspaceCreationModal.tsx`

Assessment:

- PacketCode already has the underlying storage model
- the gap is live usage ergonomics, not prompt persistence

## 3. Project-Centric Workspaces

Zen has:

- a project list
- pinned and recent projects
- project activation tied to the active working directory

PacketCode has:

- project history and scanned projects in `projectHistoryStore.ts`
- a projects section in `WorkspaceSidebar.tsx`
- `Workspace.projectPath` in the workspace model

PacketCode constraint:

- project context still behaves globally via `layoutStore.projectPath`
- pane state does not retain project path
- workspace activation does not fully own project activation

Assessment:

- this is the most important gap to close
- PacketCode is structurally closer to the right model than Zen, but the runtime wiring is incomplete

## PacketCode Advantage If Implemented Well

Zen gives PacketCode a useful pattern, but PacketCode can actually land on a stronger design:

- Zen has a global active project plus workspace system
- PacketCode can make workspace itself the project container

That lets PacketCode support:

- one workspace per project
- separate terminals per project-bound workspace
- workspace-scoped git and explorer context
- better future integration with flights and review flows

## Recommendations

1. Treat workspace-per-project as the primary architectural move
2. Add a workspace-scoped git panel and diff editor after that model is in place
3. Upgrade prompt templates into a lightweight prompt library that targets active workspace terminals and chat surfaces

## Recommended Build Order

1. workspace project model
2. git workspace surface
3. prompt library UX

## Bottom Line

The Zen comparison is useful, but the biggest win is not copying Zen's project list.

The biggest win is using Zen as the push to finish PacketCode's own stronger direction:

- each workspace is a project
- each workspace owns its own terminals
- each workspace becomes the local operating surface for git, files, prompts, and agent execution

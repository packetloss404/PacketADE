# Zen Workspace Research Notes

> Research date: 2026-04-09
> Source repo: [riftzen-bit/zen-workspace-ide](https://github.com/riftzen-bit/zen-workspace-ide)

## Scope

This research pass focuses on the Zen Workspace capabilities that are most relevant to PacketCode's workspace direction:

- git workspace UX
- prompt library UX
- project list and project switching model

## Source Evidence

Repository-level evidence reviewed:

- `README.md`
- `package.json`
- `src/renderer/src/components/layout/AppLayout.tsx`
- `src/renderer/src/components/git/GitDashboard.tsx`
- `src/renderer/src/components/git/GitDiffEditor.tsx`
- `src/renderer/src/components/ui/PromptLibrary.tsx`
- `src/renderer/src/components/projects/ProjectList.tsx`
- `src/main/fileWatcher.ts`
- `src/renderer/src/store/useProjectStore.ts`
- `src/renderer/src/store/useTerminalStore.ts`

PacketCode files used for comparison:

- `src/stores/workspaceStore.ts`
- `src/types/workspace.ts`
- `src/stores/layoutStore.ts`
- `src/components/workspace/WorkspaceCreationModal.tsx`
- `src/components/workspace/WorkspaceSidebar.tsx`
- `src/components/views/WorkspaceView.tsx`
- `src/stores/projectHistoryStore.ts`
- `src/stores/promptStore.ts`

## Relevant Zen Findings

## 1. Git is a first-class workspace surface

Zen includes both:

- `GitDashboard.tsx`
- `GitDiffEditor.tsx`

The dashboard handles:

- branch display
- staged and unstaged file lists
- stage and unstage actions
- stage all
- AI-generated commit messages
- commit execution
- diff selection by file

The diff editor uses Monaco's diff view and reads staged or unstaged file content directly from git APIs.

## 2. Prompting is treated as a reusable library, not just a stored template list

Zen's `PromptLibrary.tsx` provides:

- built-in prompt presets
- custom prompt creation
- search and category grouping
- one-click send to chat
- one-click send to terminal

PacketCode already has `promptStore.ts` and prompt templates in Tools, but Zen's workflow is more operational and closer to day-to-day usage.

## 3. Projects are first-class UI entities

Zen has a dedicated `ProjectList.tsx` and `useProjectStore.ts`.

That model includes:

- named projects
- pinned projects
- recent projects
- active project selection
- project rename and removal

Project switching also updates the active workspace directory and resets file state.

## 4. Zen still keeps project context global

Zen's `useProjectStore` and `useFileStore` indicate a globally active workspace directory.

This matters because PacketCode should not stop at reproducing Zen's project list. PacketCode already has a better starting point: `Workspace.projectPath` exists today.

## PacketCode Architectural Read

PacketCode already stores `projectPath` on each workspace in `src/types/workspace.ts` and `src/stores/workspaceStore.ts`.

But the rest of the app still behaves as if project context is global:

- `src/stores/layoutStore.ts` owns a single global `projectPath`
- `WorkspaceCreationModal.tsx` creates a workspace from the current global project path
- `WorkspaceSidebar.tsx` presents separate Projects and Workspaces lists instead of treating workspaces as project containers
- `PaneConfig` in `src/types/layout.ts` has no project path field
- `layoutStore.addPane()` accepts `projectPath` in the options type but does not persist it

This means PacketCode has the domain model for per-workspace projects, but not the full runtime wiring.

## Main Takeaway

The strongest Zen-inspired opportunity is not just "add a project list".

The stronger move is:

- make PacketCode workspaces the true project boundary
- let each workspace own its project path and terminal runtime
- let git, explorer, and prompt workflows resolve against the active workspace instead of a single global project

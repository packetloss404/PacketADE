# Zen Feature Notes — Git Workspace Surface

> Research date: 2026-04-09
> Source repo: [riftzen-bit/zen-workspace-ide](https://github.com/riftzen-bit/zen-workspace-ide)

## What Zen Has

Zen includes a dedicated git workspace surface made of two parts:

- `src/renderer/src/components/git/GitDashboard.tsx`
- `src/renderer/src/components/git/GitDiffEditor.tsx`

## Shipped Behavior Observed

From `GitDashboard.tsx`:

- current branch display
- staged file list
- unstaged file list
- stage one file
- unstage one file
- stage all files
- click a file to open a diff view
- AI-generated commit message
- commit button in the same panel

From `GitDiffEditor.tsx`:

- side-by-side Monaco diff view
- staged versus HEAD diff mode
- working tree versus index diff mode
- syntax-aware language selection by file extension

## What PacketCode Has Today

PacketCode already has meaningful git and GitHub support:

- git branch and status access via Tauri bindings
- git commit, push, pull, branch creation, and safety checks in `src/lib/tauri.ts`
- GitHub view and PR workflows
- deploy and issue workflows that sit near source control usage

But PacketCode does not currently appear to have:

- a dedicated in-app git dashboard
- an embedded diff editor
- a file-by-file staging surface

## Why This Matters

This is not just a convenience feature.

Once PacketCode moves toward workspace-per-project behavior, git becomes part of the workspace identity. A workspace should be able to answer:

- what branch am I on?
- what changed in this project?
- what should I review before approving agent output?
- what should I commit from this workspace?

## Recommendation For PacketCode

The right goal is not to rebuild Zen's entire git UI verbatim.

The right goal is to add a PacketCode-native git surface that is:

- workspace-scoped
- review-friendly
- oriented around agent output and approvals

## Suggested Scope

Phase 1:

- active workspace branch display
- changed files list for the active workspace project
- open diff for a changed file

Phase 2:

- stage and unstage actions
- stage all
- commit flow in-app

Phase 3:

- connect diff and commit flows to review packets and flight approvals
- surface "files changed by this task" directly in the git panel

## PacketCode Advantage If Done Well

Zen's git surface is useful, but generic.

PacketCode can beat it by making git review part of the agent workflow itself:

- review packet opens the diff editor
- task handoff links to changed files
- flight approval can inspect relevant diffs before decision

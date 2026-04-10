# Zen Workspace Research

> Research date: 2026-04-09
> Source repo: [riftzen-bit/zen-workspace-ide](https://github.com/riftzen-bit/zen-workspace-ide)

This folder captures the Zen Workspace findings that are most relevant to PacketCode's next workspace iteration.

The focus areas here are intentionally narrow:

- richer git workspace UX
- prompt library UX
- project-centric workspaces, where each workspace owns its own project context and terminals

## Documents

- `research.md` — source summary and relevant evidence from the Zen Workspace repo
- `features-git-workspace.md` — Zen's built-in git dashboard and diff editor, and what matters for PacketCode
- `features-prompt-library.md` — Zen's prompt library and the PacketCode gap relative to existing prompt templates
- `features-project-workspaces.md` — Zen's project list and the implications for PacketCode workspaces
- `workspace-project-model-plan.md` — implementation plan for making each PacketCode workspace own a separate project
- `gap-analysis.md` — consolidated comparison and recommendations

## Current Product Read

The most important takeaway is not that PacketCode needs to copy Zen's entire UI.

The important takeaway is that PacketCode should move from:

- one global project context with workspaces layered on top

to:

- workspaces as the project boundary, with their own project path, terminals, git state, and file context

That direction fits PacketCode's existing workspace model better than trying to bolt on more global project controls.

# Zen Feature Notes — Prompt Library

> Research date: 2026-04-09
> Source repo: [riftzen-bit/zen-workspace-ide](https://github.com/riftzen-bit/zen-workspace-ide)

## What Zen Has

Zen includes `src/renderer/src/components/ui/PromptLibrary.tsx`.

Observed behavior:

- built-in prompts for common coding tasks
- custom prompt creation
- category grouping
- search
- send to chat
- send to terminal

This makes prompting feel like an operational tool, not just stored data.

## What PacketCode Has Today

PacketCode already has partial overlap:

- `src/stores/promptStore.ts` stores prompt templates
- `src/components/views/ToolsView.tsx` exposes template management
- `WorkspaceCreationModal.tsx` includes a prompt template picker

So this is not a greenfield gap.

## Real Gap

The gap is workflow shape, not storage.

PacketCode currently appears to treat prompts mostly as:

- reusable template records
- selected during setup flows

Zen treats prompts as:

- a quick-launch library available during active work

## Recommended Direction

PacketCode should evolve templates into a lightweight prompt library without overcomplicating the system.

## Good PacketCode-first version

- reuse `promptStore.ts`
- add built-in prompt entries without replacing custom templates
- allow send to:
  - active workspace terminal
  - selected workspace pane
  - active insights/chat input where relevant
- open from command palette and workspace UI

## Why This Matters For Workspaces

If each workspace becomes project-scoped, prompt reuse becomes more valuable:

- project-specific review prompts
- repo-specific debugging prompts
- workspace-specific agent kickoff prompts

That makes the prompt library a support feature for workspace execution, not just a standalone productivity toy.

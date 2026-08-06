# Zen Feature Notes — Prompt Library

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| Prompt storage | ✅ Done | promptStore.ts with add/update/delete |
| Built-in presets | ✅ Done | 5 presets auto-seeded |
| Search | ✅ Done | Search input in PromptLibrary |
| Send-to-terminal | ✅ Done | Writes to active PTY |
| Send-to-chat | ✅ Done | Sends to Scout agent chat |
| Command palette integration | ❌ Not started | — |

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

## What PacketADE Has Today

PacketADE already has partial overlap:

- `src/stores/promptStore.ts` stores prompt templates
- `src/components/views/ToolsView.tsx` exposes template management
- `WorkspaceCreationModal.tsx` includes a prompt template picker

So this is not a greenfield gap.

## Real Gap

The gap is workflow shape, not storage.

PacketADE now treats prompts as both:

- reusable template records
- quick-launch prompts from the workspace toolbar

Zen treats prompts as:

- a quick-launch library available during active work

## Recommended Direction

PacketADE should keep templates as a lightweight prompt library without overcomplicating the system.

## Good PacketADE-first version

- reuse `promptStore.ts`
- add built-in prompt entries without replacing custom templates
- allow send to:
  - active workspace terminal
  - selected workspace pane
  - Scout / agent chat where relevant
- open from command palette and workspace UI

## Why This Matters For Workspaces

If each workspace becomes project-scoped, prompt reuse becomes more valuable:

- project-specific review prompts
- repo-specific debugging prompts
- workspace-specific agent kickoff prompts

That makes the prompt library a support feature for workspace execution, not just a standalone productivity toy.

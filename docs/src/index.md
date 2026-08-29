# PacketBench documentation

PacketBench is a local-first desktop **Agent Development Environment**. It wraps
PTY-backed coding CLIs and API-agent providers into one native application, so
the terminal agents, the chat agents, the issue tracker, the orchestration layer
and the project memory all sit in a single window and share state.

It is a Tauri v2 application: a Rust backend, a React 19 frontend, and a Node
sidecar for the two provider SDKs that need one.

> **Note:** This documentation is written against source **v0.12.1**. Where
> behaviour depends on a version, the version is named. Anything not yet proven
> on a packaged install is marked as such rather than described as if it were.

## Start here

| If you want to | Read |
| --- | --- |
| Get it running on your machine | [Install & first run](install.html) |
| Understand the vocabulary before clicking around | [Core concepts](concepts.html) |
| Drive terminal CLIs in panes | [Workspaces & terminals](workspaces.html) |
| Talk to an API agent with tools and review | [Agents & conversations](agents.html) |
| Run several attempts at one task in parallel | [Flight Deck](flights.html) |
| Understand how the app remembers your project | [Memory](memory.html) |
| Work on PacketBench itself | [Architecture](dev-architecture.html) |
| Point a coding agent at this repository | [Agent orientation](agent-guide.html) |

## What it does

**Multi-CLI workspaces.** Claude Code, Codex CLI, OpenCode, PacketCode and plain
shells run side by side in draggable pane mosaics, each pane a real PTY. Layouts
persist and hydrate dormant — nothing launches until you open the workspace.

**A nine-row agent picker.** Structured conversations with the Claude Agent SDK,
Claude API, OpenAI API, OpenAI Agents SDK, MiniMax, OpenRouter, local Ollama, the
PacketCode engine over ACP, and any OpenAI-compatible endpoint you configure.
Three transports, one event contract, so the interface is identical whichever
row you pick.

**Flight Deck.** Organise work as Flights: plan in a read-only agent
conversation, apply structured milestones, then launch parallel worktree
attempts across local and SSH agents with status, attention and cost rollups.

**Project memory.** Terminal sessions and finished Flights are recorded
automatically, conventions are distilled into learned patterns, and durable
notes live as ordinary Markdown in `.agents/memory` — committed with your repo.
Relevant context is injected into agent sessions behind a visible toggle.

**Issues, MCP, SSH, dictation, budgets.** A kanban board that syncs with GitHub
and self-hosted Gitea/Forgejo; an MCP hub that both consumes servers and
publishes PacketBench's own resources; remote workspaces with pinned host keys;
local Whisper dictation with speaking analytics; and spend caps that are
enforced at launch.

## What it deliberately is not

Being clear about the boundaries saves you looking for things that are not
there on purpose.

- **No hosted service.** There is no PacketBench account, backend or telemetry
  endpoint. Everything runs on your machine.
- **No subscription logins for API agents.** Every keyed row authenticates with
  an API key you supply, stored in your OS keyring. Terminal panes running the
  `claude` or `codex` CLIs keep those tools' own logins, which is ordinary
  end-user use of those tools.
- **No cost dashboard.** Spend is measured to *enforce* budget caps, not to
  present a running dollar readout. That was removed deliberately in July 2026.
- **No autonomous planner.** Flight planning is a normal read-only conversation
  that you apply. The autonomous planner runtime was removed in July 2026 and is
  not coming back.

## Status

PacketBench is in active development and dogfooded daily. Windows installers are
built locally from source; the newest artifact published to GitHub Releases is
considerably older and still carries the previous product name. Nothing is code
signed yet, and no packaged install has been through the full acceptance matrix.

See [Install & first run](install.html) for exactly what that means for you.

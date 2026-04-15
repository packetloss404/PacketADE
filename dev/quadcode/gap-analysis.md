# QuadCode vs PacketCode — Gap Analysis

## Implementation Status — 2026-04-15

| Gap | Status | Notes |
|-----|--------|-------|
| Broadcast mode | ❌ Removed | Deliberately removed in v0.4.0; BroadcastBar deleted |
| Multi-model support | ✅ Done | Model variant selector in pane header |
| Per-session accent colors | ✅ Done | Auto-assigned + user picker on workspace panes |
| Pinned/quick commands | ✅ Done | Up to 5 per pane, quick pill bar |
| Pane zoom-to-focus | ✅ Done | Maximize/Minimize toggle, Escape to exit |
| Specialized agent roles | ❌ Not started | Covered by swarm Track S |
| Broader MCP catalog | ❌ Not started | — |
| Design system generation | ❌ Not pursuing | Different product direction per positioning-notes.md |

> Research date: 2026-04-09
> Sources: [getquadcode.com](https://getquadcode.com/), [quadcode.ai](https://quadcode.ai/), [quadslab.io](https://quadslab.io/products)

## Overview

Two products operate under the "QuadCode" name — a multi-agent terminal (getquadcode.com) and an agentic IDE platform (quadcode.ai). This analysis compares both against PacketCode to identify feature gaps and opportunities.

---

## Gap Summary

### Priority 1 — High-impact, feasible additions

| Gap | Source | Effort | Notes |
|-----|--------|--------|-------|
| ~~Broadcast mode~~ | getquadcode.com | Medium | ~~Send one prompt to multiple PTY sessions simultaneously.~~ **Removed in v0.4.0** — `BroadcastBar` was deliberately deleted. Revisit only if a new UX pattern emerges (e.g., workspace-scoped prompt fan-out). |
| Multi-model support | quadcode.ai | Large | Add Gemini, GPT, DeepSeek, Grok beyond Claude/Codex. Requires new PTY startup logic per CLI and potentially API-based backends. |
| Per-session accent colors | getquadcode.com | Small | Accent color picker per session; update terminal cursor, border, and tab highlight. Stored in session config. |
| Pinned/quick commands | getquadcode.com | Small | Save up to N quick-run commands per session for one-click execution. Store in sessionStore or per-workspace config. |
| Pane zoom-to-focus | getquadcode.com | Small | Maximize a single pane to full window with one-click restore. PaneContainer layout toggle. |

### Priority 2 — Differentiating but larger scope

| Gap | Source | Effort | Notes |
|-----|--------|--------|-------|
| Specialized agent roles | quadcode.ai | Large | Purpose-built agents (Developer, Designer, Reviewer) with distinct system prompts and tool access. PacketCode has agent profiles but not role-specialized workers with different capabilities. |
| Broader MCP integration catalog | quadcode.ai | Medium | Pre-configured integrations for Figma, Notion, Slack, Confluence, Docker, Playwright, Sentry. PacketCode has MCP Hub but fewer out-of-box configs. |
| Design system generation | quadcode.ai | Large | Component tokens, typography pairings, grid presets, Figma export. Entirely new feature domain. |

### Priority 3 — Creative/media features (different product direction)

| Gap | Source | Effort | Notes |
|-----|--------|--------|-------|
| AI image generation | quadcode.ai | Large | Photoreal, stylized, branded visual creation. Outside PacketCode's current scope as a dev IDE. |
| Video/motion production | quadcode.ai | Very Large | Video generation, 3D assets, 4K export. Entirely different product domain. |
| Audio production | quadcode.ai | Very Large | Voice gen, SFX, music editing. Entirely different product domain. |
| Mobile/game app generation | quadcode.ai | Large | Guided scaffolding for mobile and game projects. Partially addressable via Scaffold module templates. |

---

## PacketCode Advantages (no equivalent in QuadCode)

| Feature | Details |
|---------|---------|
| Flights | Top-level work organizer linking issues and sessions with status rollup |
| Kanban issue board | Built-in issue tracker with drag-and-drop columns |
| Deploy pipeline | Integrated deploy configuration and execution |
| Project scaffolding | Template-based project generation |
| Memory layer | Persistent AI context across sessions |
| Insights & Ideation | AI-powered codebase analysis and idea generation |
| Cost dashboard | Track AI token usage and costs |
| Analytics | Usage analytics across sessions |
| GitHub integration | Native GitHub API integration (not just MCP) |
| Windows support | Full Windows support via Tauri; QuadCode terminal is macOS/Linux only |
| Flight orchestration | Multi-agent orchestration engine shared between GUI and TUI |

---

## Recommendations

1. ~~**Broadcast mode**~~ was removed in v0.4.0 after evaluation. If revisited, consider a workspace-scoped variant rather than the original global broadcast.
2. **Per-session theming and pinned commands** are small UX improvements that improve session identity and productivity.
3. **Pane zoom** is trivial to add and improves focus workflows.
4. **Multi-model support** is the largest strategic gap — users increasingly expect model flexibility. Consider an abstraction layer for agent backends.
5. **Creative/media features** (image, video, audio) represent a different product direction. Not recommended unless PacketCode pivots toward a broader creative platform.

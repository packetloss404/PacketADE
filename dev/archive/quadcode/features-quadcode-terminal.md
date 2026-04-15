# QuadCode Multi-Agent Terminal — Feature Documentation

> Source: [getquadcode.com](https://getquadcode.com/)
> Research date: 2026-04-09

## Product Summary

QuadCode is a native desktop terminal app (Electron) that runs up to 4 AI coding agents simultaneously in a grid layout. It targets developers who want to compare agent outputs side-by-side or run parallel tasks across different AI CLIs.

- **Platforms:** macOS (Apple Silicon, macOS 12+), Linux (x86_64 AppImage)
- **Pricing:** $24.50 lifetime license, 7-day free trial
- **No Windows support**

---

## Core Features

### Multi-Agent Panes
- 4 parallel terminal panes in a grid layout
- Each pane runs an independent AI agent: Claude, Gemini, Codex, or Aider
- Agent can be switched per pane at any time via dropdown
- Each pane operates autonomously

### Broadcast Mode (Cmd+B)
- Type a prompt once, send to all 4 panes simultaneously
- Each agent responds independently
- Use case: compare responses, run identical commands (git pull, npm install), or test prompts across models

### Auto/Bypass Mode
- "Lightning" variants (Claude ⚡, Gemini ⚡, Codex ⚡, Aider ⚡) available per pane
- Appears to auto-accept or bypass confirmation prompts

### Pinned Commands
- Save up to 5 quick-run commands per pane
- One-click execution — no retyping
- Persisted across sessions

### Named Panes
- Assign a project name to each pane
- Names persist across app restarts
- Helps with workspace organization

### Per-Pane Accent Colors
- Pick any accent color per pane
- Borders, cursor, and highlights update instantly
- Visual differentiation between workspaces

### Layout Options
- Side-by-side (default 2x2 grid)
- Stacked layout
- Single focus mode
- Zoom any pane to full window (Cmd+Enter), one-click restore

### Session Persistence
- Agent selection, titles, colors, and commands retained after closing
- Full state restore on relaunch

### Font Controls
- Adjustable from 9px to 28px
- A-/A+ controls or Cmd+/Cmd-

### Keyboard Shortcuts
- Cmd+1–4: Focus pane
- Cmd+R: Restart pane
- Cmd+Enter: Zoom/restore pane
- Cmd+B: Broadcast mode
- Right-click context menu: copy, paste, select all, clear

---

## What's Notable

- Very focused product — does one thing (multi-agent terminal) well
- No issue tracking, no project management, no deploy pipeline
- No file explorer, no editor, no GitHub integration
- Pure terminal multiplexer with AI-agent awareness
- Lifetime pricing model (no subscription)

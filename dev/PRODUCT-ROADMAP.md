# PacketCode — Product Roadmap

> Date: 2026-04-03

---

## Vision

PacketCode is a native desktop IDE that unifies AI coding agents (Claude Code, OpenCode, Codex CLI) with project lifecycle management — issues, flights, orchestration, deploy — in a single Tauri v2 app. The goal is to be the command center where developers plan, build, and ship with AI agents, not just chat with them. Unlike browser-based tools or VS Code extensions, PacketCode owns the full stack from PTY to deploy pipeline.

---

## Current Release: What Ships Today

The following features are implemented and functional:

### Core IDE
- Multi-pane PTY terminal with Claude Code, OpenCode, and Codex CLI sessions
- Session tab management with profile-based model/prompt injection
- File explorer with directory listing (Rust backend)
- Command palette with keyboard navigation
- Dark/light theme toggle
- Welcome screen with quick-start session launcher

### AI Features
- Streaming insights chat (`ask_insights_stream`)
- Voice input for prompts (Web Speech API)
- Memory layer with per-session context injection
- Agent profiles (built-in: Claude Code, OpenCode, Codex; user-configurable model/args)
- Ideation scanner
- Spec-to-tickets parser
- Code quality analysis modal

### Project Lifecycle
- Kanban issue board with flight linkage
- Flights (top-level work organizer above issues)
- FlightDeck orchestration engine (launch, pause, resume, cancel flights; milestone gating; parallel session scheduling)
- Cost tracking dashboard (7-day chart)
- Git read + write ops (commit, push, pull, create branch) via Rust backend
- GitHub integration (PR listing, diff viewer, token auth)
- MCP server management (CRUD)
- Project scaffolding templates
- Deploy pipeline (config + terminal)
- Analytics view, history view

### What's Missing for a Public Release
- No code signing — Windows SmartScreen warns, macOS Gatekeeper blocks
- No tests — zero frontend tests, zero Rust unit tests, no E2E
- GitHub token stored in plaintext (no keychain)
- No auto-updater
- All state in localStorage (no data versioning/migration framework)

---

## Phase 1: Control Plane + Persistence (Sprints 1–2, ~4 weeks)

**Goal:** Make FlightDeck reliable enough for real multi-agent workflows and ensure data survives across versions.

### Sprint 1: Control Plane Hardening
| Item | Current State | Work Required |
|------|--------------|---------------|
| Git safety UI | Rust commands done, no UI confirmation | Add confirmation dialogs for destructive git ops (push --force, reset) |
| Approval/review gates | `notifyApprovalNeeded`/`notifyApprovalResolved` wired in orchestration store | Build approval UI component; wire to milestone gating |
| Session inspect | Not started | Read-only view of running agent session output from FlightDeck |
| Agent provider detection | `detectInstalled` in agentStore | Surface install status in FlightDeck, block launch if agent missing |

### Sprint 2: Persistence & Data Integrity
| Item | Current State | Work Required |
|------|--------------|---------------|
| Data versioning | No migration framework | Add `CURRENT_VERSION` per store + `migrateData()` on hydrate |
| Backend persistence | `loadPersistedState`/`saveSettingsSlice` exist | Migrate orchestration, agent, and flight state to Rust-backed file storage |
| Secure token storage | Plaintext file | Migrate GitHub token to OS keychain (`keyring` crate) + `zeroize` for memory |
| Session persistence | Not started | Save PTY scrollback to disk; restore on restart |

### What This Unlocks
- Users can trust FlightDeck to run multi-step agent workflows without losing state on crash or restart
- Git operations have safety rails in the UI, not just the backend
- Data model is versioned, so future schema changes won't corrupt user state
- Foundation for all Phase 2 UX work (review UI needs persistence; mission workspace needs session inspect)

---

## Phase 2: UX + Mission Chat (Sprints 3–4, ~4 weeks)

**Goal:** Add the "mission workspace" that makes FlightDeck feel like a war room, not just a launcher. Ship the chat-based agent interface.

### Sprint 3: Mission Workspace + FlightDeck Overview
| Item | Current State | Work Required |
|------|--------------|---------------|
| Mission Workspace | Not started | Dedicated view per flight: timeline, linked issues, agent sessions, milestones, activity log |
| FlightDeck overview | Partial (FlightDeckView exists) | Add status rollup dashboard: flights in progress, blocked, completed; agent utilization |
| Review/approval UI | Not started (blocked on Sprint 1 approval gates) | Modal or inline review for milestone outputs; approve/reject/re-run |
| Inline file preview | Not started | Detect file paths in terminal output; open preview panel on click |

### Sprint 4: OpenCode Chat + UX Polish
| Item | Current State | Work Required |
|------|--------------|---------------|
| OpenCode chat integration | Agent config exists, no dedicated chat UI | Build chat-style interface for OpenCode alongside PTY mode |
| Multi-model A/B comparison | Not started | "Dual fire" mode: same prompt to two agents, side-by-side diff of outputs |
| Notification system | `notificationStore` exists | Wire to orchestration events (task complete, approval needed, failure) |
| Bundle size optimization | Not started | Lazy-load views, tree-shake syntax highlighter |

### What This Unlocks
- FlightDeck becomes a real project command center, not just a session launcher
- Users can review agent work at milestone boundaries before proceeding
- A/B comparison lets users evaluate which agent/model performs better per task
- Chat UI opens PacketCode to users who prefer conversational interaction over terminal

---

## Phase 3: Distribution & Extensibility (Future, 8+ weeks)

**Goal:** Make PacketCode installable without security warnings, extensible by the community, and robust under production use.

| Item | Depends On | Work |
|------|-----------|------|
| **Code signing (Windows + macOS)** | Nothing (can start anytime) | Certificate acquisition, NSIS/DMG config, CI signing pipeline |
| **Auto-updater** | Code signing | `tauri-plugin-updater` integration, rollback strategy |
| **Plugin system** | Data versioning (Phase 1) | Plugin manifest format, user folder loading, enable/disable UI |
| **Multi-model routing** | A/B comparison (Phase 2) | Automatic model selection based on task type/cost/latency |
| **Session reconnection** | Session persistence (Phase 1) | Reconnect to running PTY processes after app restart |
| **Testing infrastructure** | Nothing (can start anytime) | Vitest + @testing-library/react, Rust unit tests, Playwright E2E |
| **Crash reporting** | Nothing | Rust panic hook, crash log viewer on next launch |
| **Apache 2.0 licensing** | Business decision | License file, header sweep, contributor agreement |

---

## Dependency Graph

```
Phase 1 (Sprints 1-2)
├── Data versioning framework
│   └── Plugin system (Phase 3)
├── Session persistence (scrollback to disk)
│   └── Session reconnection (Phase 3)
├── Approval gates UI
│   └── Review/approval UI (Phase 2, Sprint 3)
├── Session inspect
│   └── Mission Workspace (Phase 2, Sprint 3)
├── Secure token storage
│   └── (unblocks public release)
└── Git safety UI
    └── (unblocks public release)

Phase 2 (Sprints 3-4)
├── Mission Workspace ← Session inspect (Phase 1)
├── Review/approval UI ← Approval gates (Phase 1)
├── FlightDeck overview ← (no hard blocker, but better with persistence)
├── A/B comparison
│   └── Multi-model routing (Phase 3)
└── OpenCode chat UI

Phase 3 (Future)
├── Code signing ← (independent, start when ready)
│   └── Auto-updater
├── Plugin system ← Data versioning (Phase 1)
├── Testing ← (independent, start when ready — ideally Sprint 1)
└── Apache 2.0 licensing ← (business decision, no technical blocker)
```

**Critical path:** Data versioning → Plugin system. Session persistence → Session reconnection. Approval gates → Review UI → Mission Workspace (full version). Code signing is independent and should start as soon as a certificate is obtained.

**Testing** has no technical dependency and should be interleaved starting Sprint 1. Every new feature in Phase 1-2 should ship with tests.

---

## Competitive Differentiators

| Dimension | PacketCode | Cursor | Cline | Codex App |
|-----------|-----------|--------|-------|-----------|
| **Agent model** | Multi-agent (Claude, OpenCode, Codex) in one app | Single (Cursor's own) | Single (BYOK, one at a time) | OpenAI only |
| **Orchestration** | FlightDeck: milestone-gated, parallel agent scheduling | None | None | None |
| **Project lifecycle** | Issues → Flights → Deploy in one tool | None (editor only) | None (extension only) | None |
| **Platform** | Windows + macOS (Tauri) | All (Electron) | All (VS Code ext) | macOS only |
| **Architecture** | Native app, owns PTY layer | VS Code fork | VS Code extension | Native app |
| **Pricing model** | BYOK (user's own API keys) | $20/mo subscription | Free + $20/mo Teams | Included with OpenAI subscription |
| **Lock-in** | None — wraps existing CLIs | High (proprietary editor) | Low (VS Code ext) | High (OpenAI ecosystem) |
| **Open source** | Recommended Apache 2.0 | Proprietary | Apache 2.0 | Proprietary |

### Where PacketCode Wins
1. **Orchestration is the moat.** No competitor has multi-agent flight orchestration with milestone gating. Cursor and Cline are single-agent tools. Codex App is a launcher, not an orchestrator.
2. **Full lifecycle, not just coding.** Issues, flights, deploy, cost tracking — PacketCode is the only tool that covers plan-to-ship. Competitors require switching to Jira, Linear, or GitHub for project management.
3. **Multi-agent, zero lock-in.** Users bring their own CLI agents and API keys. If a better agent ships tomorrow, add it to PacketCode. Cursor and Codex App lock users into one vendor.
4. **Windows on day one.** Codex App is macOS-only. PacketCode ships cross-platform from the start, capturing the 70%+ of developers on Windows/Linux.

### Where PacketCode Is Vulnerable
1. **No testing infrastructure** — shipping quality is a trust issue, especially against VC-funded competitors with QA teams.
2. **No code signing** — first-run experience on Windows/macOS is actively hostile (security warnings).
3. **Single developer** — Cursor has hundreds of engineers; Cline has a funded team. Velocity risk is real.
4. **Editor gap** — PacketCode has no code editor. Users still need VS Code or similar open alongside it. This is by design (wrapper, not replacement) but limits the "single tool" narrative.

---

*This roadmap reflects code as of 2026-04-03. Feature status is based on direct codebase inspection, not aspirational planning.*

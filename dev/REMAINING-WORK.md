# PacketCode — Remaining Work

**Date:** 2026-04-06

## Completed (Sprints 0–3)

| Area | Status |
|------|--------|
| Security hardening (7 issues) | Done |
| Orchestration control plane | Done — Rust is single source of truth |
| Review/approval system | Done — ReviewPacket, audit trail, Review Queue |
| Persistence migration | Done — localStorage → Rust backend, state v2 |
| FlightDeck UX | Done — live indicators, inline actions, auto-refresh |
| TerminalPane partial decomp | Done — ActivityStrip + TerminalHeader extracted |
| Test infrastructure | Done — 50 Rust + 122 frontend tests |

## Completed (Sprint 4 — out of plan)

| Area | Status |
|------|--------|
| **Workspaces feature** (multi-agent grid) | Done — symmetric NxN grid of any combination of Terminal/Claude/Codex/Gemini/OpenCode, broadcast prompts, persistent right sidebar with WORKSPACES + PROJECTS sections, project history tracking, "Keep terminals alive" toggle. New agents: Gemini CLI + Terminal. Ctrl+Shift+W shortcut. |

## Remaining — Sprint 4

| Item | Status | Priority | Complexity | Notes |
|------|--------|----------|-----------|-------|
| A1. Mission Workspace view (per-flight war room) | ❌ Not started | High | Large | Distinct from the Workspaces feature already shipped. This is a per-flight command center: timeline, linked issues, agent sessions panel, milestones+tasks, activity log. New view `mission` to add to `CoreView`. |
| A2. Session inspect (read-only transcript) | ❌ Not started | High | Medium | Reuse existing `read_pty_transcript` Tauri command. New file: `src/components/session/SessionInspect.tsx` |
| B1. OpenCode chat UI | ❌ Not started | Medium | Large | Reuse `ask_insights_stream` pattern. New file: `src/components/session/AgentChatPanel.tsx` |
| B2. Multi-model A/B comparison | ❌ Not started | Low | Medium | "Dual fire" mode — same prompt to two agents, side-by-side diff |
| C1. Complete TerminalPane decomposition | ❌ Not started | Medium | Medium | Currently 601 lines. Extract `ApprovalOverlay` (~30 lines) + `useTerminalSession` hook (~200 lines). Target: ~60-line composition shell |
| C2. Notification wiring | ❌ Not started | Medium | Small | Hook `notificationStore` to orchestration events: task complete, approval needed, flight failed |
| C3. Bundle size optimization | ❌ Not started | Low | Medium | Vite build warns at >500KB. Lazy-load views via `React.lazy()` + `Suspense`, tree-shake syntax highlighter |

## Remaining — Phase 3 (Distribution)

| Item | Priority | Blocker |
|------|----------|---------|
| Code signing (Win + macOS) | Critical for release | Certificate acquisition |
| Auto-updater | High | Code signing |
| Crash reporting | Medium | None |
| Plugin system | Low | None (data versioning done) |
| Multi-model A/B comparison | Low | None |
| Session reconnection | Low | None |
| E2E tests (Playwright) | Medium | None |
| Apache 2.0 licensing | Business decision | None |

## Competitive Moat

PacketCode's differentiators that no competitor has:
1. Multi-agent orchestration with milestone gating (FlightDeck)
2. Full lifecycle in one app (issues → flights → deploy)
3. Agent-agnostic BYOK model
4. Windows on day one

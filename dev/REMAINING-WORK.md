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

## Remaining — Sprint 4 (Mission Workspace & Chat)

| Item | Priority | Complexity |
|------|----------|-----------|
| Mission Workspace view | High | Large |
| Session inspect (read-only transcript) | High | Medium |
| OpenCode chat UI | Medium | Large |
| Complete TerminalPane decomposition | Medium | Medium |
| Notification wiring | Medium | Small |
| Bundle size optimization | Low | Medium |

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

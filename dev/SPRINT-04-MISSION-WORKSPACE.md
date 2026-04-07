# Sprint 04 — Mission Workspace & Agent Chat

**Date:** 2026-04-06

## Sprint Goal

Build the Mission Workspace (dedicated per-flight command center) and ship a chat-based agent interface alongside PTY mode. Complete the TerminalPane decomposition started in Sprint 3.

## Prerequisite

Sprints 0–3 complete.

## Sprint 4 Status

| Item | Status |
|------|--------|
| A1. Mission Workspace view | ❌ Not started |
| A2. Session Inspect | ❌ Not started |
| B1. OpenCode Chat UI | ❌ Not started |
| B2. Multi-model A/B comparison | ❌ Not started |
| C1. Complete TerminalPane decomposition | ❌ Not started |
| C2. Notification wiring | ❌ Not started |
| C3. Bundle size optimization | ❌ Not started |
| D1. Code signing | ❌ Blocked on certificate |
| D2. Auto-updater | ❌ Blocked on D1 |
| D3. Crash reporting | ❌ Not started |

**Out-of-plan shipped:** Workspaces feature (multi-agent grid + sidebar) — see PROJECT-STATUS.md and REMAINING-WORK.md. This is **distinct** from "Mission Workspace" (A1) which is a per-flight war room.

---

## Part A — Mission Workspace

### A1. Mission Workspace View

**Current state:** No dedicated per-flight view. FlightDeckView shows an overview. FlightsView shows a list with detail panel. Neither provides a unified "war room" for a single flight.

| Item | Description |
|------|-------------|
| **New view: `mission`** | Add `"mission"` to `CoreView` in `appStore.ts`. Route in `App.tsx`. |
| **Timeline** | Vertical timeline of flight events: created, launched, task spawned, task completed, milestone advanced, paused, resumed. Source: flight `updatedAt` timestamps + task `startedAt`/`completedAt`. |
| **Linked issues panel** | Show issues linked to the flight with status badges. Click navigates to issue board filtered to that issue. |
| **Agent sessions panel** | Show all sessions linked to the flight (from `linkedSessionIds`). Each session shows: agent name, status (from `activityStore`), duration. Click navigates to the session tab. |
| **Milestones + tasks** | Expandable milestone list showing tasks with status, agent, duration. Inline approve/deny for `approval_needed` tasks. |
| **Activity log** | Real-time log of orchestration events for this flight. |

**Files to create:** `src/components/views/MissionWorkspaceView.tsx`
**Files to modify:** `src/stores/appStore.ts` (add `"mission"` to CoreView), `src/App.tsx` (add route), `src/components/layout/Toolbar.tsx` (add button or make flights clickable)

### A2. Session Inspect

Read-only view of a running agent session's terminal output from FlightDeck or Mission Workspace. Uses `read_pty_transcript` (already exists) to fetch scrollback.

**Files to create:** `src/components/session/SessionInspect.tsx`

---

## Part B — Agent Chat Interface

### B1. OpenCode Chat UI

Build a chat-style interface for conversational interaction with AI agents, alongside the existing PTY terminal mode.

| Item | Description |
|------|-------------|
| **Chat panel** | Message list with user/assistant bubbles, markdown rendering, code blocks |
| **Input** | Text input with send button, voice input (reuse `useVoiceInput`), model selector |
| **Backend** | Reuse `ask_insights_stream` pattern — spawn CLI with piped stdout, emit line-by-line events |
| **Integration** | Chat sessions can be linked to flights like PTY sessions |

**Files to create:** `src/components/session/AgentChatPanel.tsx`

### B2. Multi-model A/B Comparison

"Dual fire" mode: send the same prompt to two agents simultaneously, show side-by-side diff of outputs.

| Item | Description |
|------|-------------|
| **Split view** | Two panes showing parallel agent responses |
| **Diff view** | Unified diff of outputs after both complete |
| **Metrics** | Side-by-side cost, tokens, duration comparison |

---

## Part C — Remaining Decomposition & Polish

### C1. Complete TerminalPane Decomposition

**Current state:** 601 lines. ActivityStrip and TerminalHeader extracted. Still inline: approval overlay, PTY session lifecycle hook.

| Extract | Lines | Target File |
|---------|-------|-------------|
| ApprovalOverlay | ~30 | `src/components/session/ApprovalOverlay.tsx` |
| useTerminalSession hook | ~200 | `src/hooks/useTerminalSession.ts` |

After extraction, TerminalPane.tsx should be a ~60-line composition shell.

### C2. Notification Wiring

Wire `notificationStore` to orchestration events: task complete, approval needed, flight failed.

### C3. Bundle Size Optimization

Lazy-load views via `React.lazy()` + `Suspense`. Tree-shake the syntax highlighter.

---

## Part D — Distribution Preparation

### D1. Code Signing

| Platform | Work |
|----------|------|
| Windows | EV or OV certificate, NSIS/MSI signing config, CI secrets |
| macOS | Apple Developer ID, notarization, entitlements plist |

### D2. Auto-updater

Integrate `tauri-plugin-updater` with update check on launch + manual "Check for updates" in Tools.

### D3. Crash Reporting

Rust panic hook that logs crash details. On next launch, show crash viewer with option to report.

---

## Definition of Done

- [ ] Mission Workspace view renders a complete flight command center
- [ ] Session inspect shows read-only terminal output from FlightDeck
- [ ] Chat UI works for at least one agent (OpenCode or Claude)
- [ ] TerminalPane.tsx is under 100 lines
- [ ] Notifications fire for task complete/approval/failure
- [ ] `pnpm build`, `pnpm lint`, `pnpm test`, `cargo test` all pass

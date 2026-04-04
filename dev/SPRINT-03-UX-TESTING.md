# Sprint 03 -- UX Polish & Test Infrastructure

**Sprint Goal:** Stand up frontend and backend test infrastructure with first meaningful coverage, and decompose the monolithic TerminalPane into maintainable units while upgrading FlightDeck from a passive dashboard to an actionable supervision surface.

**Prerequisite:** Sprint 02 (Orchestration Engine & Agent Framework) complete.

**Date:** 2026-04-03

---

## Part A -- Test Infrastructure

### A1. Frontend: vitest setup and first tests

**Current state:** Zero frontend test files. No vitest, no jsdom, no test script in `package.json`. 24 Zustand stores with no coverage. 669-line TerminalPane with no unit tests.

#### A1.1 Install vitest and configure

| Item | Detail |
|------|--------|
| Install | `pnpm add -D vitest jsdom @testing-library/react @testing-library/jest-dom` |
| Config file | Create `vitest.config.ts` at project root, extending `vite.config.ts` with `environment: 'jsdom'` and path aliases matching `tsconfig.json` (`@/` -> `src/`) |
| Script | Add `"test": "vitest run"` and `"test:watch": "vitest"` to `package.json` scripts |
| Tauri mock | Create `src/__mocks__/tauri.ts` that stubs `@tauri-apps/api/event` (`listen`, `emit`) and `@/lib/tauri` invoke wrappers so store tests can run without a native shell |

**Acceptance criteria:**
- `pnpm test` runs and exits 0 with at least one passing test.
- Vitest resolves `@/` path aliases correctly.
- Tauri invoke calls are intercepted by the mock (no native FFI at test time).

#### A1.2 First store tests (pure logic, no DOM)

Target the three stores with the most business logic:

| Store | File | Tests to write |
|-------|------|----------------|
| `flightStore` | `src/stores/__tests__/flightStore.test.ts` | createFlight, deleteFlight, addIssueToFlight/removeIssueFromFlight bidirectional sync, computeFlightStatus rollup logic (draft/active/done/failed), setActiveFlight |
| `issueStore` | `src/stores/__tests__/issueStore.test.ts` | createIssue, moveIssue (status transitions), assignToFlight/unassignFromFlight, delete cascading |
| `tabStore` | `src/stores/__tests__/tabStore.test.ts` | addTab, removeTab, updateTabStatus, getTab lookup, active tab management |

**Acceptance criteria:**
- Each store test file has >= 5 test cases covering primary CRUD and edge cases.
- Tests exercise Zustand `getState()`/`setState()` directly (no component rendering needed).
- All tests pass in CI without Tauri runtime.

#### A1.3 First component tests (shallow render)

| Component | File | Tests to write |
|-----------|------|----------------|
| `ActivityIcon` (extract from TerminalPane -- see B1) | `src/components/session/__tests__/ActivityIcon.test.tsx` | Renders correct icon for each state (`thinking`, `Edit`, `Bash`, fallback) |
| `StatusStrip` (extract from FlightDeckView -- see B2) | `src/components/views/__tests__/StatusStrip.test.tsx` | Renders correct count badges, hides zero-count statuses |
| `AttentionCard` | `src/components/views/__tests__/AttentionCard.test.tsx` | Renders flight title, priority, concerning issues count, border color for failed vs paused |

**Acceptance criteria:**
- Each component renders without errors in jsdom.
- Assertions verify visible text and CSS classes, not internal state.

---

### A2. Backend: Rust test expansion

**Current state:** 13 tests across 3 modules -- `statusline` (7 tests), `code_quality` (6 tests), `orchestrator` (2 tests). No tests for PTY lifecycle, `fs.rs`, `git.rs`, or persistence commands.

#### A2.1 PTY lifecycle tests

File: `src-tauri/src/commands/pty.rs` (add `#[cfg(test)] mod tests`)

| Test | What it validates |
|------|-------------------|
| `create_session_returns_unique_id` | Calling `create_pty_session` twice yields distinct session IDs |
| `write_to_nonexistent_session_returns_error` | `write_pty("bogus", ...)` returns `Err` not panic |
| `kill_session_is_idempotent` | Calling `kill_pty` on an already-killed session returns `Ok` |
| `resize_validates_dimensions` | Zero or negative cols/rows are rejected |

**Note:** PTY tests that actually spawn processes may need `#[ignore]` in CI if no TTY is available. Add a `pty_integration` feature flag or use `cfg!(test)` stubs.

#### A2.2 Git command safety tests

File: `src-tauri/src/commands/git.rs` (add `#[cfg(test)] mod tests`)

| Test | What it validates |
|------|-------------------|
| `git_branch_in_non_repo_returns_error` | Calling with `/tmp/nonrepo` does not panic |
| `git_status_returns_structured_result` | Output is parseable, not raw string dump |

#### A2.3 FS command tests

File: `src-tauri/src/commands/fs.rs` (add `#[cfg(test)] mod tests`)

| Test | What it validates |
|------|-------------------|
| `list_directory_returns_sorted_entries` | Lists known temp dir contents correctly |
| `list_directory_nonexistent_returns_error` | Does not panic on missing path |
| `hidden_files_are_included` | Dotfiles appear in results |

**Acceptance criteria:**
- `cargo test` in `src-tauri/` passes with >= 20 total tests (up from 13).
- No test requires a running Tauri app or active PTY (unit-level only, integration tests are `#[ignore]`).

---

### A3. CI: lint fix and test gates

#### A3.1 Fix existing lint failures

There are 2 known lint issues that `pnpm lint` flags:

| Issue | File | Fix |
|-------|------|-----|
| `no-control-regex` | `src/agents/types.ts` line 7-16 | The `ANSI_RE` regex contains literal control characters (`\x1B`, `\x0F`, `\x0E`). Add `// eslint-disable-next-line no-control-regex` above the `new RegExp(` line, or move to an eslint config rule override since ANSI stripping legitimately needs control chars. |
| React Hook memoization | `src/components/views/FlightDeckView.tsx` line ~227 | `computeFlightStatus` in useMemo deps -- either wrap the selector to return a stable reference, or `useCallback` the computation. Verify with `pnpm lint` after fix. |

**Acceptance criteria:**
- `pnpm lint` exits 0.
- No new `eslint-disable` comments except the justified ANSI regex one.

#### A3.2 Add test gates to CI (if CI exists) or document manual gates

| Gate | Command | Must pass |
|------|---------|-----------|
| Lint | `pnpm lint` | Yes |
| Type check | `pnpm build` (runs `tsc` first) | Yes |
| Frontend tests | `pnpm test` | Yes |
| Rust tests | `cd src-tauri && cargo test` | Yes |

---

## Part B -- UX Improvements

### B1. TerminalPane decomposition

**Current state:** `src/components/session/TerminalPane.tsx` is 669 lines. It handles xterm initialization, PTY session lifecycle, transcript/state detection, approval overlay UI, activity strip, status bars, pane header, kill/restart, and tab management -- all in a single component.

#### Decomposition plan

Extract the following into separate files under `src/components/session/`:

| New file | Lines extracted (approx) | Responsibility |
|----------|------------------------|----------------|
| `TerminalHeader.tsx` | ~60 lines (L491-545) | Pane header bar: status dot, CLI badge, restart/close buttons. Props: `alive`, `error`, `showApproval`, `cliCommand`, `onRestart`, `onKill`, `onClose`, `showCloseButton` |
| `ApprovalOverlay.tsx` | ~30 lines (L557-584) | Approval needed banner with Allow/Deny/Abort buttons. Props: `onApprove`, `onDeny`, `onAbort` |
| `ActivityStrip.tsx` | ~80 lines (L588-669) | Activity indicator strip + `ActivityIcon` + `getActivityLabel` helper. Props: `state`, `tool`, `file` |
| `useTerminalSession.ts` | ~200 lines (L46-412) | Custom hook encapsulating: xterm init, PTY create/attach/kill/restart, listener setup/teardown, tab registration, duration timer. Returns `{ termRef, alive, error, showApproval, activityInfo, handleKill, handleRestart, handleApprove, handleDeny, handleAbort }` |

After extraction, `TerminalPane.tsx` becomes a ~60-line composition shell:

```
TerminalPane
  -> useTerminalSession (hook)
  -> TerminalHeader
  -> <div ref={termRef} />  (xterm container)
  -> ApprovalOverlay (conditional)
  -> ActivityStrip (conditional)
  -> ClaudeStatusBar | CodexStatusBar (conditional)
```

**Acceptance criteria:**
- TerminalPane.tsx is under 100 lines after decomposition.
- Each extracted component has explicit TypeScript props interface.
- No behavioral regression: approval flow, activity strip, status bars, kill/restart all work identically.
- `ActivityIcon` and `getActivityLabel` are independently importable (enables A1.3 component tests).

#### Task sequence

1. Extract `ActivityStrip.tsx` + `ActivityIcon` + `getActivityLabel` (zero coupling, easiest).
2. Extract `ApprovalOverlay.tsx` (self-contained UI).
3. Extract `TerminalHeader.tsx` (self-contained UI).
4. Extract `useTerminalSession.ts` hook (largest refactor, do last).
5. Slim `TerminalPane.tsx` to composition shell.

---

### B2. FlightDeck enhancement

**Current state:** `FlightDeckView.tsx` is 282 lines. It is a read-only dashboard showing an attention queue, active flights grid, and grouped flight list. It has no live session data, no log tailing, no inline actions, and no way to approve/intervene from the deck itself.

#### Enhancement tasks

| Task | Description | Files | Acceptance criteria |
|------|-------------|-------|---------------------|
| **B2.1 Live session indicators** | For each active flight card, show linked sessions with live status (idle/thinking/tool_use/approval_needed) by reading from `activityStore`. | `FlightDeckView.tsx`, `activityStore.ts` | Active flight cards display session count with colored dots per session state. Dots update within 2s of state change. |
| **B2.2 Inline flight actions** | Add pause/resume/cancel buttons to AttentionCard and active flight cards. Wire to `flightStore.updateFlight` status transitions. | `FlightDeckView.tsx`, `flightStore.ts` | Clicking "Pause" on an active flight moves it to paused status. Clicking "Resume" on a paused flight moves it back to active. Actions are reflected immediately in the StatusStrip counts. |
| **B2.3 Session jump** | Clicking a session indicator on a flight card switches to that session's tab via `tabStore.setActiveTab`. | `FlightDeckView.tsx`, `tabStore.ts`, `layoutStore.ts` | Clicking a session dot navigates to the corresponding terminal pane. |
| **B2.4 Auto-refresh heartbeat** | Add a 5-second polling interval that recomputes `flightsByStatus` even if store references haven't changed (handles external session state drift). | `FlightDeckView.tsx` | FlightDeck data refreshes without user interaction. Add a subtle "last updated Xs ago" indicator in the StatusStrip. |
| **B2.5 Extract StatusStrip** | Move `StatusStrip` to `src/components/views/flight-deck/StatusStrip.tsx` for reuse and testability. | New file + `FlightDeckView.tsx` | StatusStrip is importable standalone. Component test from A1.3 passes. |

---

### B3. Additional UX tasks

| Task | Description | Files | Acceptance criteria |
|------|-------------|-------|---------------------|
| **B3.1 Keyboard shortcuts for approval** | In TerminalPane (or ApprovalOverlay after extraction), bind `y` to approve and `n` to deny when approval overlay is visible. Unbind when overlay hides. | `ApprovalOverlay.tsx` (or `TerminalPane.tsx` pre-extraction) | Pressing `y` while approval overlay is shown sends approval. Pressing `n` denies. No conflict with terminal input when overlay is hidden. |
| **B3.2 Empty state for FlightsView** | When no flights exist, show a guided onboarding card explaining what flights are and a prominent "Create First Flight" button. | `src/components/views/FlightsView.tsx` | Empty state is visually distinct from "loading". Button opens the create flight form. |
| **B3.3 Tab tooltip enrichment** | Tab tooltips currently show session name. Add agent state, current tool, and duration from `activityStore`. | `src/components/layout/SessionTabBar.tsx`, `activityStore.ts` | Hovering a tab shows e.g. "Claude -- editing src/App.tsx -- 4m 12s". |

---

## Definition of Done

All of the following must be true for Sprint 03 to be considered complete:

- [ ] `pnpm lint` exits 0 (A3.1 lint fixes applied)
- [ ] `pnpm test` exits 0 with >= 15 frontend tests passing (A1.1, A1.2, A1.3)
- [ ] `cargo test` in `src-tauri/` exits 0 with >= 20 Rust tests passing (A2.1, A2.2, A2.3)
- [ ] `TerminalPane.tsx` is under 100 lines; 4 extracted components/hooks exist with typed props (B1)
- [ ] FlightDeck shows live session indicators and inline flight actions (B2.1, B2.2)
- [ ] No behavioral regressions in terminal sessions, approval flow, or flight management
- [ ] All new components have explicit TypeScript interfaces (no `any` props)

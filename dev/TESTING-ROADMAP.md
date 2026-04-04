# Testing Roadmap

**Date:** 2026-04-03

---

## Current State

### Frontend (TypeScript/React)

| Metric | Value |
|---|---|
| Source files (`.ts`/`.tsx`) | ~105 |
| Zustand stores | 24 |
| Test files | **0** |
| Test framework installed | **None** (no vitest, jest, or testing-library in devDependencies) |
| `test` script in package.json | **Missing** |
| Coverage | **0%** |

### Backend (Rust)

| Metric | Value |
|---|---|
| Source files (`.rs`) | ~52 |
| `#[cfg(test)]` modules | 4 (across 3 files + 1 test-support module) |
| `#[test]` functions | **15** |
| Files with tests | `commands/statusline/mod.rs` (7 tests), `commands/code_quality.rs` (6 tests), `core/orchestrator.rs` (2 tests) |
| Test support module | `commands/statusline/codex.rs` (exposes helpers consumed by statusline tests) |
| Files with zero tests | ~49 out of ~52 -- includes `pty.rs`, `git.rs`, `github.rs`, `memory.rs`, `fs.rs`, `mcp.rs`, `deploy.rs`, `scaffold.rs`, `spec.rs`, `insights.rs`, `ideation.rs`, all TUI files, all core modules except orchestrator |

### CI (`ci.yml`)

| Step | Status |
|---|---|
| ESLint | Runs (`pnpm lint`) |
| TypeScript build check | Runs (`pnpm build` = `tsc && vite build`) |
| `cargo test` | Runs on Ubuntu + Windows matrix |
| Dependency audit | Runs (both pnpm + cargo), `continue-on-error: true` |
| Tauri builds | Linux, macOS, Windows |
| **Frontend test gate** | **Missing** -- no test runner to call |
| **Coverage threshold gate** | **Missing** -- no coverage tooling |
| **E2E tests** | **Missing** -- no Playwright or WebDriver |

### Known Lint Issues

| File | Rule | Issue |
|---|---|---|
| `src/components/session/TerminalPane.tsx:354` | `react-hooks/exhaustive-deps` | `useCallback` missing dependency `paneId` |

---

## Phase 1 -- Foundation (Sprint 1)

**Goal:** Install test infrastructure, write first store tests, expand Rust test coverage for critical modules, fix lint warning.

### 1.1 Install Frontend Test Tooling

```bash
pnpm add -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

Add to `vite.config.ts` a `test` block with `globals: true`, `environment: 'jsdom'`, and `setupFiles: ['./src/test/setup.ts']`.

### 1.2 First 5 Store Tests (Priority Order)

| # | Store | File | Why First |
|---|---|---|---|
| 1 | `issueStore` | `src/stores/issueStore.ts` | Complex CRUD + flight linkage, most business logic, bidirectional sync |
| 2 | `flightStore` | `src/stores/flightStore.ts` | Flight lifecycle, status rollup, session/issue linking |
| 3 | `layoutStore` | `src/stores/layoutStore.ts` | Pane management, session routing -- breakage blocks all UI |
| 4 | `appStore` | `src/stores/appStore.ts` | View routing, global state -- used by every component |
| 5 | `orchestrationStore` | `src/stores/orchestrationStore.ts` | Task queue management, agent dispatch |

Test pattern: initial state assertions, each action mutates correctly, edge cases, persistence round-trips.

### 1.3 First 3 Rust Test Modules to Add

| # | Module | File | Why |
|---|---|---|---|
| 1 | `commands/pty.rs` | PTY lifecycle | Foundation for every session; test arg resolution, `.cmd` wrapper logic, session create/kill |
| 2 | `commands/git.rs` | Git branch/status | Used on every session start; test branch parsing, error handling for non-git dirs |
| 3 | `commands/fs.rs` | Directory listing | File explorer depends on it; test filtering, hidden files, error paths |

### 1.4 Fix Lint Warning

In `src/components/session/TerminalPane.tsx:354`, add `paneId` to the `useCallback` dependency array.

---

## Phase 2 -- Coverage (Sprint 2-3)

**Goal:** Meaningful coverage on critical UI, Rust integration tests, CI test gates.

### 2.1 Component Tests (Priority Order)

- `TerminalPane` -- core session UI, mock xterm.js
- `FileExplorer` -- tree rendering, click handlers
- `Toolbar` -- view routing, button states
- `SessionTabBar` -- tab CRUD, active tab tracking
- `IssueBoard` (Kanban) -- card rendering, status changes, flight linkage
- `FlightDeckView` -- status grouping, attention highlighting
- `CommandPalette` -- fuzzy search, keyboard nav
- `NewSessionModal` -- form validation, prompt injection

### 2.2 Rust Integration Tests

- `commands/memory.rs` -- read/write/list, file I/O edges
- `commands/mcp.rs` -- config CRUD, TOML parsing, malformed input
- `commands/github.rs` -- response parsing with test fixtures
- `commands/deploy.rs` -- config persistence, validation
- `commands/scaffold.rs` -- template expansion, directory creation
- `core/orchestrator.rs` -- expand beyond 2 tests: concurrency limits, milestone rollup, error recovery
- `core/pty.rs` -- session registry, cleanup

Add to `Cargo.toml` dev-dependencies: `mockall = "0.13"`, `tempfile = "3"`.

### 2.3 CI Test Gates

Update `.github/workflows/ci.yml` to add `pnpm test` after the build step in the frontend job. Add coverage reporting.

Aspirational targets for end of Phase 2:
- Stores: 70%+
- Components: 40%+
- Rust commands: 50%+
- Rust core: 60%+

---

## Phase 3 -- E2E (Sprint 4+)

**Goal:** Validate critical user journeys in the actual Tauri app.

### 3.1 Setup

Install `@playwright/test`. Configure to launch via `pnpm tauri dev` on port 1420 using `tauri-driver` or Playwright Chromium webview connection.

### 3.2 Critical User Journey Tests

1. Create session and type a command (PTY lifecycle, terminal rendering)
2. Open File Explorer and navigate (fs commands, tree rendering)
3. Create a flight with milestones and tasks (flight store, FlightDeck)
4. Create an issue and link to a flight (bidirectional linkage, Kanban)
5. Switch views via toolbar (view routing, state preservation)
6. Command Palette search and execute (keyboard shortcut, fuzzy search)
7. GitHub integration flow (token entry, repo fetch, PR list)
8. MCP server add/edit/delete (config persistence, validation)

### 3.3 E2E CI

Run on a nightly schedule rather than per-PR to avoid long CI times.

---

## Priority Order Summary

| Priority | Target | Rationale |
|---|---|---|
| **P0** | Install vitest + first store tests | Zero frontend tests is the single biggest gap. Stores are easy to test without DOM mocking. |
| **P0** | `issueStore` + `flightStore` tests | Most complex mutation logic and bidirectional sync. Bugs cascade everywhere. |
| **P1** | `pty.rs` tests | Foundation for every session. Currently untested despite being the most complex backend module. |
| **P1** | Fix lint warning | Trivial, removes CI noise. |
| **P1** | Add `pnpm test` to CI | Without a gate, tests add no regression protection. |
| **P2** | Component tests for TerminalPane, FileExplorer | Most-used UI; rendering bugs immediately visible. |
| **P2** | Expand Rust orchestrator tests | Only 2 tests for a complex state machine. |
| **P3** | Coverage thresholds | Meaningful only once test volume exists. |
| **P4** | E2E / Playwright | High value, high setup cost; defer until unit/integration coverage is solid. |

---

## Key Risks

1. **xterm.js mocking** -- TerminalPane tests need a mock Terminal class. Use `vitest.mock()` with a lightweight stub.
2. **Tauri invoke mocking** -- Components calling `invoke()` need `@tauri-apps/api` stubbed. Create `src/test/tauri-mock.ts`.
3. **PTY tests on CI** -- `portable-pty` may behave differently in CI containers. Use conditional compilation or mock the PTY layer for unit tests.
4. **localStorage in tests** -- Zustand persisted stores need `beforeEach` cleanup or fresh `jsdom` storage per test.

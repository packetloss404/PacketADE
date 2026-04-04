# Sprint 02: Review Loops & Persistence

**Date:** 2026-04-03
**Author:** Code Review Developer 6

## Sprint Goal

Establish a structured approval/review workflow with audit trail and migrate fragmented frontend localStorage persistence to the Rust backend's unified state file.

## Prerequisite

Sprint 01 (Control Plane) must be complete. The orchestration engine, flight lifecycle, milestone gating, and task scheduling described in Sprint 01 are assumed to be stable and operational.

---

## Current State

### Approval System

The approval machinery exists in skeleton form across three layers but is disconnected:

**Rust backend (functional):**
- `core/orchestrator.rs` has `on_task_approval_needed` / `on_task_approval_resolved` that flip `TaskStatus::ApprovalNeeded <-> Running` on flight tasks.
- `commands/orchestration.rs` exposes `notify_approval_needed` / `notify_approval_resolved` as Tauri commands.
- Both are registered in `lib.rs`.

**Frontend orchestration store (functional):**
- `orchestrationStore.ts` has `onTaskApprovalNeeded` / `onTaskApprovalResolved` methods that update task status via `flightStore.updateTask` and call the Rust backend.
- `milestoneGating` flag exists to pause between milestones, and `pausedAtMilestone` map tracks gated flights.

**Frontend UI components (disconnected):**
- `ApprovalPrompt.tsx` renders an Allow/Deny prompt with `onApprove`/`onDeny` callbacks, but is imported by zero other files.
- `DiffBlock.tsx` renders unified diffs with syntax coloring, but is imported by zero other files.
- `TerminalPane.tsx` detects `needsApproval` from status-line polling and fires a browser `Notification`, but does not render `ApprovalPrompt` inline.

**What is missing:**
- No `ReviewPacket` type capturing what is being approved (diff, command, file list, rationale).
- No audit trail of approval decisions (who approved, when, what they saw).
- No override/escalation flow (e.g., force-approve a stuck task).
- No dedicated review queue UI to see all pending approvals across flights.
- No link between `ApprovalPrompt`/`DiffBlock` components and the orchestration flow.

### Persistence

**Rust backend (`core/storage.rs`):**
- `PersistedState` stores flights, agents, settings, and basic UI state in `~/.packetcode/state.v1.json`.
- Write-with-backup strategy (tmp + bak files, fsync).
- Mutex-guarded saves with version counter.
- Legacy migration from individual JSON files.

**Frontend (localStorage):**
- 13 independent stores persist to `packetcode:*` localStorage keys:
  - `packetcode:flights` (flightStore)
  - `packetcode:issues` (issueStore)
  - `packetcode:agents`, `packetcode:agent-overrides` (agentStore)
  - `packetcode:github` (githubStore)
  - `packetcode:cost-entries` (costStore)
  - `packetcode:insights-sessions` (insightsStore)
  - `packetcode:ideation-session` (ideationStore)
  - `packetcode:memory` (memoryStore)
  - `packetcode:modules` (moduleStore)
  - `packetcode:notifications` (notificationStore)
  - `packetcode:profiles`, `packetcode:active-profile` (profileStore)
  - `packetcode:prompt-templates` (promptStore)

**What is missing:**
- Flights are persisted in both localStorage AND `state.v1.json` with no reconciliation -- potential for drift.
- No contract tests verifying TS types match Rust `PersistedState` serde shapes.
- No migration path for moving localStorage stores to backend.
- localStorage is webview-scoped and not portable across devices or reinstalls.

---

## Tasks

### Task 1: Define ReviewPacket Type

**Goal:** Create a shared type that captures everything a reviewer needs to make an approval decision.

**Files to modify:**
- `src-tauri/src/core/flight.rs` -- add `ReviewPacket` struct (serde-serializable)
- `src/types/flight.ts` -- add matching `ReviewPacket` TypeScript interface

**Specification:**
```
ReviewPacket {
  id: string (uuid)
  taskId: string
  flightId: string
  milestoneId: string
  requestedAt: timestamp
  type: "tool_call" | "file_write" | "command" | "milestone_gate"
  summary: string (human-readable description of what is being requested)
  diff?: string (unified diff, if applicable)
  command?: string (shell command, if applicable)
  filePaths?: string[] (affected files)
  agentId?: string (which agent profile requested this)
  sessionId?: string (linked PTY session)
}
```

**Acceptance criteria:**
- Rust struct and TS interface are field-for-field identical.
- ReviewPacket is stored on the task when status transitions to `approval_needed`.
- ReviewPacket is included in `PersistedState` serialization (nested in task).

---

### Task 2: Define ApprovalDecision Type and Audit Trail

**Goal:** Record every approval decision permanently.

**Files to modify:**
- `src-tauri/src/core/flight.rs` -- add `ApprovalDecision` struct
- `src/types/flight.ts` -- add matching TS interface
- `src-tauri/src/core/storage.rs` -- add `approval_log` field to `PersistedState`

**Specification:**
```
ApprovalDecision {
  id: string (uuid)
  reviewPacketId: string
  taskId: string
  flightId: string
  decision: "approved" | "denied" | "force_overridden"
  decidedAt: timestamp
  reason?: string (optional reviewer comment)
}
```

**Acceptance criteria:**
- Every call to `onTaskApprovalResolved` creates an `ApprovalDecision` record.
- Decisions are appended to a persistent log in `state.v1.json`.
- Denied decisions trigger task status transition to `failed` (not back to `running`).
- Force-override is a separate decision type that requires an explicit reason string.

---

### Task 3: Wire ApprovalPrompt Into Orchestration Flow

**Goal:** When a task needs approval, render the existing `ApprovalPrompt` component inline in the relevant UI surface, populated with `ReviewPacket` data.

**Files to modify:**
- `src/components/session/ApprovalPrompt.tsx` -- expand props to accept `ReviewPacket`
- `src/components/session/DiffBlock.tsx` -- no changes needed (already functional)
- `src/components/session/TerminalPane.tsx` -- render `ApprovalPrompt` inline when `needsApproval` is true
- `src/components/views/FlightDeckView.tsx` -- show approval badge on tasks with pending reviews
- `src/stores/orchestrationStore.ts` -- populate `ReviewPacket` when calling `onTaskApprovalNeeded`

**Acceptance criteria:**
- `ApprovalPrompt` renders below the terminal output when a session's task needs approval.
- `DiffBlock` is rendered inside `ApprovalPrompt` when the review packet contains a diff.
- Clicking "Allow" calls `onTaskApprovalResolved` and resumes the task.
- Clicking "Deny" calls a new `onTaskApprovalDenied` that fails the task and logs the decision.
- `ApprovalPrompt` disappears after the decision is recorded.

---

### Task 4: Build Review Queue Panel

**Goal:** A dedicated panel showing all pending approvals across all active flights, so the user does not have to hunt through individual sessions.

**Files to create:**
- `src/components/views/ReviewQueueView.tsx`

**Files to modify:**
- `src/stores/appStore.ts` -- add `"review_queue"` to `AppView` union type
- `src/components/layout/Toolbar.tsx` -- add Review Queue button (ShieldCheck icon)
- `src/stores/orchestrationStore.ts` -- add `getPendingApprovals()` selector

**Specification:**
- List view sorted by `requestedAt` (oldest first).
- Each row: flight name, milestone name, task name, agent name, time waiting, summary.
- Clicking a row expands to show full `ReviewPacket` details including `DiffBlock` if applicable.
- Inline Approve/Deny buttons per item.
- Badge count on toolbar button showing number of pending approvals.

**Acceptance criteria:**
- Navigating to review queue shows all tasks with `status === "approval_needed"` across all flights.
- Approving/denying from the queue updates task status identically to the inline prompt.
- Badge count updates in real time as tasks enter/exit approval state.
- Empty state message when no approvals are pending.

---

### Task 5: Persistence Migration -- Identify Store Tiers

**Goal:** Classify all 13 localStorage stores into tiers for migration priority.

No code changes. Output is a table in this document.

| Store | localStorage Key | Tier | Rationale |
|-------|-----------------|------|-----------|
| flightStore | `packetcode:flights` | **Tier 1 (Critical)** | Already dual-written to Rust and localStorage; must reconcile immediately to prevent drift |
| issueStore | `packetcode:issues` | **Tier 1 (Critical)** | Issues are linked to flights; must live alongside flights in backend |
| agentStore | `packetcode:agents` | **Tier 1 (Critical)** | Already in `PersistedState.agents`; localStorage copy is redundant |
| costStore | `packetcode:cost-entries` | **Tier 2 (Important)** | Financial data should be durable; not portable in localStorage |
| profileStore | `packetcode:profiles` | **Tier 2 (Important)** | Agent profiles affect orchestration behavior |
| promptStore | `packetcode:prompt-templates` | **Tier 2 (Important)** | User-created content worth preserving |
| memoryStore | `packetcode:memory` | **Tier 2 (Important)** | AI memory has long-term value |
| notificationStore | `packetcode:notifications` | **Tier 3 (Deferrable)** | Preferences only; small, low-risk in localStorage |
| githubStore | `packetcode:github` | **Tier 3 (Deferrable)** | Token is session-scoped anyway per CLAUDE.md |
| insightsStore | `packetcode:insights-sessions` | **Tier 3 (Deferrable)** | Chat history; nice to have but not critical |
| ideationStore | `packetcode:ideation-session` | **Tier 3 (Deferrable)** | Session-scoped analysis; ephemeral |
| moduleStore | `packetcode:modules` | **Tier 3 (Deferrable)** | Registry metadata; can be regenerated |

**Acceptance criteria:**
- Team agrees on tier assignments before migration code is written.

---

### Task 6: Eliminate Flight/Agent Dual-Write (Tier 1 Migration)

**Goal:** Remove localStorage persistence for flights and agents; make the Rust backend the single source of truth.

**Files to modify:**
- `src/stores/flightStore.ts` -- remove all `loadFromStorage("packetcode:flights")` / `saveToStorage("packetcode:flights")` calls; load initial state from Tauri `load_state` command
- `src/stores/agentStore.ts` -- remove `packetcode:agents` and `packetcode:agent-overrides` localStorage usage; use Tauri commands for persistence
- `src/lib/tauri.ts` -- ensure `loadState` / `saveState` wrappers exist and return properly typed data

**Migration path:**
1. On app startup, check if `packetcode:flights` exists in localStorage.
2. If it does AND `state.v1.json` has zero flights, import from localStorage into backend.
3. After successful import, delete the localStorage key.
4. If both have data, prefer `state.v1.json` (higher version wins), log warning.

**Acceptance criteria:**
- After migration, `localStorage.getItem("packetcode:flights")` returns `null`.
- All flight CRUD operations go through Tauri invoke calls.
- Restarting the app loads flights from `~/.packetcode/state.v1.json` only.
- No data loss during migration (verified by comparing flight counts before/after).

---

### Task 7: Add Issues to PersistedState (Tier 1 Migration)

**Goal:** Move issue persistence from localStorage to the Rust backend.

**Files to modify:**
- `src-tauri/src/core/storage.rs` -- add `issues` field to `PersistedState`
- `src-tauri/src/core/mod.rs` -- add issue types if not already present
- `src/stores/issueStore.ts` -- remove localStorage calls; hydrate from Tauri backend
- `src/lib/tauri.ts` -- add `saveIssues` / `loadIssues` wrappers if needed

**Acceptance criteria:**
- Issues persist across app restarts via `state.v1.json`.
- Flight-to-issue bidirectional links remain intact after migration.
- `packetcode:issues` localStorage key is cleaned up post-migration.

---

### Task 8: TS/Rust Contract Tests

**Goal:** Prevent TS and Rust type definitions from drifting apart.

**Files to create:**
- `src-tauri/src/core/contract_tests.rs` -- Rust tests that serialize known structs and assert JSON shape
- `src/tests/contract.test.ts` -- TS tests that parse the same JSON fixtures and assert types

**Approach:**
- Rust test: serialize a `PersistedState` with sample data to JSON, write to `test-fixtures/state.v1.fixture.json`.
- TS test: import the fixture, parse it through the TS types, assert all fields are present and correctly typed.
- CI runs both; if either fails, the contract is broken.

**Files to modify:**
- `src-tauri/Cargo.toml` -- add `serde_json` to dev-dependencies if not present
- `package.json` -- add test script if missing

**Acceptance criteria:**
- A Rust struct field rename causes the TS contract test to fail.
- A TS type field addition without a Rust counterpart causes a warning (excess fields are logged).
- Tests run in CI (or at minimum via `pnpm test` and `cargo test`).

---

### Task 9: Persistence Version Bump and Migration Logic

**Goal:** Safely evolve `state.v1.json` as new fields are added (ReviewPacket, issues, approval log).

**Files to modify:**
- `src-tauri/src/core/storage.rs` -- rename to `state.v2.json`, add migration function `migrate_v1_to_v2`

**Specification:**
- On load, check `version` field.
- If version == 1, run migration: add empty `issues`, empty `approval_log`, default any new task fields.
- If version == 2, load directly.
- Always save as version 2.

**Acceptance criteria:**
- Existing `state.v1.json` files are automatically upgraded on first load.
- No data loss during migration.
- Backup of v1 file is created before migration writes v2.

---

## Definition of Done

1. All tasks with pending approval render `ApprovalPrompt` inline with `ReviewPacket` data.
2. A Review Queue view exists and shows all pending approvals across flights.
3. Every approval/denial decision is persisted in an audit log within `state.v2.json`.
4. Flights, agents, and issues are persisted exclusively via the Rust backend (no localStorage).
5. TS/Rust contract tests exist and pass.
6. `state.v1.json` to `state.v2.json` migration runs automatically without data loss.
7. No remaining dual-write for any Tier 1 store.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Data loss during localStorage-to-backend migration** | High -- users lose flights/issues | Always read-before-delete; create localStorage backup key (`packetcode:flights-backup-v1`) before removal; migration is idempotent |
| **Dual-write race condition during migration window** | Medium -- stale data overwrites fresh | Migration runs synchronously at app startup before any store subscriptions fire; block UI until complete |
| **ReviewPacket schema churn** | Medium -- frequent changes break contract tests | Lock ReviewPacket fields in Sprint 02; additions go through version bump in Sprint 03+ |
| **ApprovalPrompt rendering in terminal context** | Medium -- xterm.js overlay complexity | Render ApprovalPrompt as a React overlay above the terminal canvas, not inside xterm.js; use absolute positioning |
| **State file corruption on crash during write** | Low -- write-with-backup already handles this | Existing tmp+bak strategy in `write_with_backup` is sufficient; verify bak file restore works in tests |
| **localStorage quota limits for large issue sets** | Low -- but real for power users | Migration to backend file removes this risk entirely |

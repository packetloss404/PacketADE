# Cooperative Flight Task Graph — Scoped Loop

Created: 2026-07-27
Status: implementation and automated release proof complete; isolated
packaged/SSH smoke remains environment-gated
Product decision: **Option B — assisted execution**

## Objective

Turn an explicitly applied Flight plan into cooperating, role-assigned tasks
without restoring an autonomous planner. PacketADE computes readiness, proposes
assignments, launches a user-approved ready batch into isolated worktrees, and
integrates accepted results onto a Flight-owned integration branch. Dependent
tasks start from that accepted state; the user's base branch is untouched until
the user lands the Flight.

## Product boundary

- Planning remains a normal read-only `AgentConversation`; the user explicitly
  applies the plan.
- PacketADE validates dependencies, roles, ownership, and assignments.
- PacketADE recommends the next ready batch. **Launch Ready Tasks** is a user
  action in assisted mode.
- Each task runs in its own worktree and branch.
- Accepted task output is integrated onto an isolated Flight integration branch.
- A dependent task cannot become ready until its dependencies are accepted and
  integrated.
- Reviewer Gate, when enabled, must pass or be explicitly overridden before a
  task can integrate and unlock dependents.
- Integration conflicts stop the affected path and enter Needs Attention; they
  are never silently resolved.
- Final landing into the user's base branch remains explicit.
- Automatic decomposition, launching, recovery, and continuous execution are
  available only through the separate, explicitly enabled autonomy policy.

## Existing substrate

PacketADE already persists milestones, tasks, dependency IDs, roles,
`ownedPaths`, Attempts, worktree targets, and coordination events. Option B
planning already parses and applies a user-refined plan. Async Flights already
provision local/SSH worktrees and launch provider-neutral agent conversations.

The missing connective tissue is task↔attempt identity, graph validation and
readiness, the Flight integration branch, accepted-result integration, and a
cooperative execution surface.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID | Item | Acceptance condition | Gate | Depends on | Status |
|---|---|---|---|---|---|
| **CG1** | Cooperative graph contract | Add an opt-in cooperative execution mode, Flight integration-branch metadata, and `taskId` on Attempts. Preserve old independent-attempt Flights losslessly. | DTO/schema and hydration tests; cargo/TS build | — | closed |
| **CG2** | Graph validation and readiness | Pure selectors reject missing dependencies/cycles and compute blocked, ready, running, review, integrated, and failed tasks deterministically. | Unit tests including cycles and mixed states | CG1 | closed |
| **CG3** | Assignment and ownership review | After applying a plan, show every task's role, agent/model, owned paths, criteria, and dependencies. Conflicting ownership or missing assignments block launch. | Component/state tests; lint/build | CG2 | closed |
| **CG4** | Flight integration branch | Create/resume a Flight-owned integration branch locally or over SSH without checking it out over the user's working tree. Persist base/head identity and verify it before mutation. | Rust local/SSH/ref-mismatch tests; cargo gates | CG1 | closed |
| **CG5** | Launch Ready Tasks | One user action launches the selected ready batch, one task per worktree, from the current integration head. Record task↔attempt links and coordination events; partial multi-target failure remains recoverable. | Store/backend tests for local, SSH, dedupe, and partial failure | CG3, CG4 | closed |
| **CG6** | Review-aware integration | Accepting a task—after Reviewer Gate pass or recorded override when enabled—integrates its branch into the Flight integration branch and unlocks dependents. Concurrent accepted tasks integrate serially under a lock. | Integration tests for pass/override/order/reload | CG5, Reviewer Gate RG6 | closed |
| **CG7** | Conflict and recovery workflow | Conflicts preserve both worktrees, mark the task/Flight Needs Attention, explain the files involved, and offer retry-after-rebase or manual resolution. No automatic conflict resolution. | Conflict fixtures and persistence tests | CG6 | closed |
| **CG8** | Cooperative Flight surface | Render the dependency graph/list, role and ownership badges, ready batch, integration-head status, and one clear Launch Ready Tasks action. Existing independent-attempt UX remains unchanged. | Component tests and visual QA | CG2–CG7 | closed |
| **CG9** | Final landing and gates | Land the reviewed integration branch through the existing Git workflow, then run full regression, local/SSH, reload, cancellation, and backward-compatibility gates. Update docs/changelog. | Vitest, lint/build, cargo check/test-no-run, manual smoke | CG1–CG8 | gated — automated proof green; isolated packaged/SSH smoke pending |

## Sequencing

```text
CG1 -> CG2 -> CG3 -> CG5 -> CG6 -> CG7 -> CG8 -> CG9
  \-------> CG4 ----/
```

Reviewer Gate RG6 is a feature dependency for review-enforced Flights, but
cooperative graphs with the gate disabled can be developed and tested earlier.

## Definition of done

- An applied plan becomes an executable, validated dependency graph.
- PacketADE can launch a user-approved batch of ready tasks.
- Every task retains worktree isolation while accepted work converges on one
  Flight-owned integration branch.
- Downstream tasks always start from accepted upstream state.
- Review failures and merge conflicts stop visibly and recoverably.
- No background scheduler or autonomous Planner is required.

## Release-proof checkpoint

The 2026-07-28 focused and full automated matrices pass. Exact evidence and the
remaining isolated packaged/SSH pickup contract are recorded in
[`flight-supervision-proof-2026-07-28.md`](./flight-supervision-proof-2026-07-28.md).

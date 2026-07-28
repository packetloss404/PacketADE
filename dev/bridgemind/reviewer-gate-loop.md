# Flight Reviewer Gate — Scoped Loop

Created: 2026-07-27
Status: implementation complete; release-like manual/SSH smoke remains gated
Product decision: **Option B — enforced gate with explicit human override**

## Objective

Give an opted-in Flight an independent, read-only reviewer after a builder
attempt finishes. The reviewer evaluates the original task, user-defined
acceptance criteria, diff, changed files, and available deterministic check
results. A failing verdict blocks normal acceptance, but the user can explicitly
override the gate with a recorded reason.

## Product boundary

- The Reviewer Gate is **off by default** and configured when a Flight launches.
- Enabling it is advance authorization to start the selected reviewer and incur
  its bounded model cost when an attempt reaches `reviewing`.
- A reviewer may inspect and report; it must not modify the attempt worktree.
- `pass` enables normal acceptance.
- `changes_requested`, `blocked`, or a reviewer runtime error keeps the attempt
  in review and presents recovery actions.
- The user may override any non-pass verdict. The override and reason are
  persisted and appended to the Flight coordination log.
- Draft PR creation may still happen for visibility. The gate controls
  PacketADE acceptance/landing, not whether a draft branch can be published.
- The Reviewer Gate does not silently merge, automatically send changes back,
  or run an unbounded builder↔reviewer repair cycle. That later behavior belongs
  behind an explicit PacketAgent worker policy.
- Do not revive the retired autonomous Flight Planner or scheduler.

## Existing substrate

| Piece | Current state |
|---|---|
| Attempt lifecycle | `AttemptStatus` already includes `reviewing`; `AttemptTile` exposes manual Accept/Reject. |
| Review data | `ReviewPacket`, `TaskValidationReport`, and `ValidationVerdict` exist for milestone tasks. |
| Review surfaces | Flight review helpers, changed-file/diff UI, and review-packet navigation exist. |
| Agent runtime | Normal `AgentConversation` sessions already support provider/model selection, local/SSH targets, and read-only plan mode. |
| Persistence | Flight and Attempt data round-trip through Rust DTOs and `state.v1.json`. |
| Coordination | Flight `coordinationLog` already supports `review_requested` and schema-flexible metadata. |

The missing feature is the attempt-level policy, reviewer-session lifecycle,
structured verdict, enforcement, and override audit trail.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID | Item | Acceptance condition | Gate | Depends on | Status |
|---|---|---|---|---|---|
| **RG1** | Persisted gate contract | Add a Flight-level opt-in policy and Attempt-level gate state/report. Both survive TS↔Rust round-trips and old Flights hydrate with the gate off. | DTO/schema tests, `cargo check`, TS build | — | closed |
| **RG2** | Launch configuration | `LaunchAsyncFlightModal` can enable the gate, choose a reviewer agent/model, enter acceptance criteria, and show that a reviewer run may incur cost. Invalid/self-incompatible selections cannot launch. | Component/pure-state tests, lint/build | RG1 | closed |
| **RG3** | Review evidence bundle | Build a bounded bundle containing the task/prompt, criteria, base/head refs, diff summary, changed paths, and available check results. Oversized diffs are summarized without losing file identity. Local and SSH targets are supported. | Focused unit tests for bounds/local/SSH/error cases | RG1 | closed |
| **RG4** | Reviewer lifecycle | When an opted-in attempt first enters `reviewing`, start exactly one normal read-only reviewer conversation against that attempt target. Persist its conversation ID and append `review_requested`. Reload/resume does not duplicate the run. | Store tests for start/dedupe/resume/cancel | RG2, RG3 | closed |
| **RG5** | Structured verdict | Parse a versioned `packetade-review-gate` block into `pass`, `changes_requested`, or `blocked`, with summary, findings, and evidence. Missing/malformed output becomes a visible gate error, never an implicit pass. | Parser fixtures and terminal-event tests | RG4 | closed |
| **RG6** | Enforce and override | Normal Accept is enabled only after `pass`. Non-pass states show findings plus Retry Reviewer, Send Findings to Builder, and Override. Override requires a reason and records actor/time/reason in the Attempt and coordination feed. | Store/component tests; direct status mutation cannot bypass policy | RG5 | closed |
| **RG7** | Bounded remediation handoff | “Send Findings to Builder” creates one explicit follow-up containing structured findings. It does not auto-run repeatedly; a subsequent reviewer retry is another user-visible bounded action. | Prompt/handoff and no-auto-loop tests | RG6 | closed |
| **RG8** | End-to-end gates and docs | Exercise disabled, pass, fail, reviewer-error, override, reload, local, and SSH paths. Update README/backlog/changelog and generated schema. | Targeted Vitest, `pnpm lint`, `pnpm build`, `cargo check`, `cargo test --no-run` | RG1–RG7 | gated |

## Sequencing

```text
RG1 -> RG2 -> RG4 -> RG5 -> RG6 -> RG7 -> RG8
  \-> RG3 ---/
```

RG1 is the persistence spine. RG2 and RG3 can proceed independently afterward.
RG4 starts the reviewer, RG5 makes its output trustworthy, and RG6 is the
actual product gate. RG7 remains deliberately user-triggered.

## Definition of done

- An opted-in Flight automatically launches one independent reviewer per
  completed attempt.
- Reviewer writes and worktree mutation are structurally disabled.
- Acceptance is blocked on anything except `pass`, unless the user records an
  explicit override.
- Every reviewer request, verdict, retry, remediation handoff, and override is
  visible and persisted.
- The feature is off by default and introduces no surprise model spend.
- No autonomous Planner or unbounded repair loop is reintroduced.

# Flight Coordination Inbox & Steering — Scoped Loop

Created: 2026-07-27
Status: implementation and automated release proof complete; isolated
packaged/SSH smoke remains environment-gated
Product decision: **Option B — structured steering inbox**

## Objective

Give each Flight a durable, structured coordination inbox. The user and agents
can post blockers, questions, findings, handoffs, artifacts, and instructions to
a task, role, attempt, or the whole Flight. PacketBench records delivery and
acknowledgement, then injects messages only through a transport-safe path.

Direct agent↔agent routing is not the default. It becomes available only when
the Flight's bounded YOLO policy explicitly authorizes it.

## Existing substrate

- `Flight.coordinationLog` already persists visible events.
- The PacketBench MCP provider already exposes Flight/task state and opt-in
  append-only `append_handoff` / `escalate` writes.
- API conversations already support follow-up turns; sidecar protocol v11
  retains `inject_user_turn`.
- Flight tasks and Attempts already identify roles, agent configurations,
  sessions, targets, and worktrees.

The current handoff log is a timeline, not a mailbox: it has no recipient,
delivery state, acknowledgement, queue, or safe routing contract.

## Product boundary

- Message kinds are structured: `instruction`, `question`, `answer`, `blocker`,
  `finding`, `handoff`, and `artifact`.
- Recipients are explicit: Flight, role, task, attempt, or session.
- Every message has sender provenance, timestamps, delivery status, and an
  immutable audit record.
- API conversations receive queued messages at a safe turn boundary.
- PacketBench does not silently type into an interactive PTY. PTY agents receive
  inbox visibility through the PacketBench MCP provider when connected, with a
  visible user-triggered terminal-send fallback.
- Broadcasts are expanded into bounded per-recipient deliveries and deduped.
- Agent-origin writes remain opt-in and schema/rate/size validated.
- Assisted mode lets agents report into the inbox, but the user controls
  agent-to-agent forwarding and steering actions.
- YOLO may authorize direct routing, but only within message-hop, rate, cost,
  target, and task-ownership limits.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID | Item | Acceptance condition | Gate | Depends on | Status |
|---|---|---|---|---|---|
| **CI1** | Persisted message contract | Add versioned message, sender, recipient, artifact reference, status, and acknowledgement types. Old coordination logs hydrate unchanged. | TS/Rust DTO and migration tests | — | closed |
| **CI2** | Inbox domain actions | Post, validate, expand recipients, dedupe, acknowledge, fail, retry, and archive through pure/tested actions. Bound body size, artifacts, fan-out, and rate. | Unit/property-style boundary tests | CI1 | closed |
| **CI3** | Flight inbox UI | Add unread/needs-response counts, filters, message detail, recipient picker, and one steering composer in Flight Deck. Timeline events deep-link to their inbox message. | Component/state tests and visual QA | CI2 | closed |
| **CI4** | API-agent delivery | Deliver queued messages to local/SSH API conversations at safe turn boundaries through the existing conversation contract. Reload, busy sessions, cancellation, and duplicate events cannot double-send. | Store/sidecar/in-process provider tests | CI2 | closed |
| **CI5** | MCP inbox surface | Extend the PacketBench MCP provider with scoped inbox reads, acknowledgement, and validated message posting behind `allow_writes`. Preserve bearer/origin/audit controls. | Rust MCP tool/resource and permission tests | CI2 | closed |
| **CI6** | PTY-safe workflow | Connected PTY agents can read the MCP inbox. Otherwise PacketBench offers a visible Copy or Send to Terminal action; there is no background keystroke injection. | PTY/manual-path and UI tests | CI3, CI5 | closed |
| **CI7** | Role/all steering | The command bar can target one attempt/task, a role, all running agents, or all ready tasks. Fan-out shows exact recipients before send and records per-recipient outcomes. | Fan-out/dedupe/partial-failure tests | CI3, CI4 | closed |
| **CI8** | YOLO routing adapter | The central autonomy evaluator may forward agent-origin messages without user action only when policy allows it. Enforce hop/rate/loop limits and never broaden tool authority. | Loop, self-send, flood, policy-downgrade tests | CI4, CI5; Autonomy AP4 | closed |
| **CI9** | End-to-end gates and docs | Exercise user→agent, agent→user, role broadcast, API, PTY/MCP, reload, SSH, partial failure, and YOLO-stop paths. Update docs/changelog. | Vitest, lint/build, cargo check/test-no-run, manual smoke | CI1–CI8 | gated — automated proof green; isolated packaged/SSH smoke pending |

## Sequencing

```text
CI1 -> CI2 -> CI3 -> CI7 -> CI9
             \-> CI4 -> CI8 -/
             \-> CI5 -> CI6 -/
```

## Definition of done

- A user can steer one agent or a whole Flight from one structured surface.
- Agents can report blockers, findings, questions, and handoffs without losing
  them in terminal transcripts.
- Delivery is persisted, acknowledged, deduped, and transport-aware.
- Assisted mode keeps forwarding under user control.
- YOLO routing is bounded, auditable, and unable to create message loops.

## Release-proof checkpoint

The 2026-07-28 focused and full automated matrices pass. Exact evidence and the
remaining isolated packaged/SSH pickup contract are recorded in
[`flight-supervision-proof-2026-07-28.md`](./flight-supervision-proof-2026-07-28.md).

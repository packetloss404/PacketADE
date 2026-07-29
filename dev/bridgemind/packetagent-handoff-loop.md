# PacketAgent Deploy & Supervise Handoff — PacketADE Loop

Created: 2026-07-27
Last updated: 2026-07-29
Status: W9 published; PacketADE Flight consumer source implemented; live
cross-repository continuation and remaining contract/UI slices gated
Product decision: **Option B — deploy and supervise**

## Objective

PacketADE can turn approved development work into a bounded PacketAgent Worker,
deploy and activate it, follow its durable progress, and reconnect after
PacketADE restarts. PacketAgent owns execution and remains alive when PacketADE
closes; PacketADE remains the planning and supervision cockpit.

The receiving contract is designed in
`D:\projects\PacketAgent\dev\packetade-packetagent-handoff.md` and implemented by
PacketAgent backlog loop W9. This document owns only the PacketADE side and the
cross-repository compatibility gates.

PacketAgent implementation remains active in its own repository and Codex
project. W9 was published at
`dd8a5c93779a9ecc8af96bb232adcb5be0bdf16e`; PacketADE pins that revision and
verifies the PacketAgent-owned v1 fixture digest. No PacketAgent source is
modified here.

## Product boundary

- Entry actions are **Deploy to PacketAgent**, **Keep running**, and
  **Inspect in PacketAgent**.
- Sources may be a Flight, task/attempt, or normal AgentConversation, but every
  source becomes one explicit, versioned Worker package.
- The handoff includes provenance, objective, instructions, repository/revision,
  execution target references, artifacts, acceptance criteria, and the selected
  autonomy/review/escalation policy.
- Secret values never cross the wire. Packages contain PacketAgent credential
  references only.
- PacketAgent independently validates, may narrow capabilities, and rejects
  unbounded or unauthorized deployments.
- PacketADE snapshots the policy used for deployment; later Settings changes do
  not silently broaden an active Worker.
- PacketAgent owns checkpoints, leases, retries, triggers, durability, and side
  effects after activation.
- PacketADE may inspect, pause, resume, stop/revoke, and respond to approvals.
- Reconnection uses monotonic event cursors and idempotency keys; replay cannot
  duplicate a deployment or action.
- Completion returns evidence and artifact references such as a branch, draft
  PR, review report, logs, and cost—not an unverified “done” string.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`; `blocked` means the
named PacketAgent contract/runtime dependency is not yet available.

| ID | Item | Acceptance condition | Gate | Depends on | Status |
|---|---|---|---|---|---|
| **PH1** | Single-source wire contract | Consume a versioned schema generated/frozen by PacketAgent W9 rather than maintaining handwritten divergent DTOs. Add fixture compatibility in both repositories. | Cross-repo encode/decode and version-negotiation tests | PacketAgent W1, W9.1 | closed — pinned consumer + canonical digest fixture |
| **PH2** | PacketAgent connection profile | Settings can configure endpoint, authenticate without persisting plaintext secrets outside the keyring, test health, and display server/schema capabilities. | Auth, TLS/error-redaction, version-mismatch tests | PH1 | in-progress — keyring/TLS/health landed; richer capability display pending |
| **PH3** | Source package builder | Build bounded packages from a Flight, task/attempt, or conversation with repository/revision, target, artifacts, criteria, provider profile, autonomy limits, and source provenance. Reject missing bounds and unsupported local-only references. | Pure builder fixtures for all source types/local/SSH | PH1 | in-progress — bounded Flight builder landed; task/conversation and richer artifact/target inputs pending |
| **PH4** | Validate-before-deploy flow | The user sees exact requested capabilities, credential references, budgets, triggers, and validation errors before activation. Validation has no side effect. | Component/API idempotency tests | PH2, PH3; PacketAgent W9 validate | closed for Flight source |
| **PH5** | Deploy / Keep running | Deploy is idempotent; Keep running deploys then explicitly activates. Persist deployment/version/run references back onto the source without changing its local execution history. | Retry/replay/crash tests | PH4; PacketAgent W9 deploy/activate | closed in source; live replay gate pending |
| **PH6** | Durable event projection | Subscribe to ordered PacketAgent events with a persisted cursor, dedupe on reconnect, and project progress, attention, cost, checkpoints, and terminal state into Flight Deck without rewriting source truth. | SSE disconnect/replay/out-of-order tests | PH5; PacketAgent W8/W9 events | in-progress — persisted cursor polling/ack landed; SSE and richer projections pending |
| **PH7** | Supervision controls | Inspect, Pause, Resume, Stop/Revoke, and approval responses operate on the durable deployment/run and show confirmed PacketAgent state. Controls remain available after PacketADE restart. | Permission/idempotency/stale-run tests | PH6; PacketAgent W7/W9 | in-progress — inspect/pause/resume/revoke landed; W9 has no approval-response route |
| **PH8** | Evidence and return artifacts | Completion surfaces evidence, checks, cost, branch/PR/artifact references, and review verdict. Importing or landing returned code remains an explicit PacketADE action. | Artifact integrity/provenance and missing-evidence tests | PH6; PacketAgent W8/W9 | in-progress — latest evidence inspection landed; typed artifact return/landing pending |
| **PH9** | PacketAgent attention integration | Approval, blocked, budget-exhausted, failed, and cancelled events enter the PacketADE attention queue and coordination inbox with deep links to the durable run. | Projection/dedupe/deep-link tests | PH6; Coordination CI3 | queued |
| **PH10** | End-to-end contract gate | A Flight can Keep running, PacketADE can close, PacketAgent continues, and a restarted PacketADE reconnects to the same run and evidence trail. Cover policy rejection, revoke, network loss, and schema skew. | Cross-repo automated contract suite plus manual smoke | PH1–PH9 | gated — requires configured live PacketAgent |

## Sequencing

```text
PacketAgent W1-W7 -> W9 contract/runtime
                 \-> PH1 -> PH2 -> PH4 -> PH5 -> PH6 -> PH7 -> PH10
                      \-> PH3 -/              \-> PH8 -/
                                               \-> PH9 -/
```

PacketADE implementation must not simulate durability while PacketAgent W9 is
absent. UI work may use contract fixtures, but no feature is marked shipped
until the close/reconnect continuation gate passes against the real runtime.

## Definition of done

- One click can validate, deploy, activate, and follow approved work.
- PacketAgent continues after PacketADE closes.
- PacketADE reconnects without losing or duplicating events.
- Policies and credentials respect the cross-product trust boundary.
- The operator can always inspect, pause, revoke, and understand cost and stop
  reason.
- Returned code and artifacts remain reviewable before landing.

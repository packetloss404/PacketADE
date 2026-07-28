# YOLO / Bounded Autonomy Policy — Cross-Cutting Loop

Created: 2026-07-27
Status: implementation complete; release-like manual/SSH smoke remains gated

## Product decision

Keep the selected Option B behavior as PacketADE's safe default, while allowing
the user to enable **YOLO Mode** for the same capabilities. The UI may use the
plain-language YOLO label; the persisted contract is an `AutonomyPolicy`.

Settings defines the default policy. Every Flight visibly chooses:

- **Assisted** — automatic detection and recommendations; user launches,
  retries, integrates, and overrides.
- **Use Settings default** — inherits the configured default.
- **YOLO** — PacketADE may take the specifically enabled autonomous actions
  within the Flight's limits.

## Independent autonomy switches

YOLO is not one opaque permission bit. The policy independently controls:

1. **Auto-recovery** — retry or reassign stalled/failed attempts.
2. **Auto-review remediation** — send reviewer findings to the builder and
   retry review until pass or the limit is reached.
3. **Auto-run task graph** — launch newly ready tasks and integrate only
   reviewer-passed results.
4. **Tool permission posture** — remain approval-gated or explicitly allow
   tools for unattended execution. This is separate from orchestration autonomy
   so enabling scheduling does not silently broaden filesystem/shell authority.

## Required bounds and hard stops

Every YOLO policy must include:

- maximum total cost;
- maximum wall-clock duration;
- maximum retries per task;
- maximum reviewer remediation rounds;
- maximum concurrent agents;
- allowed projects/workspace roots;
- local/SSH target allowlist;
- an always-visible Pause/Stop control;
- persisted action, cost, retry, and decision history.

The following do not happen merely because YOLO is enabled:

- automatic reviewer-gate override;
- silent conflict resolution;
- final merge into a protected/base branch;
- publishing externally beyond an explicitly allowed draft-PR policy;
- credential/login changes;
- destructive actions outside the allowed workspace;
- expansion beyond the configured budget, duration, roots, or targets.

Reaching a hard stop changes the Flight to Needs Attention. That is a completed
policy outcome, not permission to silently relax the limit.

## Loop ledger

| ID | Item | Acceptance condition | Depends on | Status |
|---|---|---|---|---|
| **AP1** | Persisted policy contract | Versioned Settings default plus per-Flight snapshot/override; old state hydrates to Assisted. | Assisted feature contracts stable | closed |
| **AP2** | Settings UX | A clearly warned YOLO section exposes independent switches and required numeric/root/target limits. Unsafe or incomplete policies cannot save. | AP1 | closed |
| **AP3** | Flight opt-in UX | Launch and Flight details show Assisted / Settings default / YOLO and the exact effective policy before execution. | AP1, AP2 | closed |
| **AP4** | Central policy evaluator | One pure evaluator authorizes or denies every autonomous action and returns a structured reason. No feature reads a loose boolean directly. | AP1 | closed |
| **AP5** | Auto-recovery adapter | Escalation may perform bounded retry/reassignment through the same public action used by the one-click UI. | AP3, AP4; escalation shipped | closed |
| **AP6** | Auto-review adapter | Reviewer findings may trigger bounded builder follow-up and reviewer retry; pass is required and override is never automatic. | AP3, AP4; Reviewer Gate RG7 | closed |
| **AP7** | Auto-graph adapter | Newly ready tasks may launch and reviewer-passed branches may integrate through the same cooperative-graph actions used by assisted mode. | AP3, AP4; Cooperative Graph CG9 | closed |
| **AP8** | Supervision and kill switch | Flight Deck shows remaining limits, autonomous-action history, Pause/Resume/Stop, and the exact hard-stop reason. Reload never resumes a paused/stopped policy accidentally. | AP5–AP7 | closed |
| **AP9** | Adversarial and regression gates | Test cost/time/retry races, reload, duplicate events, policy downgrade, SSH, reviewer failure, conflicts, and stop behavior. | AP1–AP8 | gated |

## Architecture rule

Assisted and YOLO modes must call the same tested domain actions. YOLO adds a
policy-controlled caller; it must not create a second hidden scheduler,
reintroduce Planner v1, or bypass the normal retry, review, integration, and
persistence paths.

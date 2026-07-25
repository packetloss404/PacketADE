# BridgeSwarm — Orchestration Teardown

Last updated: 2026-07-24
Companion to [`bridgespace-competitive-brief.md`](./bridgespace-competitive-brief.md) and
[`swarm-orchestration-plan.md`](./swarm-orchestration-plan.md) (PacketADE's own response, mostly
shipped). Indexed from [`../competitors.md`](../competitors.md).

> ⚠️ **Sourcing.** `bridgemind.ai` / `docs.bridgemind.ai` hard-403 to automated fetching
> (Cloudflare). Every quote below is a verbatim string surfaced by WebSearch snippets from the
> official pages (`/bridgeswarm`, `/products/bridgespace`, `/changelog`) plus the two official X
> launch posts. **No independent third-party technical review of BridgeSwarm exists yet** — all
> mechanics are *vendor-asserted, not verified.*

## What it is

BridgeSwarm is BridgeMind's multi-agent orchestration layer built *inside* BridgeSpace. It turns one
prompt into a role-structured **team** of coding agents that own files, message each other, and gate
merges — as opposed to N independent agents running side by side. It is the flagship differentiator
of BridgeSpace 3.

## How it works, end to end

1. **Launch** — `Command-T` in BridgeSpace. *"Launch a swarm. Set the mission."*
2. **Set the mission** — one prompt; optionally assign roles.
3. **Decompose** — a **Coordinator** plans and divides work; *"spins up a coordinator, builders,
   scouts, and reviewers on a live mission tree."*
4. **Assign ownership** — each task gets **exclusive ownership of the files it touches**; shared
   dependencies are **sequenced automatically**.
5. **Execute in parallel** — **Builders** write, a **Scout** explores, all visible across the ≤16-pane grid.
6. **Coordinate** — agents *"message each other … hand off tasks … report back to the coordinator"*
   through a **shared mailbox**; steer *"one agent or all of them from a single command bar."*
7. **Gate** — a **Reviewer** *"gates every merge."*
8. **Ship** — *"They ship code, not chat."*

All coordination/messaging/enforcement runs locally in the desktop app via a *"proprietary
orchestration layer."*

## Role taxonomy

| Role | Count | Function (verbatim where possible) |
|---|---|---|
| **Coordinator** | 1 | *"A Coordinator plans."* Decomposes the mission onto a live mission tree; receives hand-off reports. |
| **Builders** | Many | *"Builders write."* Implementation agents; each owns its files. |
| **Scout** | ~1 | *"A Scout explores."* Codebase reconnaissance / context-gathering. |
| **Reviewer** | 1 | *"A Reviewer gates every merge."* Quality gate before integration. |

Canonical: *"Your prompt becomes a team of agent teammates — Coordinator, Builders, Scout, Reviewer.
Each owns its files, a Reviewer gates every merge."* Roles are user-**assignable**. No other role
names appear in public sources (planning folds into Coordinator, testing/QA into Reviewer).

## File ownership & conflict handling

Most-repeated claim: *"Each task exclusively owns the files it touches, so concurrent agents never
collide, and shared dependencies get sequenced automatically."*

- **Exclusive per-task file ownership** is the collision-avoidance primitive.
- **Shared dependencies are *sequenced*, not merged** — the orchestrator serializes tasks that would
  touch a common file rather than reconciling diffs afterward. Strategy = **prevention by
  scheduling**, not post-hoc merge resolution.
- ⚠️ Undocumented: ownership-violation behavior (block/queue/error?), how ownership is computed
  before an agent knows which files it will touch (static plan vs dynamic claim), lockfile vs advisory.

## Quality gate

- *"A Reviewer gates every merge"* — per-merge, not per-mission.
- One of four things the orchestration layer *"enforces: roles, file ownership, quality gates, and
  real-time coordination."* Hard-constraint framing: *"they ship code, not chat."*
- ⚠️ Undocumented: **what the Reviewer checks** (tests? lint? diff? spec?), whether it runs the
  build/test suite, what a block looks like, and whether it uses a *different model* for adversarial
  cross-review (industry-common, **unconfirmed** here).

## Coordination mechanics

- **Shared mailbox** inter-agent bus; peer messaging + hand-off + report-to-Coordinator (hierarchical
  hub + lateral worker↔worker).
- **Live mission tree** — visual decomposition with live status.
- **Single command bar** steers one agent or the whole swarm ("You operate the swarm").

## Launch / scale reality

- Trigger `Command-T`; runs entirely inside BridgeSpace (mac/Win/Linux); agents map onto the ≤16-pane grid.
- **Marketing vs reality:** launch hype = *"One prompt. Dozens of agents."* Product page = *"Most
  swarms run 3–5 agents"*, scaling with task size, hard-ceilinged by the 16-pane grid. "Dozens" is
  headline-only. The 3–5 norm likely reflects the shared-dependency serialization (parallelism
  collapses toward serial when core/shared files dominate).

## Model / agent agnosticism

*"BridgeSwarm works with Claude Code, OpenAI Codex, Gemini CLI, OpenCode, and Cursor — any
terminal-based coding agent that can follow structured ownership and review."* Launch post adds
*"Works with GPT 5.4."* It's **CLI-wrapper based** (same PTY model as PacketADE); agnosticism comes
from driving each CLI. Per-role different models are *implied* but **not confirmed**.

## Isolation — a real architectural distinction

BridgeSwarm's stated collision-avoidance is **logical file ownership + dependency sequencing**, not
"one worktree per agent." BridgeSpace *does* have worktree plumbing (changelog 3.0.84: *"Git status,
diff, branch, commit, and worktree flows"*), but the swarm pages **never say one-worktree-per-agent**.
So its isolation is finer-grained (intra-branch, advisory) but a **weaker guarantee** than a real
worktree/branch per agent.

## Comparison to PacketADE Flights + worktree attempts

PacketADE today launches **one worktree-backed attempt per selected agent** — a **parallel-*attempts***
model: N *independent* agents, isolated, unaware of each other, user picks/merges a winner.

| Dimension | PacketADE Flights (parallel attempts) | BridgeSwarm (coordinated swarm) |
|---|---|---|
| Agent relationship | Independent, isolated, competitive/redundant | Interdependent team, cooperative |
| Task decomposition | User/Flight defines attempts | **Coordinator auto-decomposes** onto a mission tree |
| Roles | Peers (same role) | **Coordinator / Builders / Scout / Reviewer** |
| Inter-agent comms | None | **Shared mailbox** — message, hand off, report |
| Isolation primitive | **One git worktree per attempt** (branch-level, hard) | Logical file ownership + sequencing (advisory, can share a tree) |
| Conflict handling | Attempts diverge; human picks/merges | Prevention by scheduling; "never collide" |
| Quality gate | External (review / CI after publish) | **In-loop Reviewer gates every merge** |
| Human control | Launch + review per attempt | **Single command bar** over a live mission tree |
| Output | Multiple competing solutions to choose from | One converged, reviewed result |

**The gap is coordination, not parallelism.** PacketADE already has the harder-to-build isolation
substrate (per-attempt worktrees — arguably a *stronger* guarantee than BridgeSwarm's advisory
ownership). What BridgeSwarm adds on top:
1. an auto-decomposing **Coordinator**,
2. **role differentiation** (esp. an in-loop **Reviewer merge gate**),
3. an **inter-agent message bus / shared mailbox** (cooperate vs compete), and
4. a **single steering surface** over a live mission tree.

## Mapping to PacketADE's existing plan

Per [`swarm-orchestration-plan.md`](./swarm-orchestration-plan.md), PacketADE has **already shipped**
most of the BridgeSwarm-equivalent primitives:

| BridgeSwarm mechanic | PacketADE status |
|---|---|
| Roles (coordinator/builder/reviewer/scout) | ✅ `TaskRole` + role badges (`flight-colors.ts` `TASK_ROLE_CONFIG`), Rust `core/flight.rs` |
| Exclusive file ownership | ✅ `ownedPaths` on tasks + Rust `owned_paths`/`create_task.rs` |
| Collision prevention | ✅ Pre-launch conflict check in orchestrator + core Rust |
| Coordination feed / hand-offs | ✅ `handoffLog[]` + handoff-log UI in `MilestonesPanel` |
| In-loop Reviewer merge gate | ⚠️ Review packets/approval exist; a swarm-time auto-gate is lighter |
| Auto-decomposing Coordinator | ❌ Not present (attempts are user-defined; autonomous planner was intentionally removed) |
| Inter-agent live message bus | ⚠️ Hand-off log is a timeline, not a live agent↔agent mailbox |
| Single steering command bar over a mission tree | ❌ Not a unified live-swarm control surface |
| Escalation / auto-reassignment | ⚠️ `blockedReason` exists; no auto-reassignment |

**To reach parity**, PacketADE would evolve Flights from "N isolated attempts at one task" toward
"one mission decomposed across cooperating role-typed agents that message each other and gate their
own merges" — while **keeping and marketing worktree isolation as a *harder* guarantee** than
BridgeSwarm's advisory ownership. The remaining net-new work is the **auto-decomposing Coordinator**,
a **live inter-agent mailbox**, an **in-loop Reviewer gate**, and a **unified swarm steering surface**.

## Competitive counters (defensible today)

- BridgeSwarm's every mechanic is **vendor-asserted and unverified** — no third-party technical review exists.
- Its parallelism **collapses toward serial** whenever shared/core files dominate (hence the 3–5 agent norm; "dozens" is headline-only).
- Its isolation is **advisory file ownership**, weaker than PacketADE's per-attempt worktrees.
- Gate criteria, violation behavior, per-role models, and long-run drift recovery are all **undocumented**.

## Sources

bridgemind.ai/bridgeswarm, /products/bridgespace, /changelog, /products/bridgespace/demo (all 403 to
fetch; via search snippets); x.com/bridgemindai status 2029929808113586217 and 2030621465477816768;
hunted.space/product/bridgespace-3; youtube.com/shorts/JGitsgOKNmY.

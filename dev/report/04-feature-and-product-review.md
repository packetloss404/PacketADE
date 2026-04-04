# FlightDeck Review - Feature And Product Review

## Product Thesis Check

FlightDeck already feels more like an ADE than an IDE add-on. The repo clearly implements:

- flights as top-level objectives
- milestones and tasks as orchestration units
- multi-agent sessions as first-class runtime objects
- attention/review concepts beyond plain terminals

That said, several of the most strategic capabilities are still partial.

## Where The Product Already Differentiates

### Strong differentiation

- provider-agnostic agent support instead of one-model lock-in
- session recovery and detached-session reattachment
- milestone-gated supervision model
- dashboard/attention framing rather than raw terminal multiplexing

### Emerging differentiation

- task/milestone abstractions can become a true control plane
- cost/tokens/results fields can become a real evidence layer
- shared Rust core can support multiple operator surfaces cleanly

## Product Gaps That Matter Most

### 1. Planning UX undershoots the data model

The model supports task dependencies and milestone validation, but the UI does not make them usable enough. That means the strongest scheduling concepts in the product are currently under-authored.

Primary evidence:

- `src/types/flight.ts`
- `src/components/views/FlightCreateWizard.tsx`
- `src/components/views/FlightDetailView.tsx`

### 2. Review loops are not evidence-rich enough

The product already knows about `review`, `approval_needed`, milestone gates, and task results. But human validation still feels too status-driven and not evidence-driven.

Missing or weak:

- explicit flight completion approval
- structured review packets
- changed file/test/result summaries
- consistent treatment of manual overrides

### 3. Session trust and operator control need to improve

Users need to know:

- what prompt/context was sent
- what repo/branch/worktree the agent is in
- whether a session really stopped
- whether an approval gate is truly active

Today, those trust signals are incomplete.

### 4. Git/workspace isolation is not first-class enough

The product stores `projectPath` and `gitBranch` on flights, but execution still leans too heavily on a global project model. That weakens the product's claim as a command center for many independent streams of agent work.

## Desktop And TUI Product Split

Current pattern:

- desktop is stronger for planning, configuration, and visual oversight
- TUI is stronger for live operations and backend-first behavior

Recommended strategy:

- keep both surfaces
- unify runtime semantics underneath them
- let each surface specialize in presentation, not state-machine behavior

## Product Readiness Call

Good for:

- internal dogfood
- power users
- design partners
- architecture validation

Not yet good for:

- broad external rollout
- unattended agent fleets without tight human supervision
- safety-sensitive source-control automation

## Product Recommendations

1. make the product's control plane real: one orchestration runtime, one review model, one session contract
2. turn planning from manual scaffolding into real decomposition, dependency authoring, and task routing
3. make review evidence-rich: prompt, diff, tests, files changed, cost, duration, errors
4. make repo/branch/worktree context explicit per flight and per session
5. preserve and deepen the current differentiators: recovery, milestone gating, agent-agnostic sessions

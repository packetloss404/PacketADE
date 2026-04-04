# FlightDeck Review - Frontend Review

## Overall Frontend Verdict

The frontend is conceptually strong and product-shaped, but it currently carries too much runtime authority. The most important issue is not styling or component polish; it is that the desktop UI owns orchestration behavior that should likely belong to a canonical backend runtime.

## Primary Frontend Findings

### High

- Orchestration and PTY lifecycle can drift apart.
  - Evidence: `src/stores/orchestrationStore.ts`
  - `pauseFlight` and `cancelFlight` do not reliably terminate linked PTYs.
- Approval state is mostly view-local.
  - Evidence: `src/components/session/TerminalPane.tsx`, `src/hooks/usePtyStateDetector.ts`, `src/stores/orchestrationStore.ts`
  - approval detection updates overlays/tabs, but not always canonical task/flight state.
- Session tabs are misleading.
  - Evidence: `src/components/layout/SessionTabBar.tsx`, `src/stores/tabStore.ts`, `src/stores/layoutStore.ts`
  - clicking a tab changes highlight state more than actual pane/session control.
- Planning UI cannot express its own model.
  - Evidence: `src/components/views/FlightCreateWizard.tsx`, `src/components/views/FlightDetailView.tsx`, `src/types/flight.ts`
  - `dependsOn` and milestone validation exist in the type system but are largely absent from authoring UX.

### Medium

- `TerminalPane` is too large and too coupled.
  - It owns xterm setup, PTY attach, transcript restore, notifications, detector state, tab updates, approval UI, and status bars.
- Persisted-state writes are scattered.
  - Evidence: `src/stores/appStore.ts`, `src/stores/layoutStore.ts`, `src/stores/agentStore.ts`, `src/stores/flightStore.ts`
  - multiple stores load/mutate/save the same persisted blob.
- Status bars can show the wrong project context.
  - Evidence: `src/components/session/TerminalPane.tsx`
  - the pane uses `effectiveProjectPath` for PTY work but passes the base/global path to status bars.
- Several UI pieces look incomplete or orphaned.
  - Evidence: `src/components/session/ApprovalPrompt.tsx`, `src/components/session/DiffBlock.tsx`, `src/hooks/useVoiceInput.ts`

### Low

- Startup routing can briefly render the wrong view before async hydration completes.
- Some controls need better accessibility semantics, especially switches/tabs.
- Shell shortcuts rely on shifted characters instead of more robust key codes.

## View-Level Assessment

### `src/components/views/FlightDeckView.tsx`

What works:

- good attention-first framing
- useful grouping of active/draft/completed work
- solid foundation for an operator dashboard

What needs work:

- dashboard summary stats do not fully match all states rendered elsewhere
- memoization around `getAttentionFlights` is already failing lint rules
- global next-action cues are trapped mostly inside this page rather than the wider shell

### `src/components/views/FlightDetailView.tsx`

What works:

- strong operational density
- milestone/task editing and orchestration controls in one place
- compact ADE-style workflow

What needs work:

- mixes planning, execution, and manual state overrides
- computed status and stored status are both used, which creates contradictions
- task editing is shallow after creation
- direct manual task/flight status mutation weakens review gates

### `src/components/views/FlightCreateWizard.tsx`

What works:

- simple 3-step flow
- low-friction fast path for creating work
- review step is directionally right

What needs work:

- placeholder "Generate Plan" risks overstating current AI-planning capability
- blank milestone/task handling can confuse users in review
- dependency editing is effectively absent
- uninstalled agents can still be assigned to planned tasks

### `src/components/views/SessionsView.tsx` and `src/components/session/TerminalPane.tsx`

What works:

- detached-session recovery is a real differentiator
- transcript replay makes reattach feel continuous
- approval banners and status bars give useful operator signals

What needs work:

- tab close can detach work instead of stopping it
- failed exits can look like successful completion
- issue-prompt events can hit multiple mounted panes
- Sessions view remains mounted offscreen, so heavy terminal logic can keep running while hidden

## Store Assessment

### `src/stores/flightStore.ts`

Strengths:

- coherent CRUD and reconciliation logic
- useful computed status model
- clean restart/live-session reconciliation path

Risks:

- milestone status can go stale after task deletion
- mirrored persistence increases race risk
- cost/result fields exist but are not meaningfully driven end to end

### `src/stores/orchestrationStore.ts`

Strengths:

- dependency-aware scheduling is explicit and understandable
- milestone gating model is strong
- launch/tick logic follows the product intent clearly

Risks:

- canonical runtime ownership is wrong layer
- pause/cancel not atomic with PTY control
- approval-needed path is incomplete
- resume logic has edge cases around milestone gating and fast exits

## Frontend Strengths Worth Preserving

- flight/task/session abstractions are already product-specific rather than generic CRUD
- dashboard and attention queue shape is good
- session recovery and transcript replay are strong UX assets
- provider-agnostic adapter model is already visible in the UI architecture

## Frontend Recommendations

1. move orchestration ownership behind a backend service boundary
2. split `TerminalPane` into focused hooks/components
3. make session state authoritative and derive tabs/panes from it
4. expose dependency editing and milestone validation in planning/detail views
5. replace shell prompt-style git actions with in-app reviewed flows

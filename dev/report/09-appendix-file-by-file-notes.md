# FlightDeck Review - Appendix: File-By-File Notes

## Frontend Hotspots

- `src/App.tsx`
  - strong hydration/recovery logic
  - could render stale/default view before hydration completes
  - keeps `SessionsView` mounted while inactive

- `src/components/layout/Toolbar.tsx`
  - useful shell actions
  - git flow is too prompt-driven and unsafe for ADE usage

- `src/components/layout/TitleBar.tsx`
  - clean custom chrome
  - maximize state can drift from native window state

- `src/components/layout/StatusBar.tsx`
  - good top-line metrics
  - should surface global next-action signals, not just passive counts

- `src/components/layout/SessionTabBar.tsx`
  - close can detach a live session instead of stopping it
  - active tab is more cosmetic than functional
  - needs better accessibility semantics

- `src/components/layout/PaneContainer.tsx`
  - simple grid logic
  - current layout is not built for many concurrent sessions

- `src/components/views/FlightDeckView.tsx`
  - good attention framing
  - lint error around memoization
  - stats/state grouping semantics are slightly inconsistent

- `src/components/views/FlightDetailView.tsx`
  - operationally powerful but too mixed in responsibility
  - combines planning, execution, review, and manual overrides

- `src/components/views/FlightCreateWizard.tsx`
  - good low-friction creation flow
  - placeholder AI plan generation
  - dependencies and validation criteria are underexposed

- `src/components/views/SessionsView.tsx`
  - detached-session recovery is a differentiator
  - when panes already exist, detached sessions become less actionable

- `src/components/views/AgentConfigView.tsx`
  - useful configuration surface
  - whitespace-splitting args is too brittle
  - detection should not be only view-driven

- `src/components/views/SettingsView.tsx`
  - helpful runtime settings
  - missing notification setup and stronger onboarding guidance

- `src/components/session/TerminalPane.tsx`
  - major hotspot
  - too much lifecycle authority and too many responsibilities
  - approval, exit, prompt routing, and project-path context all need hardening

- `src/components/session/ClaudeStatusBar.tsx`
  - useful signal density
  - hover-only details reduce accessibility

- `src/components/session/CodexStatusBar.tsx`
  - useful provider-specific insight
  - same hover-only/accessibility issues

- `src/components/session/ApprovalPrompt.tsx`
  - appears unused
  - probably indicates an unfinished approval-surface consolidation

- `src/components/session/DiffBlock.tsx`
  - appears unused
  - likely a good future fit for review packets

- `src/stores/orchestrationStore.ts`
  - central hotspot
  - clear scheduling idea, wrong authority layer
  - pause/cancel/approval/exit semantics need overhaul

- `src/stores/flightStore.ts`
  - solid domain CRUD/reconciliation
  - persistence races and stale milestone recomputation edge cases

- `src/stores/layoutStore.ts`
  - pane state is useful
  - global project path model fights with per-pane/per-flight reality

- `src/stores/tabStore.ts`
  - has room for richer session monitoring
  - currently drifts from pane/session truth

- `src/stores/costStore.ts`
  - promising but disconnected
  - can overcount day/model aggregates

- `src/hooks/usePtyStateDetector.ts`
  - valuable and differentiated
  - should feed canonical runtime events, not just local UI state

- `src/lib/tauri.ts`
  - centralized boundary is good
  - file has become too large and cross-domain
  - handwritten mapping drift risk is rising

- `src/types/flight.ts`
  - strong product-shaped model
  - model is richer than the authoring/review UX

- `src/types/agent.ts`
  - good extensibility surface
  - current UI/runtime does not honor all of it consistently

## Backend Hotspots

- `src-tauri/src/lib.rs`
  - clean app entry and command registration
  - broad capability surface deserves closer review

- `src-tauri/src/commands/pty.rs`
  - good event bridge
  - command/path/session-id inputs need tighter validation

- `src-tauri/src/commands/fs.rs`
  - useful browsing primitive
  - default inclusion of env files is unsafe

- `src-tauri/src/commands/statusline/codex.rs`
  - one of the best-tested backend areas
  - tail-scan and cache strategy will need more robustness over time

- `src-tauri/src/core/orchestrator.rs`
  - best candidate for canonical control plane
  - still has lifecycle mismatches and recovery edge cases

- `src-tauri/src/core/pty.rs`
  - major backend hotspot
  - transcript retention, path safety, and Windows resolution deserve priority

- `src-tauri/src/core/storage.rs`
  - right long-term direction
  - atomicity and migration policy need work

- `src-tauri/src/core/git.rs`
  - safe process invocation style
  - not enough ADE-specific safety rails yet

- `src-tauri/src/core/agent_config.rs`
  - good backend mirror of built-in agent data
  - duplication with frontend agent metadata should eventually be removed

- `src-tauri/src/tui/app.rs`
  - operationally capable
  - too large and too stateful in one file

## Config And Pipeline Notes

- `package.json`
  - missing frontend test script

- `.github/workflows/ci.yml`
  - good baseline CI coverage
  - audits do not fail builds

- `.github/workflows/release.yml`
  - manual tag input is not safely pinned during checkout

- `src-tauri/tauri.conf.json`
  - restrictive CSP is good
  - schema source should be aligned to the official Tauri source

## Artifact Index

- `dev/report/00-executive-summary.md`
- `dev/report/01-codebase-map.md`
- `dev/report/02-frontend-review.md`
- `dev/report/03-backend-review.md`
- `dev/report/04-feature-and-product-review.md`
- `dev/report/05-security-reliability-performance.md`
- `dev/report/06-testing-and-release-readiness.md`
- `dev/report/07-debate-and-consensus.md`
- `dev/report/08-prioritized-recommendations.md`
- `dev/report/09-appendix-file-by-file-notes.md`
- `dev/report/index.html`

# FlightDeck Review - Codebase Map

## Repo Shape

- Frontend root: `src/`
- Backend/TUI root: `src-tauri/src/`
- Desktop stack: React 19 + TypeScript + Zustand + Tauri v2
- Backend stack: Rust + Tauri commands + shared core + Ratatui TUI
- Approximate reviewed scope: about 188 files excluding generated/vendor output

## Execution And Validation Entry Points

- Frontend scripts: `package.json`
  - `pnpm dev`
  - `pnpm build`
  - `pnpm lint`
  - `pnpm format`
- Rust crate config: `src-tauri/Cargo.toml`
- Desktop config: `src-tauri/tauri.conf.json`
- CI: `.github/workflows/ci.yml`
- Release: `.github/workflows/release.yml`

## Frontend Architecture Map

### Shell And Navigation

- `src/App.tsx` - composition root, hydration, live PTY reconciliation, shortcuts, view switching
- `src/main.tsx` - React bootstrap
- `src/components/layout/TitleBar.tsx` - native window chrome
- `src/components/layout/Toolbar.tsx` - project, theme, git, navigation
- `src/components/layout/StatusBar.tsx` - status strip

### Main Views

- `src/components/views/FlightDeckView.tsx` - dashboard and attention queue
- `src/components/views/FlightDetailView.tsx` - flight planning and orchestration surface
- `src/components/views/FlightCreateWizard.tsx` - creation/planning flow
- `src/components/views/SessionsView.tsx` - live sessions and pane workspace
- `src/components/views/AgentConfigView.tsx` - agent detection and config
- `src/components/views/SettingsView.tsx` - runtime settings

### Session/Terminal Layer

- `src/components/session/TerminalPane.tsx` - xterm binding, PTY lifecycle, overlays, notifications, transcript recovery
- `src/components/session/ClaudeStatusBar.tsx`
- `src/components/session/CodexStatusBar.tsx`
- `src/components/session/ApprovalPrompt.tsx` - currently appears unused
- `src/components/session/DiffBlock.tsx` - currently appears unused

### Stores

- `src/stores/flightStore.ts` - flights/milestones/tasks CRUD, computed status, persistence
- `src/stores/orchestrationStore.ts` - scheduling and runtime orchestration
- `src/stores/layoutStore.ts` - panes, project path, active pane
- `src/stores/tabStore.ts` - session tab state
- `src/stores/agentStore.ts` - built-in/custom agent config and detection
- `src/stores/appStore.ts` - current view, theme, selected flight
- `src/stores/statusLineStore.ts` - Claude/Codex status snapshots
- `src/stores/activityStore.ts`, `src/stores/costStore.ts`, `src/stores/notificationStore.ts`, `src/stores/profileStore.ts`

### Hooks And Shared TS Layer

- `src/hooks/usePtyStateDetector.ts` - PTY state parsing
- `src/hooks/useGitInfo.ts` - git branch polling
- `src/hooks/useStatusLine.ts` and `src/hooks/useStatusLinePollerBase.ts`
- `src/lib/tauri.ts` - Tauri invoke wrappers and DTO mapping
- `src/agents/` - built-in agent adapters and generic fallback
- `src/types/` - domain and agent types

## Backend Architecture Map

### Tauri Entry And Commands

- `src-tauri/src/lib.rs` - app builder, command registration, plugin setup
- `src-tauri/src/commands/pty.rs` - PTY command surface and event bridge
- `src-tauri/src/commands/git.rs` - git commands
- `src-tauri/src/commands/agent.rs` - install detection/metadata
- `src-tauri/src/commands/fs.rs` - directory listing
- `src-tauri/src/commands/state.rs` - persisted-state load/save
- `src-tauri/src/commands/statusline/**/*.rs` - Claude/Codex status readers

### Shared Rust Core

- `src-tauri/src/core/flight.rs` - canonical domain structs/enums
- `src-tauri/src/core/orchestrator.rs` - scheduling/recovery logic
- `src-tauri/src/core/pty.rs` - process and transcript management
- `src-tauri/src/core/storage.rs` - file persistence under `~/.flightdeck`
- `src-tauri/src/core/git.rs` - git command execution
- `src-tauri/src/core/agent_config.rs` - built-in agent metadata

### Ratatui App

- `src-tauri/src/tui/app.rs` - primary TUI controller
- `src-tauri/src/tui/views/*`
- `src-tauri/src/tui/widgets/*`
- `src-tauri/src/tui/theme.rs`

## Hotspot Zones

### Frontend Hotspots

- `src/components/session/TerminalPane.tsx`
- `src/stores/orchestrationStore.ts`
- `src/stores/flightStore.ts`
- `src/components/views/FlightDetailView.tsx`
- `src/components/views/FlightCreateWizard.tsx`
- `src/lib/tauri.ts`

### Backend Hotspots

- `src-tauri/src/core/pty.rs`
- `src-tauri/src/core/orchestrator.rs`
- `src-tauri/src/core/storage.rs`
- `src-tauri/src/core/git.rs`
- `src-tauri/src/commands/statusline/codex.rs`
- `src-tauri/src/tui/app.rs`

## Review Lane Index

### Code Review Lanes

- CR1 shell/routing
- CR2 dashboard/config/settings
- CR3 planning/detail flows
- CR4 sessions UI
- CR5 pane/tab layout
- CR6 core stores
- CR7 support stores
- CR8 hooks/libs/types/agents
- CR9 Tauri commands
- CR10 Rust core models
- CR11 PTY core
- CR12 statusline backend
- CR13 TUI app
- CR14 TUI widgets/theme
- CR15 config/CI/release
- CR16 security
- CR17 performance
- CR18 reliability
- CR19 testing
- CR20 maintainability

### Senior AI Agentic Engineer Lanes

- AI1 product vision fit
- AI2 planning UX
- AI3 orchestration model
- AI4 session experience
- AI5 agent adapter strategy
- AI6 persistence/recovery
- AI7 approvals/safety
- AI8 observability
- AI9 git workflow UX
- AI10 onboarding/settings
- AI11 information architecture
- AI12 desktop/TUI split
- AI13 scalability
- AI14 review loops
- AI15 roadmap priorities
- AI16 data contracts
- AI17 operator trust/control
- AI18 collaboration future
- AI19 release readiness
- AI20 differentiation

### HTML5 Expert Lanes

- HTML1 report IA
- HTML2 interactivity
- HTML3 accessibility
- HTML4 data visualization
- HTML5 standalone file architecture
- HTML6 visual direction
- HTML7 mobile responsiveness
- HTML8 print/export
- HTML9 evidence/citation design
- HTML10 performance/maintainability

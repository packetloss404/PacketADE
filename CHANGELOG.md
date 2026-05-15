# Changelog

All notable changes to PacketADE are documented in this file. Outstanding work
lives in [`backlog.md`](./backlog.md) at the project root.

## [0.8.1] - 2026-05-15

### Added — Settings panel cleanup + missing v0.8 controls

A focused follow-up to v0.8.0 after an audit pass through the Settings panel.
Fixes three real labeling / placement bugs, surfaces the controls the v0.8
work merited but never got, and regroups Settings from 18 flat sections into
15 sensibly-stacked tabs.

#### Bug fixes
- **Composer-mode label clarified.** Settings > Agents > "Launch default"
  silently shared its backing store with the per-conversation chip in the
  agent input bar — flipping the chip permanently changed the global
  default with no signal. Relabeled to "Default launch location", added
  description copy, per-chip tooltips, and a caption that documents the
  override semantics. Behavior unchanged; vocabulary now matches reality.
- **Gemini API key hoisted.** Previously hidden inside the Dictation card.
  Moved to the unified Settings > AI Providers > API Keys list alongside
  Anthropic / OpenAI / MiniMax / OpenRouter / Ollama. DictationCard now
  shows a status badge + jump link.
- **Theme toggle added to Settings.** `useAppStore.theme` was an orphan
  store value mutated only from the Toolbar Sun/Moon button. Added
  `ThemeSettingsCard` under Settings > General with a Dark/Light segmented
  control. Toolbar toggle preserved as the high-frequency action.

#### Missing v0.8 settings shipped
- **GitHub tab (new).** Token status / Rotate / Disconnect, default merge
  strategy (merge/squash/rebase), require-confirmation toggle for
  destructive PR actions, "default new PRs to draft", and "publish Mission
  attempts as draft PRs by default" — all in one place. `PRActionBar`,
  `PRModal`, and `LaunchAsyncFlightModal` now read their defaults from
  these settings.
- **Workspace defaults.** "Default new workspaces to bypass permission
  prompts" + "Auto-detect GitHub repo on workspace creation"
  (opt-out). The auto-bind probe in `WorkspaceCreationModal` is now gated
  on the toggle.
- **Memory project scope.** Radio for "Match memory by project path"
  (Exact / Parent directory / Global) and a "Pinned patterns survive cap
  eviction" toggle. `getContextItemsForSession` and `capPatterns` honor
  both.
- **Mission auto-trailer.** Toggle + format input with placeholder help
  (`{flightId}` / `{attemptId}` / `{flightTitle}`) and a live preview.
  Backed by `OrchestratorSettings` on the Rust side; the worktree
  `prepare-commit-msg` hook now reads the live settings and only installs
  when enabled.
- **Editable dictation hotkeys.** Push-to-talk and toggle accelerators are
  now user-rebindable via in-place capture (Esc to cancel, modifier
  required for validity). `useDictationGlobalShortcuts` re-registers on
  change.
- **Subscriptions card.** Settings > AI Providers > Subscriptions surfaces
  Claude OAuth + Codex OAuth status (Ready / Login required / Expired)
  with Sign-in (opens the existing PTY login flow) and Sign-out (new
  `sign_out_provider` backend command that removes the credential file).

#### Settings IA reorganization
- 18 flat sections → 15 grouped tabs: **General** (Theme, Notifications),
  **Workspace**, **Agents** (CLI + Settings + Profiles stacked),
  **AI Providers** (API Keys + Subscriptions + Endpoints stacked),
  **AI Routing**, **Memory**, **Missions** (with auto-trailer),
  **GitHub** (new), **Issues**, **Servers**, **MCP** (Servers + Provider
  stacked), **Project Rules**, **Modules**, **Dictation**, **Advanced**
  (Crash Reports + History link + Cost Dashboard link + Prompt Templates
  editor moved out of prime real estate).
- Every prior setting reachable; no functional regressions.

### Architecture
- 2 commits (`936990a` fix + this one). Built by 6 parallel agents
  (3 round-1 fix + 3 round-2 controls/IA) with explicit file ownership.
- Frontend-only changes for most controls; Rust side touched for the
  auto-trailer config plumb (`core/orchestrator.rs`,
  `core/worktree.rs::install_prepare_commit_msg_hook`,
  `commands/flight_attempts.rs::launch_flight_async`) and the
  Subscriptions sign-out command (`commands/provider_auth.rs`).

## [0.8.0] - 2026-05-15

### Added — GitHub pane overhaul + Memory inline surfaces

A wide-coverage v0.8 drop turning the GitHub pane from a read-only viewer
into a real daily-loop surface, plus the deferred memory inline-integration
work from the v0.7 backlog.

#### GitHub — parity layer
- **PR lifecycle actions.** Merge (merge / squash / rebase), close, reopen,
  convert-to-draft / mark-ready-for-review on every PR detail. State-aware
  buttons surface only what's valid for the current PR state.
- **CI / check-run status.** A live status pill on every PR card (combined
  state with passing / failing / pending breakdown in the tooltip) plus a
  dedicated Checks tab in the PR detail listing per-workflow status, app,
  duration, and html link.
- **Issue interactivity.** Comment composer with Ctrl+Enter submit, threaded
  comment list rendering markdown bodies, close / reopen, multi-select
  assignee / label pickers and a single-select milestone picker. Open /
  Closed / All state filters and paginated lists on issues, PRs, and repos.
- **5 previously-stubbed CTAs wired end-to-end:**
  - **Plan flight** → opens the issue body as the first user turn of a new
    Mission Planner spec session.
  - **Branch from issue** → `git checkout -b issue-{n}-{slug}` in the active
    workspace.
  - **Hand off to Claude** → opens a PTY session running `claude` with the
    AI investigation result piped in as the first user input.
  - **Draft patch** → seeds a single-attempt async Flight (claude-oauth +
    sonnet-4.6) with the investigation as the brief.
  - **Save as memory** → captures the investigation as a `manual_note`
    MemoryEvent against the active project.

#### GitHub — AI features
- **PR description generator.** One-shot Claude call inside the PR creation
  modal generates a structured description from diff + commits + linked
  issues. User can edit before submitting.
- **Pre-flight AI code review.** Streaming review on the PR detail with
  structured Blocking / Asks / Nits output keyed by `file:line`. Cached per
  PR so re-opening doesn't re-burn the call.
- **"Catch me up" repo digest.** Activity-tab button with 24h / 7d / 30d
  scope chips that streams a markdown summary across the four sections
  Shipped / In progress / Needs attention / Quiet.
- **Issue triage drawer.** Bulk-suggest labels, priority (P0–P3), rationale
  and duplicate-of links across selected untriaged issues. Batches of 20
  per call. User picks what to apply.

#### GitHub — flow polish
- **PR creation modal upgrades.** Branch picker autocompletion (with the
  default branch + recent branches sorted first), draft toggle, "Closes #N"
  autofill seeded from the active issue, reviewer / label / milestone
  pickers with post-create progress per setting.
- **Diff viewer file tree.** Left-side navigator listing every changed file
  grouped by directory with +/-/M status icons; clicking scrolls the diff
  to that file. Header summary: `N files changed · +X / -Y`.
- **Read-only PR review surface.** New panel under the PR diff renders
  existing review submissions (Approved / Changes Requested / Commented
  pills) and line-comment threads grouped by file.

#### Mission Planner ↔ GitHub
- **"Publish attempts as draft PRs" Flight option.** When toggled on, every
  attempt that completes successfully pushes its worktree branch to origin
  and opens a draft PR titled `[Flight {title}] Attempt {id}` with the
  Flight objective as the body. Per-attempt link surfaces on the attempt
  tile. Failures fall through to `errorMessage` so the user sees why.
- **Workspace auto-bind to GitHub repo.** New workspaces run
  `git remote get-url origin` and stamp `{owner, repo}` onto the workspace
  record. A small linked-repo badge surfaces in the sidebar.
- **Auto-trailers on agent commits.** A `prepare-commit-msg` hook installed
  per worktree appends
  `Run-By: PacketADE mission F-<flightId> attempt A-<attemptId>` to every
  commit made inside that worktree, idempotently (existing trailer is left
  alone).

#### Memory inline surfaces
- **AgentInputArea context-preview chevron.** A small collapsible above the
  input that lists the memories about to be injected into the next user
  turn. Live-reactive to the memory store.
- **MissionsView memory chip.** Completed missions show "Brain N" with the
  count of extracted lessons; clicking deep-links into MemoryView filtered
  to that mission.
- **WorkspaceSidebar "Recent learnings" feed.** The last 5 memory events
  for the active project, with a "View all →" link.
- **`LearnedPattern.projectPath` migration.** Patterns are now
  project-scoped on extraction; legacy patterns without `projectPath`
  remain global (match every project) for back-compat.
- **Pin button wired.** Pinned patterns sort first in
  `getContextForSession` and are exempt from the `capPatterns` eviction
  limit. Star icon lights up when pinned.
- **New `manual_note` MemoryEvent variant** for human-captured knowledge
  (used by the GitHub Save-as-memory CTA and any future capture surfaces).

### Fixed (in-flight during this drop)

- **`flight_attempts.rs` lost-update races.** Four functions
  (`append_attempt`, `update_attempt_status`, `set_attempt_draft_pr`,
  `set_flight_publish_attempts_as_prs`) converted from naked
  load-mutate-save to `storage::with_state_lock`. Eliminates the silent
  write-loss window between concurrent attempts.
- **Double-publish race in `setAttemptStatus`.** A `publishingAttempts` set
  guards against re-entry, preventing duplicate draft PRs from concurrent
  status-completion calls.
- **AI streaming listener race.** `PRDescriptionButton` and
  `PRReviewPanel` now pre-allocate the session id frontend-side and attach
  all listeners BEFORE invoking the backend, so the first streamed chunks
  can't be dropped.
- **`api-agent:chunk:<sid>` contract alignment.** Every emitter (sidecar,
  api_agent, github catch-up) now publishes a raw `String` payload — no
  more mixed object-vs-string shape on the same event channel.
- **`setAttemptDraftPr` rollback.** Optimistic write to `draftPrNumber` is
  reverted on backend failure with an `errorMessage` surfacing the failure
  on the attempt tile.
- **`IssueActionBar` swallowed errors.** Each apply path now catches errors
  and renders inline; popovers stay open with a visible message instead of
  half-closing.

### Architecture
- 29 new files, 27 modified. ~10.9K LOC delta.
- Design + scope locked in [`dev/v0.8-github-and-memory.md`](./dev/v0.8-github-and-memory.md).
- Built by 8 parallel implementation agents → 2-agent peer-review pass
  (spec/UX + correctness/race) → 5 fix-up agents addressing P0s
  (PR actions and CI check-runs had to be re-shipped after silent revert
  during the parallel ramp), then commit.

### Deferred to v0.9 / v1.1
- **Authored** PR line comments + threads (read-only viewing shipped now;
  composing new threads remains).
- **Notifications inbox** (`/notifications` integration).
- **Issue → Mission auto-mirroring back to GitHub issue tree** (one-way
  hand-off shipped, bidirectional sync still risk-prone).
- **Embedding / RAG over memory** (needs a vector layer; substantial
  infra).
- **"Ask your project" memory chat tab.**
- **30-day memory digest.**

## [0.7.0] - 2026-05-15

### Added — Mission Planner v1

The headline feature: an autonomous AI Mission Planner that owns a
mission from a spec conversation through completion. One Claude
session per mission, callable tool surface, journal, safety rails,
context compaction.

#### Highlights
- **Spec-mode chat.** Click "Start a mission" → talk to a Sonnet 4.6
  planner about what you want to build. Hit Launch when ready.
- **Autonomous decomposition.** The planner breaks your spec into
  2–4 milestones + 4–10 tasks, each spawned as an executor agent in
  its own worktree. Milestones and tasks populate live on the
  mission detail pane.
- **Self-driving lifecycle.** The planner reacts to task
  completions/failures, replans on retryable errors (with
  RateLimit/Network exempted from the replan cap), and asks the
  user for input via the async approval gate when it genuinely
  needs to escalate.
- **Mission journal.** Every planner action is recorded in
  append-only markdown at
  `~/.packetade/missions/<shortId>_<id>.md`. A new Journal tab on
  the mission detail pane renders it live.
- **Cost split.** StatGrid shows Planner vs Executor spend
  separately, with a cumulative-token chip for OAuth subscriptions.
- **Safety rails.** Per-mode tool-call caps (50 / 25 / 25), task
  ceiling 60, rate-limit detection + auto-resume, kill-switch
  button, Awake-stickiness watchdog, cold-start enforcement (active
  missions flip to Paused on app restart).
- **Context compaction.** At 150K cumulative input tokens the
  planner's conversation is summarized and the session is reset
  with the summary as priming context, so multi-day missions don't
  hit the context wall.

#### Architecture
- 10 epics shipped (E1–E8 + E10) over ~14K LOC across the Rust
  backend, agent-sidecar (Node), and React frontend.
- Sidecar protocol bumped 4 → 6 (typed `inject_user_turn` +
  `planner_tool` round-trip + `rate_limited` events +
  `maxOutputTokens`).
- In-process MCP server inside the agent-sidecar exposes 7 planner
  tools to Claude (validated by spike — see
  `dev/mission-planner-spike-retro.md`).
- 9 commits, ~70 new tests (Rust unit + vitest + sidecar smokes).

#### Deferred to v1.1
See [`backlog.md`](./backlog.md) for the full list. Headlines:
- Helper planner (one-shot Opus 4.7 spawn for huge scopes).
- Back-port milestone-gating + collision-detection to the
  async-attempts execution path.
- Predictive quota awareness via response headers (if the SDK ever
  exposes them).
- Subscription-% display (no public Anthropic endpoint today).
- Crash-resilient planner sessions across app restarts.

#### Documentation
- `dev/mission-planner-plan.md` — locked design spec.
- `dev/mission-planner-spike-retro.md` — spike findings.
- `dev/mission-planner-v1-acceptance-runbook.md` — manual
  validation procedure.

---

## [0.6.0] - 2026-05-12

### Added — SSH hardening & remote workspaces (Phases 1–3)

#### Phase 1 — security & correctness
- **Sidecar SSH guard** — selecting an SSH target with `api-claude-oauth` or
  `api-openai-codex` now returns a clear error rather than silently running
  locally; matching frontend UI gate disables SSH selector when a sidecar
  provider is active (`src-tauri/src/commands/api_agent.rs`,
  `src/components/agents/AgentInputArea.tsx`).
- **Shell-escaped `buildSshArgs`** — `remoteCommand` and `remoteArgs` now run
  through `shellEscape`, closing a latent shell-injection surface
  (`src/lib/ssh.ts`).
- **Replaced TOFU host-key acceptance with explicit pinning** — three new
  Tauri commands (`ssh_fetch_fingerprint`, `ssh_pin_host`,
  `get_app_known_hosts_path`), app-managed `known_hosts` file at
  `<app_data_dir>/ssh/known_hosts`, "Verify host key" UX in `ServerFormModal`
  with SHA256 display + "Trust this host" gate. Legacy servers without a
  pinned fingerprint fall back to `accept-new` with a tracing warning.
  Persisted `host_fingerprint` field added to `ServerConfig` (TS + Rust DTO).
  Touches `src-tauri/src/commands/pty.rs`, `src-tauri/src/core/execution.rs`,
  `src/components/servers/ServerFormModal.tsx`, `src/lib/bootstrap.ts`.
- **ControlMaster hardening** — sockets moved from `~/.ssh/.pkt-cm-*.sock`
  to `<app_data_dir>/ssh-cm/` (0700, Unix only via `#[cfg(unix)]`);
  `ControlPersist` reduced from 10m to 60s
  (`src-tauri/src/core/execution.rs`).

#### Phase 2 — consolidate SSH stacks
- **Unified `ServerConfig` + `SshTarget`** onto a single canonical
  `ServerConfig` model. Deleted `src/types/ssh.ts`,
  `src/stores/sshTargetStore.ts`, `src/components/agents/SshConnectModal.tsx`.
- **`AgentInputArea`** now uses `serverStore` + `ServerSelectorPopover` for
  SSH selection. New URI scheme `ssh://<serverId>?path=<encoded>`
  in `src/lib/ssh-uri.ts` for per-conversation remote paths.
- **One-time migration** of legacy `packetade:ssh-targets` localStorage
  records into `serverStore` at app bootstrap
  (`src/lib/sshTargetMigration.ts`); preserves IDs so persisted
  `AgentConversation.sshTarget.id` references still resolve. Reads both new
  and legacy `packetcode:ssh-targets` keys, deletes both on success.
- **`flight_attempts.rs`** now propagates `host_fingerprint` end-to-end into
  `AttemptTargetSpec::Ssh`, so flight attempts honor pinning instead of
  silently degrading to TOFU.

#### Phase 3 — remote workspaces
- **"Location: Local / Remote (SSH)" step in `WorkspaceCreationModal`** —
  pick a registered server (fingerprint-verified), enter remote project path,
  see a live probe of existence / is-directory / is-git-repo.
- **`ssh_check_remote_path` Tauri command** — pinned-mode SSH probe parsing
  `DIR_GIT | DIR | FILE | MISSING` with 8s timeout
  (`src-tauri/src/commands/pty.rs`).
- **`clone_repo_remote` command** — `git clone -- <url> <dest>` over SSH with
  defense-in-depth: allowlist validators (branch / dest / repo URL all
  reject `-`-prefix and shell metacharacters), `--` flag-parsing terminator,
  `sh_quote` shell-escape on every positional arg, 10-minute
  `ssh_run_with_timeout`. 11 new unit tests for the validators.
  (`src-tauri/src/core/worktree.rs`,
  `src-tauri/src/commands/scaffold.rs`).
- **Remote git dashboard** — new `get_git_branch_remote` /
  `get_git_status_remote` commands. `GitDashboard.tsx` accepts an optional
  `serverId` prop, routes refresh to remote variants, classifies SSH errors
  (`server-missing | not-a-repo | connection | other`) with a retry button.
  Commit / push / pull / branch operations disabled with an explanatory note
  for remote workspaces (write commands deferred to a future phase).
- **`workspaceStore.createWorkspace`** validates `serverId` against
  `serverStore` and requires non-empty `remoteProjectPath`.
  `setActiveWorkspace` no longer pushes the remote path into
  `layoutStore.projectPath`.
- **DTO round-trip fix** — `tauri.ts::fromDtoWorkspace` /
  `toDtoWorkspace` now preserve `serverId` and `remoteProjectPath` (was
  silently dropping both on persistence).
- **Phase 1 host-key pinning is honored** by all four new commands.

### Fixed — remote-workspace consumer gaps
- **`CodeQualityModal`** short-circuits with "not yet supported on remote
  workspaces" message; toolbar Quality button disabled with tooltip when
  the active workspace is remote
  (`src/components/quality/CodeQualityModal.tsx`,
  `src/components/layout/Toolbar.tsx`).
- **`EditorPane`** replaced with a placeholder card for remote workspaces —
  file tabs still render so open-files state remains visible
  (`src/components/views/WorkspaceView.tsx`).
- **`MultiTargetPicker.localOptions`** filters out remote workspaces so
  flight launches can't pick a remote path as a local base
  (`src/components/flights/MultiTargetPicker.tsx`).
- **`IdeationView`** already gates remote workspaces with a "not supported
  yet" message (landed earlier in Phase 3.1).

### Added — polish & integrations
- **PacketCode CLI** wired as a built-in agent.
- **Dictation** — global hotkeys, focus-aware insertion, OS-level plugin.
- **Workspace boot performance** — local cache of workspaces, deferred
  heavy hydration on startup.
- **First-open polish** — Inter font self-hosted, branded splash, welcome
  motion, welcome rows, splash alignment, scrollbar tokens.
- **Agents pane decoupled from workspaces** — agents can run independently
  of an open workspace.

### Removed
- `src/types/ssh.ts`, `src/stores/sshTargetStore.ts`,
  `src/components/agents/SshConnectModal.tsx` (consolidated into
  `ServerConfig`).

### Tests
- All 197 vitest tests pass (incl. new `workspaceStore` cases).
- All 164 cargo `--lib` tests pass (incl. clone-validator unit tests and
  host-key pinning regression tests).

---

## [0.5.0] - 2026-05-04

### Added — Agents pane "match the best of Claude Code & Codex" initiative

Driven by a 6-agent deep-dive on Claude Code, Codex, Cursor, Windsurf,
Aider, Cline, Continue.dev, Zed, Copilot Workspace, JetBrains Junie, and
Warp; followed by a 4-agent deep-dive on the OpenAI "Codex for (almost)
everything" April 16 release + GPT-5.5 + CLI 0.107→0.128 cuts.

#### Tier 1 — visible polish
- Drag-drop and clipboard-paste images in the launcher (5 MB cap, removable thumbnail chips); image blocks land in the SDK content array on send
- `SessionHealthBar` in chat header: model · context % gauge · cumulative tokens · session $ · git branch
- Mid-turn steering: `Tab` queues a follow-up; `Alt+.` / `Alt+,` nudge the model toward thorough / fast within the same provider
- `Shift+Tab` cycles a single mode chip (`default | plan | manual | yolo`)
- New slash commands `/usage`, `/history`, `/review`, `/goal`, `/template`; saved prompt templates surface as native `/<slug>` commands
- Header context badges: provider auth, linked Mission with click-to-jump, MCP `N/M` server toggle dropdown, memory-context tooltip previewing the actual injected patterns
- One-time onboarding overlay on first Agents-view visit

#### Tier 2 — killer features
- Persistent dockable `PlanPanel` parsing Anthropic SDK `TodoWrite` and the markdown `task_list` tool
- `PendingApprovalsRollup` with "Apply / Reject / Cancel all" when 2+ pending writes or permissions stack up
- `/review` spawns a Reviewer subagent fed a unified diff of the parent conversation's pending writes — returns 🛑 Blockers / ⚠️ Concerns / 💡 Nits
- Durable agent profiles (Default / Scout / Reviewer built-ins, plus user-created); `AgentProfilesCard` editor in `Settings → Agent Profiles`
- AGENTS.md / CLAUDE.md auto-injection from the project root
- Memories panel inline editor (edit text + category, Ctrl+Enter saves)
- `RunningAgentsChip` in toolbar with live count of streaming agents, click-to-jump and stop

#### Tier 3 — sidecar protocol v3 → v4 + frontend
- Sidecar `PROTOCOL_VERSION` bumped 2 → 4
- New events: `plan_block` (structured TodoWrite mirror), `tool_output_extended` (Bash exit code + stdout/stderr; Write/Edit modified paths), `turn_summary` (running tokens between turns)
- New requests: `set_permission_mode`, `set_model`, `retry`, `cancel_pending_tools` (drains parked permission/edit prompts as denied without killing the loop)
- `StartSessionRequest` gains `attachments` and `resume`; `EditResponseRequest` gains `mergedContent` (per-hunk acceptance honored sidecar AND every in-process provider)
- `permission_request` gains `batchId`/`batchSize` for grouped rollups
- `done` payload gains `resumeToken`; persisted on the conversation
- Auto-failover heuristic on rate-limit (Opus → Sonnet → Haiku, o3 → gpt-5 → o4-mini, MiniMax → highspeed) with a one-retry-per-turn guard
- Worktree-per-conversation toggle in launcher (`.pkt-worktrees/<convId>` on a fresh `pkt/<convId>` branch)

#### Codex Spring 2026 absorption (A1–A5 + B1–B9)
- Codex `todo_list` items map to the existing `plan_block` event so PlanPanel works for Codex too
- `reasoning_tokens` + `cached_input_tokens` from `usage` flow through `turn_summary` and roll into `aggregateConversationCost` (was: under-reporting GPT-5.5 spend)
- Codex MultiAgentV2 sub-agent attribution: `turn_summary.address` (`/root/agent_a` etc.) routes child tokens into a per-address bucket on the conversation; CostDashboard rolls every bucket into the total
- AGENTS.md cascading resolver in Rust core (`core::agents_md`) walking `~/.claude/AGENTS{.override,}.md` → git-root → cwd, picking one of `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` per directory, concat with `<!-- source: <path> -->` headers, capped at 32 KiB. Honors `CLAUDE_HOME` env override for CI parity with Codex's `CODEX_HOME`
- `ProjectRulesCard` in `Settings → Project Rules` reads + writes both `AGENTS.md` and `CLAUDE.md` on save; surfaces a Unify affordance when the two files diverge; offers a starter template when neither exists
- Hover-`+` Codex-App-style diff comments: per-line `+` button in `ToolDiffView` opens an inline composer; queued comments fold into the next user turn as a `File comments:` preamble
- Smart-approval prefix-rule proposal: `PermissionPrompt` gains a fourth row "Always allow rule `<pattern>`"; one click writes the derived pattern into `conversation.allowedTools`
- Composer-mode segmented control (Local / Worktree / Cloud) replaces the binary worktree toggle; persisted via localStorage
- Right-rail tabbed mode (`AgentTabbedRail`) with Plan / Diff / Inspector tabs in a single 340 px column; toggleable from chat header
- Persistent goals bridged to Missions: new `goalStore` + `/goal` slash command + goal-bound footer in PlanPanel (Pause / Resume / Complete) + 🎯 N badge per Mission row
- `LiveSpendChip` in toolbar combining today's persisted total (analyticsStore) + live in-memory session $ across every open API conversation
- Old-model pinning per profile via `pinnedModel` field; resolves as `profile.pinnedModel ?? selectedModel ?? getDefaultModel(agent)` at launch
- Plan-with-Claude → Execute-with-Codex one-click handoff: PlanPanel "Hand off to Codex →" button when parent is Claude AND Codex auth is `ready`; spawns a fresh Codex conversation seeded with `buildHandoffPrompt(parent)` (distilled spec + plan + discussion summary, capped at 12 KiB); `parentConversationId` field wires a "← back to plan" link in the child's chat header

#### Follow-ups (F1–F10)
- Auto-resume hydrated conversations: extracted listener block into `installApiAgentListeners` helper; `sendMessage` routes the first post-restart send through `resumeApiConversation` with the stored `resumeToken`
- In-process providers honor `mergedContent` for per-hunk diff acceptance (parity with sidecar Anthropic)
- Anthropic sidecar emits `tool_output_extended` (Bash exit code + stdout/stderr; Write/Edit modifiedPaths) and `turn_summary` (running per-message tokens for live SessionHealthBar updates)

### Fixed
- **macOS title bar shows native traffic-light controls** — config switched to `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true`; `lib.rs` setup hook strips decorations at runtime on Windows + Linux so the custom chrome stays the only chrome there. `TitleBar.tsx` detects macOS via userAgent, hides the Win-style min/max/close cluster, reserves 78 px of left padding for the traffic-light area
- **Standalone `target/<profile>/packetade.exe` reported "Sidecar down"** — two stacked bugs:
  - Capability gate: `app.shell().sidecar("node")` is rejected by Tauri's permission layer unless an explicit `shell:allow-execute` entry lists `node` with `sidecar: true` (added in `74e6ba9`)
  - Per-triple Node binary missing: Tauri's shell plugin on Windows resolves `sidecar("node")` to `<exe_dir>/node-<target-triple>.exe`, not generic `node.exe`; `build.rs` now copies `binaries/node-<triple>.<ext>` into the cargo output directory at compile time (added in `8f49083`)

### Removed
- `.github/workflows/{build,ci,release}.yml` — builds and releases run locally; no GitHub Actions CI in this repo

### Sidecar protocol
- `PROTOCOL_VERSION = 4`. v4 added `cancel_pending_tools` request. v3 added typed `attachments` on `start_session` / `send_message`, `mergedContent` on `edit_response`, `batchId`/`batchSize` on `permission_request`, `resumeToken` on `done`, plus `plan_block` / `tool_output_extended` / `turn_summary` events. Old sidecars reply "Unknown request type" to v3+ requests; supervisor warns on version mismatch (does not refuse)

---

## [0.4.0] - 2026-04-11

### Added

#### Flight Deck — Mission Control Redesign
- Single-screen master-detail layout replaces the old list + drill-in pair
- Status-grouped flight list on the left (Attention, Active, Review, Draft, Done, Cancelled)
- Attention group auto-surfaces paused, failed, and approval-needed flights
- Right-pane mission control tiles: FlightHeaderTile, FlightStatStrip (cost, tokens, tasks, approvals, sessions, updated), MilestonesPanel, LiveAgentsTile, ApprovalsTile, TimelineTile
- Inline approve / deny from the per-flight Approvals tile
- Inline edit of flight title, objective, status, and priority dropdowns
- Pause / Resume / Cancel lifecycle controls on the selected flight
- "Try the AI planner →" CTA on the empty Flight Deck to surface the planner chat

#### Workspace Persistence
- Workspace view stays mounted across tab switches (Flights / Issues / Tools) — PTY sessions, scrollback, and agent state persist
- All active workspaces mount simultaneously with `display: none` toggling; switching workspaces shows different terminal sets without restarting CLIs
- Workspace creation from a flight now persists the `flightId` through `commitWorkspaces` (was silently dropping it before)
- Flight `projectPath` falls back to the global project path when empty, written back to the flight for consistency

#### First-Run Onboarding
- 3-step onboarding pane on a fresh launch: Open Folder → Pick Agents → Open Workspace / Flight Deck / Skip
- `AgentDetectionList` component showing installed / not-found / checking states for each AI CLI
- Install hint links beside each not-found CLI (Claude Code, Codex, Gemini, OpenCode docs)
- Bootstrap fires `detectInstalled()` on startup so agent availability is known before the user picks one
- Onboarding completion persisted in `localStorage` (`packetcode:onboarding-complete`)

#### Mosaic Tiling System
- React Mosaic-based draggable pane tiling replaces the fixed CSS grid
- Layout presets: 1×1, 1×2, 2×1, 2×2, 2×3, 3×2 — available in the main toolbar when a workspace is active
- Per-pane drag handle, minimize, and restore via `MosaicTile` wrapper
- Mosaic tree built from workspace pane count with sensible default preset

#### DTO Layer
- Rust API DTO module (`src-tauri/src/api/`) decoupling internal types from the TS serialization contract
- Generated TypeScript schema types (`src/generated/tauri-schema.ts`)
- Typed event name helpers (`src/lib/events.ts`)
- All Tauri commands and frontend stores refactored to use DTOs, eliminating manual snake_case/camelCase conversion

#### UI Polish
- Unified per-pane header bar: drag grip, status dot, agent icon + name, CLI pill, restart button — consolidated from three separate bars (MosaicTile drag handle, WorkspacePane agent header, TerminalHeader)
- Richer tooltips on all right-side toolbar buttons (Review, Theme, Cost, Deploy, Quality, Git, Project, Profile, Pane layout)
- Profile button now reads "Profile: Auto (Optimized)" with a descriptive tooltip
- Workspace empty state: "A Workspace is a tiled set of agent terminals scoped to one project."
- Flight Deck empty state: Flight definition + AI planner CTA
- Sidebar "PROJECTS" renamed to "RECENT FOLDERS" to remove Workspace/Project terminology overlap
- Cursor-inspired dark theme restyle

### Fixed
- **CMD window flashes on Windows** — `detect_agent` now uses `hide_window` so the `where` probes don't pop console windows; removed redundant safety-net `useEffect` in WorkspaceCreationModal
- **Memory leaking across projects** — `getContextForSession` now takes the current project path and refuses to return context scanned from a different project; memory store stamps `projectPath` on scan
- **Model names** — Claude model aliases updated to un-dated identifiers (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`) so they always resolve to the latest version
- **Launch Workspace from flight broken** — `flightId` now persists via `createWorkspace`; empty `projectPath` falls back to global path
- **Infinite re-render loops** — fixed in FlightDeckView, Toolbar, and workspace creation (unstable function selector subscriptions, inline callback refs in `useTerminalSession`)
- **PTY spawn failures and orphaned processes** — cleanup on unmount, proper exit-requested tracking
- **WebGL resource leaks** — explicit WebglAddon disposal before terminal teardown
- **CLI binary paths on Windows** — `.cmd` wrapper resolution for Claude, Codex, etc.
- **Terminal PTY output fidelity** — preserving raw byte stream integrity
- **Disabled not-installed agents in WorkspaceCreationModal** — buttons now show `opacity-50 cursor-not-allowed` with install links instead of silently failing when clicked

### Changed
- `"mission"` route removed from `AppView`; `MissionWorkspaceView.tsx` deleted — the Flight Deck is now the single entry point for flight management
- `BroadcastBar` component deleted; broadcast feature removed entirely
- Workspace toolbar, broadcast bar, and mosaic preset bar consolidated into the main toolbar
- `WorkspaceView` is always-mounted in `App.tsx` (matching the legacy `MosaicContainer` pattern) so terminals survive view switches
- `TerminalPane` accepts `renderHeader` prop for custom header injection; `TerminalHeaderRenderState` type exported
- `WorkspaceSessionConfig` extended with optional `flightId`
- `MemoryState` gains `projectPath` field; `getContextForSession` requires the current project path argument
- README updated to reflect the Workspaces vs Flight Deck split and new project layout

---

## [0.3.0] - 2026-03-16

### Added

#### Missions System
- Mission domain model with types, Zustand store, and localStorage persistence
- `missionStore` with CRUD operations, issue/session linking, and status rollup computation
- `missionId` field on issues with backward-compatible migration for existing data
- Dedicated **Missions** view: master-detail layout with mission list, search, status filter, inline create form, and full detail panel
- Inline editing of mission title, objective, status, and priority
- Mission status rollup computed from linked issue states (needs_human > blocked > done > active > draft)
- **Mission Control** supervision view: status strip with counts, attention queue for blocked/needs_human missions, active missions section, collapsible all-missions groups
- Mission Control toolbar button with live attention badge (amber count of blocked + needs_human)
- Launch Claude or Codex sessions from mission detail with context-rich prompts (mission objective + linked issues with descriptions and acceptance criteria)
- Auto-link launched sessions to the originating mission
- Mission badges on issue cards (green Target icon + truncated title)
- Mission assignment in issue detail modal (assign/remove dropdown)
- Mission filter dropdown on issue board (all / unassigned / specific mission)
- Mission selector when creating new issues
- Delete confirmation dialog for missions

#### Shared Utilities
- `src/lib/time.ts` — shared `relativeTime()` function (consolidated from 3 duplicate implementations)
- `src/lib/mission-colors.ts` — shared mission status, priority, and issue status color/label constants

### Fixed
- `useMemo` dependency array in CostDashboardView (pre-existing lint error)
- MissionControl → MissionsView navigation now syncs selected mission via store
- Consistent naming: "New Mission" / "Create Mission" labels, capitalized priorities, proper issue status labels

### Changed
- `CoreView` type expanded with `"missions"` and `"mission_control"`
- Toolbar gains Missions tab (top-level) and Control button (right section)
- Issue interface gains `missionId: string | null` with migration
- `addIssue` signature makes `missionId` optional for backward compatibility

---

## [0.2.0] - 2026-02-27

### Added

#### MCP Server Integration Hub
- View, add, edit, and delete MCP server configurations
- Global scope (`~/.claude/settings.json`) and project scope (`.mcp.json`)
- Server list grouped by scope with toggle, edit, and delete controls
- Add/Edit modal with name, command, args, environment variables, and scope selector
- Registered as a module (category: integration, icon: Plug, enabled by default)

#### Project Template Scaffolding
- "New Project" wizard with 3-step flow: template selection, configuration, result
- 6 built-in templates: Next.js, React+Vite, Python FastAPI, Rust CLI, Node Express, Blank
- Automatic tool availability detection (node, cargo, python)
- Directory picker for parent folder selection
- Auto-switches `projectPath` to newly created project on success
- "New Project" button on Welcome Screen
- Registered as a module (category: utility, icon: FolderPlus, enabled by default)

#### Deploy Pipeline
- Core deploy view with toolbar button (Rocket icon)
- Auto-detects deploy configs from `packetcode.deploy.json`, `package.json` scripts, `vercel.json`, `netlify.toml`, and `Dockerfile`
- Custom deploy config creation and persistence in `packetcode.deploy.json`
- Live terminal output via PTY for deploy commands
- Deploy run history with status tracking (running, success, failed) and duration
- Config cards with one-click deploy and history sidebar

#### Rust Backend
- `mcp.rs` — 3 commands: `read_mcp_servers`, `write_mcp_server`, `delete_mcp_server`
- `scaffold.rs` — 2 commands: `scaffold_project`, `check_scaffold_tools`
- `deploy.rs` — 2 commands: `read_deploy_config`, `create_deploy_config`

### Changed
- Added `"deploy"` to `CoreView` union type
- Updated Toolbar with Deploy button in right section
- Welcome Screen now shows "New Project" button when scaffold module is enabled
- Module registry expanded from 2 to 4 modules

---

## [0.1.0] - 2026-02-22

### Added

#### Core IDE
- Tauri v2 desktop application with custom dark theme
- Multi-pane session layout with resizable panels
- PTY-based terminal emulation using xterm.js and portable-pty
- Custom window title bar with minimize/maximize/close controls
- Keyboard shortcuts for pane switching, view navigation, and session splitting
- File explorer panel with directory tree browsing
- Project folder selector with persistent path storage
- Git branch display in toolbar and status bar

#### AI Sessions
- Claude Code CLI integration with full PTY terminal
- OpenAI Codex CLI integration with full PTY terminal
- New Session modal with CLI toggle, model selector, and prompt input
- Model selection: Opus 4.6, Opus 4.5, Sonnet 4.5, Haiku 4.5
- Real-time status line monitoring for Claude and Codex sessions
- Session tab bar for switching between active sessions
- Session history view

#### Agent Profiles
- 5 built-in agent profiles: Auto (Optimized), Speed Runner, Thorough Reviewer, Security Auditor, Refactor Pro
- Custom profile creation with name, description, icon, color, system prompt, and default model
- Profile selector in New Session modal — auto-fills model and prepends system prompt
- Quick-switch profile dropdown in toolbar
- Profile management (create/edit/delete) in Tools > Settings

#### Issue Tracker
- Kanban board with 6 columns: To Do, In Progress, QA, Done, Blocked, Needs Human
- Issue creation with title, description, priority, labels, epic, and acceptance criteria
- Drag-and-drop between columns
- Issue detail view with full metadata
- Session linking — associate issues with AI sessions
- Configurable ticket prefix and custom epics/labels
- Spec2Tick: AI-powered spec parsing into structured tickets

#### GitHub Integration
- Personal access token authentication
- Repository browser (30 most recently updated repos)
- Open issues list with search and label filtering
- Full issue detail view with metadata
- "Import to Board" — convert GitHub issues to local kanban tickets
- "Investigate with AI" — Claude analyzes issue against codebase
- Pull request creation modal (title, body, head/base branch)

#### Memory Layer
- File Map: AI codebase scan generating 1-line file summaries
- Session History: AI-powered session summarization with key decisions and modified files
- Learned Patterns: AI-extracted recurring patterns with category (architecture, convention, preference, pitfall) and confidence scores
- Memory context injection toggle in New Session modal
- Pattern and summary management (view, delete, refresh)
- Persistent storage in localStorage

#### AI Tools
- Vibe Architect: interactive AI project scaffolding and architecture design
- Insights Chat: conversational codebase Q&A with Claude
- Ideation Scanner: AI-generated feature ideas, improvements, and suggestions
- Code Quality: on-demand AI code quality analysis

#### UI/UX
- Welcome screen with quick-start actions
- Tools dropdown menu in toolbar with all features
- Status bar with session info and Claude/Codex status lines
- Error boundaries for graceful failure handling
- Dark theme with custom color tokens (bg-primary, accent-green, etc.)
- Responsive layout with collapsible panels

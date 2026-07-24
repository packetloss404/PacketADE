# Send to Monitor - Multi-Monitor Operations Plan

Last updated: 2026-05-29

Status: **Paused after planning. Do not implement until the current feature and
bug-check pass is complete.**

> **Stale surfaces (noted 2026-07-24):** this pre-refactor plan names UI that has
> since been retired — `AgentsView`/the "Agents pane" (folded into the workspace
> `ConversationTile`/`AgentChatPane`) and `ReviewQueueView`/the "Review queue"
> (no longer exists). Retarget those integration points to the current workspace
> surfaces before any implementation.

## Summary

**Send to Monitor** is PacketADE's proposed multi-window, multi-monitor
operations feature. It is intentionally not a Cursor-style agent pane popout.
The main PacketADE window remains the cockpit: navigation, provider/model
selection, agent launch, mission orchestration, permissions, settings, secrets,
and destructive controls stay there. Detached Monitor windows are focused
operational displays for selected work.

Product rule:

> PacketADE does not pop out side panels. It sends operational views to monitors.

The feature is useful for multi-display setups while reinforcing PacketADE's
identity as an agent operations desk rather than an editor with a detachable
chat panel.

## Decision Record

| Decision                                    | Current answer                                           |
| ------------------------------------------- | -------------------------------------------------------- |
| Should the Agents pane pop out?             | No. Keep the left rail anchored as the dispatch surface. |
| Should PacketADE support multiple monitors? | Yes, through Monitor windows.                            |
| Should Monitor windows be writable?         | Not in v1. Start read-only / control-lite.               |
| Should v1 support arbitrary pane detach?    | No. Only approved monitor surfaces.                      |
| Should this be implemented now?             | No. Feature is documented and paused.                    |

## Product Positioning

Use **Send to Monitor** as the action label on source surfaces:

- Agent conversation: `Send to Monitor`
- Flight: `Send to Monitor`
- Review queue: `Send to Monitor`
- Cost dashboard: `Send to Monitor`

Use **Monitor** as the detached window type:

- `Agent Monitor`
- `Flight Monitor`
- `Approval Monitor`
- `Cost Monitor`
- later: `Release Monitor`, `Provider Health Monitor`, `Workspace Monitor`

Avoid:

- `Pop out`
- `Detach chat`
- `Open side panel in new window`
- `Agent popout`

Those names invite the Cursor / VS Code comparison. `Send to Monitor` frames the
feature as an operations-floor affordance.

## V1 Scope

V1 should prove the multi-window foundation with low-risk operational views.

### In Scope

- Open or focus one detached Tauri window, initially labeled `monitor-main`.
- Route the monitor window to one focused entity at a time.
- Render a compact Monitor shell without the main left rail, toolbar, command
  palette, workspace sidebar, or global settings surfaces.
- Support read-only displays for:
  - agent conversation status and transcript
  - flight detail, tasks, and journal tail
  - pending approvals as visibility only
  - cost dashboard / guardrail status
- Provide a `Focus in Main Window` action from every Monitor window.
- Handle missing or deleted entities with calm empty states.
- Keep Monitor window close behavior separate from agent / flight / session
  lifecycle. Closing a Monitor must not stop work.

### Out of Scope for V1

- Agent prompt input from a Monitor window.
- Approval apply / reject from a Monitor window.
- Writable PTY / terminal input from a Monitor window.
- Generic "detach any pane".
- Settings, API key, provider auth, deploy, GitHub mutation, or MCP config
  access from Monitor windows.
- Automatic restore of live agent sessions after app restart.
- Native OS protocol deep links.

## Current Code Fit

The current app is a single-window shell:

- `src-tauri/tauri.conf.json` defines the main app window.
- `src-tauri/capabilities/default.json` grants capabilities only to `main`.
- `src/App.tsx` renders the full shell: `TitleBar`, `Toolbar`, `LeftRail`,
  main content, `StatusStrip`, overlays, and command palette.
- `src/stores/appStore.ts` owns primary `activeView`; Monitor routes should not
  reuse or mutate this primary navigation state.
- `src/lib/bootstrap.ts` currently forces the normal boot path toward
  `welcome` and persists UI state; Monitor windows need a boot mode that
  hydrates stores without persisting primary navigation.
- `WorkspaceView` is always mounted to keep PTY sessions alive across primary
  navigation changes.
- `src/hooks/useTerminalSession.ts` kills a PTY during unmount cleanup, so
  workspace / terminal Monitor windows require a later session attachment model
  before they are safe.

## Architecture

### Rust-Owned Window Creation

Create Monitor windows from Rust commands, not by letting arbitrary frontend
code create unmanaged windows. Rust should own label reuse, focus behavior,
route registry updates, and validation.

Proposed backend module:

```text
src-tauri/src/commands/monitor_windows.rs
```

Managed state:

```rust
MonitorWindowRegistry {
  routes_by_label: HashMap<String, MonitorRoute>,
  leases_by_label: HashMap<String, MonitorLease>,
}
```

Initial commands:

```text
open_monitor_window(route)
get_monitor_window_route(label)
close_monitor_window(label)
list_monitor_windows()
```

First implementation should use one reusable label:

```text
monitor-main
```

Behavior:

1. User clicks `Send to Monitor`.
2. Main window invokes `open_monitor_window(route)`.
3. Backend validates the route and stores it in `MonitorWindowRegistry`.
4. If `monitor-main` exists, backend emits `monitor-window:route-changed` and
   focuses/unminimizes the existing window.
5. If it does not exist, backend creates it with an app URL such as:

```text
index.html?packetadeWindow=monitor&label=monitor-main
```

References:

- Tauri WebviewWindow API:
  <https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/>
- Tauri `WebviewWindowBuilder`:
  <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html>

### Frontend Boot Split

Add a parallel monitor boot path in `src/main.tsx`:

```text
normal URL -> render <App />
packetadeWindow=monitor -> render <MonitorApp />
```

New files:

```text
src/lib/monitorRoute.ts
src/lib/monitorWindows.ts
src/components/monitor/MonitorApp.tsx
src/components/monitor/MonitorShell.tsx
```

`MonitorApp` should:

- parse the window label from the query string
- call `get_monitor_window_route(label)`
- subscribe to `monitor-window:route-changed`
- hydrate shared stores using `initializeApp({ mode: "monitor" })`
- render only focused monitor surfaces

Do not render the full `App` shell inside a Monitor window.

### Monitor Route Contract

Proposed route type:

```ts
type MonitorRoute =
  | { kind: "agent_conversation"; conversationId: string }
  | { kind: "flight"; flightId: string; tab?: "overview" | "tasks" | "journal" }
  | { kind: "approvals"; flightId?: string }
  | { kind: "cost_dashboard"; flightId?: string };
```

Later route types:

```ts
type FutureMonitorRoute =
  | { kind: "flight_attempt"; flightId: string; attemptId: string }
  | { kind: "provider_health" }
  | { kind: "release_readiness" }
  | { kind: "workspace_pane"; workspaceId: string; paneId: string };
```

Route rules:

- Unknown route kinds render a safe invalid-route state.
- Missing IDs render a safe not-found state.
- Route params are pointers into existing stores, never embedded secrets.
- URL params are not authority. Backend registry / lease validation is the
  source of truth.

## Security Model

Monitor windows must have narrower permissions than `main`.

Current `default.json` is scoped to `main`. Add a separate capability for
Monitor labels before shipping:

```text
src-tauri/capabilities/monitor.json
```

Monitor capability should include only the permissions needed for window
chrome, event listening, route hydration, and safe read APIs. Do not grant
shell, process, global shortcut, PTY write/kill, agent start/send/cancel,
approval response, GitHub mutation, deploy mutation, settings, keyring, or file
write permissions to Monitor windows.

Tauri capability docs:

<https://v2.tauri.app/security/capabilities/>

### Monitor Lease

Every opened Monitor route should create a backend-issued lease:

```ts
interface MonitorLease {
  monitorId: string;
  label: string;
  route: MonitorRoute;
  mode: "readonly";
  nonce: string;
  expiresAt?: number;
  createdAt: number;
}
```

Any Monitor-callable command should validate:

- caller window label starts with `monitor-`
- caller label has an active lease
- requested entity matches the lease route
- route kind is allowed for that command
- lease is not revoked or expired

### V1 Guardrails

- Monitor windows are observe-only by default.
- No prompt composer in Agent Monitor.
- No apply/reject buttons in Approval Monitor.
- No terminal stdin in Workspace Monitor.
- No destructive actions. Link back to main for action.
- No global command palette.
- No provider/model picker.
- No settings or secrets surfaces.
- Closing Monitor windows never stops underlying work.
- Closing or revoking a source entity pushes the Monitor into a stale state.

## Monitor Surfaces

### Agent Monitor

Best first target.

Render:

- conversation title / agent / model / provider
- status: active, idle, done, failed
- project and flight link if available
- transcript and tool cards
- pending approval count as visibility
- cost summary when available
- `Focus in Main Window`

Do not render:

- provider picker
- model picker
- prompt input
- permission controls
- `Continue in` actions
- conversation delete/archive controls

Implementation note: do not mount `AgentsView` in monitor mode. It owns the
sidebar, provider selection, and selected conversation state. Render a focused
conversation component or extract a monitor-safe read-only variant.

### Flight Monitor

Render:

- flight title / status / priority
- planner state
- current task counts
- running / blocked / approval-needed items
- journal tail
- latest coordination log
- `Focus in Main Window`

Implementation note: do not mount `FlightsView` wholesale. Extract reusable
flight detail panels that can receive `flightId`, `defaultTab`, and
`variant: "main" | "monitor"`.

### Approval Monitor

Render:

- pending permission/edit list
- linked flight/task/conversation
- time since requested
- suggested main-window action

V1 behavior:

- visibility only
- `Focus in Main Window` to approve or reject

Future behavior, if desired:

- short-lived elevated approval-capable lease
- visible "Approval-capable Monitor" chrome
- entity-bound `toolId` validation
- explicit confirmation before applying writes

### Cost Monitor

Render:

- current session/project/flight spend
- provider/model usage
- guardrail thresholds
- warnings and blocked scopes
- unknown pricing indicators

Controls:

- filtering and follow mode are ok
- threshold changes route back to main settings

## Deferred Terminal / Workspace Monitor

Terminal and workspace monitors are useful, but they should not be first.

Current risk:

- `useTerminalSession` auto-starts on mount and kills the PTY on unmount.
- A Monitor window that mounts terminal components without a separate
  attachment model could duplicate or terminate sessions unexpectedly.

Prerequisite:

- session ownership must move out of React component lifetime
- add a read-only attachment / lease model for PTY output
- input ownership must be explicit if interactive terminal monitors ever ship

Suggested future model:

```ts
interface SessionAttachment {
  sessionId: string;
  windowLabel: string;
  mode: "readonly" | "interactive";
  inputOwner?: string;
  attachedAt: number;
}
```

## Persistence and Restore

V1 can keep restore simple:

- remember last Monitor window bounds
- remember last route only for convenience
- do not auto-restart agents or flights
- after restart, show stale/unavailable if the live entity no longer exists

Later:

```ts
interface MonitorWindowRecord {
  id: string;
  tauriLabel: string;
  title: string;
  route: MonitorRoute;
  restoreOnStartup: boolean;
  lastBounds?: { x: number; y: number; width: number; height: number };
  status: "desired" | "open" | "closed" | "stale";
  lastSeenAt?: number;
}
```

Do not rely on `localStorage` alone for live coordination. Use backend registry
state and Tauri events for route changes.

Events:

```text
monitor-window:ready
monitor-window:route-changed
monitor-window:closing
monitor-window:stale
monitor-window:state-changed
```

## UX Details

Monitor window shell:

- compact title bar
- scope chip: project / flight / agent / cost
- live status indicator
- last updated timestamp
- follow/pause toggle for high-volume streams
- `Focus in Main Window`
- close/minimize/maximize

Empty states:

- `Conversation not found`
- `Flight not found`
- `This monitor is stale`
- `Session ended`
- `Open in main window`

Menu placement:

- Agent header actions menu
- Flight header / overflow menu
- Review queue toolbar
- Cost dashboard toolbar

Do not put `Send to Monitor` inside `Continue in`; that menu means external
tools and follow-on agent surfaces, not PacketADE Monitor windows.

## Implementation Sprints

Implementation is paused. When resumed, use this order.

### Sprint 1 - Window Foundation

Owner slice:

- Rust backend window registry
- Tauri command bindings
- monitor capability file
- `MonitorApp` boot path

Acceptance:

- `Send to Monitor` can open/focus `monitor-main`
- route changes update the existing Monitor window
- Monitor window does not render the main app rail/chrome
- Monitor capability is narrower than main

### Sprint 2 - Agent Monitor

Owner slice:

- `agent_conversation` route
- read-only Agent Monitor rendering
- action entry point in agent header
- not-found and ended states

Acceptance:

- active, idle, done, and failed conversations render
- pending approval count is visible
- no prompt input or approval controls appear
- `Focus in Main Window` selects the conversation in the main app

### Sprint 3 - Flight Monitor

Owner slice:

- reusable flight detail components
- `flight` route
- journal tail rendering
- task status and planner status cards

Acceptance:

- flight state updates without main navigation changes
- missing flight renders safe stale state
- no planner-control or destructive actions in monitor

### Sprint 4 - Approval and Cost Monitors

Owner slice:

- read-only approval monitor
- cost dashboard monitor variant
- route back to main for actions

Acceptance:

- pending approvals are visible and update after main-window resolution
- monitor cannot invoke approval mutation commands
- cost warnings and guardrails render read-only

### Sprint 5 - Multi-Window Expansion

Owner slice:

- dynamic labels such as `monitor-agent-<id>`
- saved bounds
- duplicate route focus behavior
- optional restore preferences

Acceptance:

- multiple monitors can watch different entities
- duplicate send focuses existing matching monitor
- unplugged/missing display falls back safely

### Sprint 6 - Workspace / Terminal Monitor Spike

Owner slice:

- PTY attachment model
- read-only terminal output monitor
- no input unless explicit ownership exists

Acceptance:

- mounting/unmounting monitor never kills PTY
- output can be mirrored without duplicate session creation
- input remains main-window-only unless explicitly elevated

## Testing Plan

Backend:

- `open_monitor_window` creates `monitor-main` once and focuses on duplicates.
- route registry updates emit `monitor-window:route-changed`.
- invalid route kinds are rejected.
- monitor command calls from wrong window label are rejected.
- stale / closed windows are removed or marked safely.

Frontend unit/component:

- route parser accepts valid monitor routes and rejects malformed ones.
- `MonitorApp` does not call primary navigation persistence.
- Agent Monitor hides prompt input and mutation actions.
- Flight Monitor renders missing-entity state.
- `Focus in Main Window` emits the expected main-window focus event/command.

Security/regression:

- Monitor window cannot call PTY write/kill commands.
- Monitor window cannot call API-agent start/send/cancel commands.
- Monitor window cannot respond to pending permissions/edits.
- malformed IDs cannot hydrate arbitrary files or sessions.
- deleted entity revokes/invalidates the Monitor view.

Manual:

1. Open PacketADE on primary monitor.
2. Start or select an API-agent conversation.
3. Click `Send to Monitor`.
4. Move Monitor window to another physical display.
5. Continue work in main window and confirm Monitor updates.
6. Close Monitor and confirm the agent continues.
7. Send a flight to Monitor and confirm the same `monitor-main` focuses and
   changes route.
8. Delete or complete the source entity and confirm stale-state behavior.

## Open Decisions

- Should v1 use only `monitor-main`, or immediately support multiple Monitor
  windows?
- Should Monitor windows close automatically when main closes?
- Should Approval Monitor ever support approving from the monitor, or always
  route back to main?
- What is the first shipped pair: Agent + Flight, or Agent + Cost?
- Should `Send to Monitor` appear in command palette?
- Should Monitor routes be deep-linkable later through an OS protocol?

## Recommendation When Resumed

Ship **Agent Monitor + Flight Monitor** first. They prove the multi-monitor
identity and the Tauri multi-window foundation without touching the risky PTY
ownership path.

Do not start with terminal/workspace monitors. They need a separate
session-attachment design before they are safe.

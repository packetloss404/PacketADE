# 01 - Product Scope

## One-Liner

PacketADE Remote Agents lets a signed-in user start, monitor, steer, approve, cancel, and resume PacketADE API-agent conversations from a phone PWA through a secure cloud relay, using the desktop app's configured providers, models, profiles, auth, workspaces, MCP servers, and permission settings.

## User-Facing Mental Model

"My desktop PacketADE is an online agent host. My phone signs into Packet Cloud and controls that host."

The user should not have to think about relay sockets, Packet Relay deployment, provider routing, sidecar processes, or local ports.

## Primary Personas

- Solo builder away from desk who wants to approve tools, send follow-up prompts, and see when work finishes.
- Power user with multiple desktops/workspaces who wants all configured PacketADE providers and models available from mobile.
- Future team lead who wants remote Flights monitoring and approval, but team/org controls are not in MVP.

## MVP Feature Set

### Account And Device

- Packet account sign-in on desktop and PWA.
- Passkey-first auth, magic-link fallback.
- Desktop "Enable Remote Agents" switch.
- Desktop host registration with display name, host id, version, last seen, and online/offline status.
- Mobile device registration.
- First mobile access requires desktop approval unless the user enables a same-account auto-trust setting later.
- Device revocation from desktop and account settings.

### Discovery

- PWA lists available PacketADE hosts.
- PWA lists workspaces/projects available on the selected host.
- PWA lists configured API providers/models from the selected host.
- PWA shows provider auth badges from the desktop (`ready`, `login_required`, `missing_key`, `service_down`, `coming_soon`).
- PWA lists profiles from the desktop.

### Conversations

- Start a new API-agent conversation from mobile.
- Continue an existing API-agent conversation.
- Stream assistant chunks, thinking, tool start/result, plan blocks, token summaries, done/error.
- Queue one follow-up prompt while a turn is active, matching desktop behavior.
- Cancel an active conversation.
- Retry last turn.
- Change model where provider supports it.
- Open/read conversation history.

### Approvals

- See permission requests.
- Approve once.
- Allow always for this session.
- Deny.
- See pending write edit summaries.
- Apply or reject edit.
- Cancel all pending tools.

### Notifications

- Web Push for "needs approval", "finished", and "failed".
- Foreground real-time updates use WebSocket, not push.

### Audit And Safety

- Audit every remote command: account id, device id, host id, command type, conversation id, result, timestamp, risk level.
- No provider secrets in cloud.
- No arbitrary remote shell in MVP.
- No generic Tauri invoke bridge.

## Explicit Non-Goals For MVP

- Native iOS app or TestFlight build.
- Raw PTY sessions.
- Full file browser/editor.
- Running agents in the cloud without desktop PacketADE online.
- Cloud-stored provider API keys or OAuth tokens.
- Team/org sharing.
- Billing plans.
- Remote deploy pipeline controls.
- Full mobile IDE.
- WebRTC direct peer mode.
- QR as the primary identity or pairing model.

## Later Feature Tracks

- Native iOS app via TestFlight.
- Mobile diff review with per-hunk accept/reject.
- Flight/issue creation and monitoring.
- Voice dictation from phone.
- File mention picker.
- Cost/time budget alerts.
- Remote PTY read-only, then tightly gated write mode.
- Cloud runner mode for GitHub repos.
- Team/org access controls.
- Optional LAN/direct WebRTC optimization.
- QR shortcut to open the current desktop session on phone.

## User Journeys

### First-Time Setup

1. User opens PacketADE desktop.
2. User opens Tools or Settings and toggles Remote Agents.
3. PacketADE asks user to sign into Packet Cloud.
4. Browser opens auth flow.
5. PacketADE receives callback/deep link and stores refresh credentials securely.
6. Desktop registers host as `Ian-PC`.
7. User opens `remote.packetade.app` on phone and signs in.
8. Phone sees `Ian-PC` but shows `Approval needed`.
9. Desktop shows "Ian's iPhone wants Remote Agents access."
10. User approves.
11. Phone opens host dashboard.

### Start Agent From Phone

1. Phone opens New Agent.
2. User picks host, workspace, profile, provider/model.
3. User enters prompt and taps Run.
4. PWA sends `conversation.start` through relay.
5. Desktop creates a first-class conversation and starts the API-agent session.
6. Desktop streams `api-agent:*` events through relay.
7. Phone renders compact chat/event cards.

### Approve While Away

1. Agent requests shell or write permission.
2. Desktop emits existing `api-agent:permission-request:{sessionId}` event.
3. Remote gateway forwards `agent.event.permission_request`.
4. Relay queues push notification.
5. User taps notification.
6. PWA opens approval card.
7. User approves once or denies.
8. Desktop receives `approval.respond_permission` and calls existing permission response path.

### Desktop Offline

1. User opens PWA.
2. Host shows offline with last seen timestamp.
3. Existing cached conversations are readable.
4. New prompts can be saved as a local draft or queued with a short TTL, but the UI clearly states "Will send when desktop reconnects."
5. No cloud execution occurs.

## Product Positioning

Remote Agents should feel more like Codex/Claude mobile remote control than like remote desktop software:

- chat-first
- approvals-first
- stateful conversations
- compact cards, not terminal logs
- desktop-owned secrets and tools
- mobile as an intent and decision surface

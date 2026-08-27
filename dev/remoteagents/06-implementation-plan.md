# 06 - Implementation Plan

## Sprint Structure

The work is sized for a six-agent implementation team. Sprints are written as checkpoints rather than calendar promises. If the team starts tomorrow, Sprint 0 and Sprint 1 can run in parallel after a kickoff.

## Sprint 0 - Foundations And Decisions

Goal: lock protocol, repo layout, feature flag, and team contracts.

Deliverables:

- Create `remoteagents/shared` with protocol schemas.
- Create `remoteagents/pwa` skeleton.
- Add a feature-isolated PacketBench protocol/control-plane skeleton to the
  standalone Rust repo at `D:\projects\packetrelay`.
- Add desktop feature flag: `remoteAgents.enabled`.
- Add docs link from `dev/README.md`.
- Decide auth provider build-vs-buy for v1.
- Decide encryption launch gate: plaintext internal only, encrypted private beta.

Checkpoint:

- Shared protocol package builds.
- `packet-relay` starts locally with its existing protocols intact and the
  PacketBench routes feature-gated.
- PWA dev server starts.
- Desktop compiles with remote feature flag off.
- Six-agent ownership map is posted.

## Sprint 1 - Relay And Host Presence

Goal: desktop and PWA can sign into dev auth, connect to the relay, and see host presence.

Rust relay (`D:\projects\packetrelay`):

- HTTPS control-plane and `/ws/host` + `/ws/device` routes.
- In-process host-room router.
- PostgreSQL migrations for accounts, hosts, devices, ACL, tickets, replay, and audit.
- WebSocket upgrade auth.
- Heartbeats.
- Host online/offline state.
- Existing bridge/broadcast/room compatibility tests remain green.

Desktop:

- `remote_agents` module.
- Outbound WebSocket client.
- reconnect/backoff.
- host registration.
- status Tauri commands for UI.

PWA:

- sign-in mock or dev auth.
- host list.
- connection state.

Checkpoint:

- Desktop connects outbound to relay.
- Phone/PWA sees host online.
- Killing desktop marks host offline.
- Revoked/unauthorized device cannot subscribe.

## Sprint 2 - Provider/Workspace/Profile Snapshots

Goal: phone can see what the desktop can run.

Desktop:

- backend provider/model snapshot exported from current provider catalog.
- provider auth statuses from `get_provider_auth_status`.
- workspace/project snapshot.
- profile snapshot.
- remote status card in PacketBench Tools/Settings.

Rust relay:

- route encrypted or plaintext dev snapshots.
- cache metadata snapshot for fast host list display.

PWA:

- provider/model/profile/workspace picker.
- auth badge rendering.
- incompatible/offline states.

Checkpoint:

- PWA can pick a real desktop workspace and provider/model.
- Missing auth displays correctly.
- No secret fields are present in relay logs or PWA devtools.

## Sprint 3 - Backend Conversation Service

Goal: conversations created from phone are first-class PacketBench conversations.

Desktop:

- `RemoteConversationService`.
- create remote API conversation.
- persist remote-created conversations.
- emit local desktop state events.
- forward `api-agent:*` events to remote.
- support send/cancel/retry/model changes.
- route mobile approval responses.

Frontend desktop:

- React store hydrates remote-created conversations.
- selected conversation can be opened on desktop.
- remote-created runs show in sidebar/history.

Checkpoint:

- PWA starts conversation.
- Desktop Agents sidebar shows it.
- Assistant stream appears on both desktop and PWA.
- Cancel from PWA stops desktop run.
- Sending from desktop updates PWA.

## Sprint 4 - Mobile Conversation UX

Goal: usable PWA MVP chat and approval loop.

PWA:

- Needs Me tab.
- Active tab.
- New Agent flow.
- Conversation screen.
- compact event cards.
- approval cards.
- cancel/retry.
- reconnect and replay.
- IndexedDB cursors/drafts.

Rust relay:

- replay buffer.
- sequence assignment.
- cursor ack.
- slow-client handling.

Checkpoint:

- User can start a run from phone, lock phone, reopen, and resume stream.
- Permission request triggers Needs Me.
- Approval from phone unblocks desktop agent.
- Duplicate reconnect does not duplicate prompts.

## Sprint 5 - Push, Audit, Security Hardening

Goal: private-beta safety baseline.

Rust relay:

- Web Push subscriptions.
- durable notification outbox and bounded Rust sender task.
- audit log.
- rate limits.
- origin validation.
- ACL enforcement tests.
- revocation disconnect.

Desktop:

- trusted device approval UI.
- revoke device UI.
- kill switch.
- local audit viewer.

PWA:

- push permission UX.
- notification deep links.
- account/device settings.

Security:

- payload encryption implemented or feature gated before private beta.
- token rotation.
- object-level auth tests.

Checkpoint:

- New phone cannot control host until desktop approval.
- Revocation stops active WebSocket and future commands.
- Push notification opens correct conversation.
- Audit row exists for every mutating command.

## Sprint 6 - Beta Polish And Release

Goal: reliable private beta.

Deliverables:

- protocol docs generated from schemas
- relay load test
- mobile browser matrix complete
- failure-mode runbook
- release checklist
- staged deploy
- beta allowlist

Checkpoint:

- 30-minute remote session with disconnects passes.
- iOS Home Screen PWA approval flow passes.
- Android installed PWA approval flow passes.
- Desktop local use unaffected when relay disabled.

## Acceptance Test

A user with PacketBench desktop running on Windows signs into Packet Cloud,
enables Remote Agents, opens the PWA on iPhone, signs in, requests access,
approves on desktop, starts an `api-openai-agents` or `api-claude-oauth`
(historical id for the API-key-backed Claude Agent SDK row) conversation against
`D:\projects\PacketADE`, receives streaming output, approves one risky tool,
cancels or completes the run, and then opens the same conversation on desktop.

Pass criteria:

- provider/model list matches desktop
- no provider secrets in cloud/PWA logs
- stream appears on phone within 2 seconds of desktop event
- approval unblocks within 2 seconds
- reconnect does not duplicate messages
- audit log complete
- desktop works normally after relay disconnect

## Implementation Risks

### Frontend-Owned Conversation Lifecycle

Risk: phone-created conversations bypass React state.

Mitigation: Sprint 3 must create backend conversation ownership and desktop update events before PWA chat deepens.

### Provider Catalog Duplicated In Frontend

Risk: PWA gets stale provider/model list.

Mitigation: backend-export provider snapshot and generate shared types.

### PWA Background Limits

Risk: iOS kills socket in background.

Mitigation: push notifications wake user, reconnect/resume on open.

### Cloud Sees Content

Risk: relay sees prompts/code before encryption.

Mitigation: internal-only plaintext allowed, encrypted payloads required for external beta.

### Sidecar Provider SSH Gap

Risk: sidecar providers cannot run SSH execution today.

Mitigation: PWA displays capability. Use API-key providers for SSH until sidecar SSH support exists.

### Large Diffs/Attachments

Risk: mobile and relay choke on large payloads.

Mitigation: preserve the relay's 64 KiB inline ceiling, use encrypted
`artifactId` references for larger content, and render mobile summaries first.

# 07 - Six-Agent Runbook

This is the kickoff plan for a six-agent team. Each agent owns a separate write area to reduce conflicts.

## Ground Rules

- Read all docs in `dev/remoteagents` before coding.
- Do not expose raw Tauri invoke over the relay.
- Do not send provider secrets to cloud or PWA.
- Keep protocol changes in shared schemas first.
- Every mutating remote command needs idempotency.
- Every cloud route/message needs auth and object-level authorization.
- Feature flag everything behind `remoteAgents.enabled`.
- Keep MVP API-agent only.

## Agent 1 - Cloud Relay And Data

Owns:

- `remoteagents/relay-worker`
- D1 migrations
- Durable Object room
- Queue producers
- cloud test harness

Tasks:

- Worker project scaffold.
- `HostRoomDO` with host/device sockets.
- Auth middleware stub.
- Host registration.
- Device subscription.
- Routing and replay buffer.
- D1 tables.
- Audit insert path.
- Revocation disconnect.

First checkpoint:

- fake desktop and fake PWA can connect and exchange envelopes through a host room.

## Agent 2 - Desktop Remote Gateway

Owns:

- `src-tauri/src/commands/remote_agents`
- desktop relay client
- desktop remote status command registration
- Tools/Settings status card backend bindings

Tasks:

- remote config/state.
- outbound WebSocket manager.
- reconnect/backoff.
- host registration payload.
- relay command dispatcher.
- local kill switch.
- status events to frontend.

First checkpoint:

- PacketADE desktop connects to fake relay and shows connected/disconnected state.

## Agent 3 - Backend Conversation Service

Owns:

- `src-tauri/src/commands/remote_agents/conversation_service.rs`
- changes needed in `src-tauri/src/commands/api_agent.rs`
- conversation persistence integration
- local desktop events for remote-created conversations

Tasks:

- backend create-conversation method.
- backend send/cancel/retry/set-model wrappers.
- map mobile launch modes to PacketADE API-agent config.
- persist snapshots.
- fan out `api-agent:*` events to remote service.
- bridge approval responses.

First checkpoint:

- fake relay command starts a real API-agent conversation and desktop UI can see it.

## Agent 4 - PWA

Owns:

- `remoteagents/pwa`
- PWA app shell
- service worker
- mobile UX components

Tasks:

- Vite/React PWA scaffold.
- auth shell.
- host list.
- New Agent flow.
- conversation view.
- event reducer.
- approval cards.
- reconnect state.
- IndexedDB cursors/drafts.

First checkpoint:

- PWA can connect to fake relay, render host list, and display a simulated stream.

## Agent 5 - Security/Auth

Owns:

- auth design implementation across cloud/PWA/desktop
- token validation
- device approval/revocation
- payload encryption spike
- security tests

Tasks:

- passkey/magic-link provider decision.
- PKCE desktop sign-in.
- trusted device ACL.
- revocation.
- WebSocket origin and authorization checks.
- encrypted payload proof-of-concept.
- audit schema review.

First checkpoint:

- untrusted device cannot access host; approved device can; revoked device is disconnected.

## Agent 6 - QA, Protocol, Docs, Release

Owns:

- `remoteagents/shared`
- protocol schemas/tests
- integration test harness
- Playwright PWA tests
- release runbooks
- docs upkeep

Tasks:

- shared TypeScript protocol schemas.
- sample envelopes.
- contract tests.
- fake relay/fake desktop/fake PWA simulator.
- E2E scenarios.
- update docs as decisions land.
- final checklist.

First checkpoint:

- one command validates against shared schema in Worker, PWA, and desktop tests.

## Parallelization Plan

Day 1:

- Agent 6 creates shared protocol package first.
- Agent 1 starts Worker/DO scaffold using draft protocol.
- Agent 2 starts desktop module behind flag.
- Agent 4 starts PWA shell with mocked protocol.
- Agent 5 starts auth/ACL threat model and dev-auth stub.
- Agent 3 maps current conversation lifecycle and creates backend service skeleton.

Day 2:

- Agent 1 and 2 connect real desktop to dev relay.
- Agent 4 connects PWA to dev relay.
- Agent 3 gets fake remote command to start local conversation.
- Agent 5 wires device approval stub.
- Agent 6 adds relay simulator and contract tests.

Day 3:

- End-to-end stream from real desktop to PWA.
- Approval response from PWA to desktop.
- Reconnect/resume baseline.
- Audit rows.

Day 4:

- Push notifications.
- Security hardening.
- Mobile polish.
- Failure-mode tests.

Day 5:

- Private-beta candidate.
- Manual iOS/Android checks.
- Docs/runbook updates.

## Tomorrow's First 90 Minutes

1. Assign owners and branches.
2. Pick the auth provider for v1 or explicitly choose dev auth for Sprint 1.
3. Agree on cloud namespace and domain placeholders.
4. Freeze Sprint 1 protocol field names.
5. Create the integration branch, recommended `codex/remote-agents-integration`.
6. Create the `remoteProtocolVersion = 1` fixture package.
7. Decide whether PWA lives in `remoteagents/pwa` or another workspace path.
8. Start with mocked crypto for smoke only while real E2EE test vectors are built.
9. Create a fake desktop and fake PWA simulator so cloud/PWA/desktop lanes can test independently.
10. End the meeting with one visible target: "trusted PWA sees desktop host online."

## Merge Order

1. Shared protocol schemas.
2. Cloud relay skeleton.
3. Desktop feature flag and no-op remote module.
4. PWA skeleton.
5. Host presence.
6. Provider/workspace/profile snapshots.
7. Backend conversation service.
8. Event fanout.
9. Approvals.
10. Push/audit/security hardening.

## Coordination Checkpoints

Twice daily:

- protocol changes
- schema version changes
- auth/ACL assumptions
- desktop command surface changes
- PWA UX blockers
- test failures

No agent should change another agent's ownership area without a handoff note.

## Definition Of Done

A story is done when:

- feature flag behavior is correct
- happy path works
- at least one negative/security test exists for auth-sensitive behavior
- logs redact content
- errors have stable codes
- docs are updated if behavior differs from this plan

## PR Boundaries

Good PR slices:

- cloud registry endpoints only
- relay host/device socket only
- desktop keyring/host identity only
- desktop approval modal only
- PWA sign-in/desktops screen only
- protocol schema package only
- E2EE test vectors only

Avoid:

- giant PRs spanning cloud, desktop, and PWA
- UI PRs that alter auth semantics
- protocol changes without fixtures
- desktop bridge changes without command authorization tests

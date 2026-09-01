# PacketBench Remote Agents

Status: **ACTIVE — Sprint 0 completed 2026-09-01** (resumed by owner decision
2026-08-27 after an eleven-day pause). Read
[`10-pause-record.md`](./10-pause-record.md) for the historical pause and
resumption record. **No blocking owner decision remains** — auth was resolved
on 2026-08-28 in favour of building passkey/magic-link into the relay, and the
E2EE pre-beta gate remains ratified. The shared protocol package, PWA skeleton,
workspace build wiring, feature-gated relay route/protocol skeleton, isolated
desktop feature flag, and Railway/PostgreSQL substrate satisfy the Sprint 0
checkpoint. Remote Agents remains disabled and fail-closed in production;
Sprint 1 host presence and product auth have not started.
Last updated: 2026-09-01

This directory is the canonical implementation brief for **PacketBench Remote Agents**: a cloud-relayed, PWA-first way to use PacketBench Agents from a phone while the desktop app keeps ownership of providers, models, secrets, workspaces, MCP config, permissions, and execution.

## Product Promise

All your PacketBench agents, providers, models, profiles, workspaces, and approvals from your phone, while secrets and tools stay on your desktop.

## Locked Direction

- **Cloud relay: yes.** The phone connects through Packet Cloud, not directly to the local network.
- **Primary UX: Packet account sign-in.** No QR as the main flow. QR can exist later as an optional shortcut to open a specific host/session.
- **Execution host: PacketBench desktop.** The cloud does not call OpenAI, Anthropic, Ollama, MCP servers, local files, SSH, or shell tools.
- **Mobile app: PWA first.** Native iOS via TestFlight is a later track after relay, auth, and mobile UX prove out.
- **Transport: WebSocket relay.** Foreground real-time channel is bidirectional WebSocket. Web Push is for notifications only.
- **MVP scope: API agents only.** Remote raw PTY and full desktop command control are explicitly out of v1.
- **Relay implementation: the standalone Rust service at `D:\projects\packetrelay`.** PacketBench extends that service with its versioned host/device protocol, HTTPS control plane, durable replay, auth, audit, and Web Push; it does not create a Cloudflare relay implementation.
- **Relay ownership: PacketBench's, as of 2026-08-27.** The relay is no longer shared with Syndicate; Remote Agents is its only consumer, and therefore carries its full build and run cost.
- **Relay deployment: Railway.** This replaces the Cloud Run deployment the relay ran while it served Syndicate. It does not reopen the 2026-08-02 relay-architecture decision.

## Why This Shape

PacketBench is not a cloud-only coding agent. Its advantage is that the desktop already has:

- configured provider rows from `src/lib/api-models.ts`
- provider auth probes in `src-tauri/src/commands/provider_auth.rs`
- API agent session commands in `src-tauri/src/commands/api_agent.rs`
- sidecar providers in `agent-sidecar/src/session-registry.ts`
- the shared `api-agent:*` event contract in `src/lib/events.ts`
- conversation UX and persistence in `src/stores/agentTaskStore.ts`
- approval queues in `src/stores/agentApprovalStore.ts`
- local/SSH execution context, MCP config, profiles, memory, Flights, and issue/workspace state

The remote feature should project that desktop capability to mobile without duplicating provider setup in the cloud.

## Documentation Map

- [remote-agents-plan.html](./remote-agents-plan.html) - single-page HTML5 war-room brief for kickoff and review
- [01-product-scope.md](./01-product-scope.md) - feature definition, MVP, non-goals, user journeys
- [02-architecture.md](./02-architecture.md) - cloud, desktop, PWA, and data-flow architecture
- [03-protocol.md](./03-protocol.md) - relay envelopes, commands, events, sequencing, idempotency
- [04-security.md](./04-security.md) - auth, device trust, encryption, revocation, threat model
- [05-pwa.md](./05-pwa.md) - PWA UX, screens, install, push, offline/reconnect behavior
- [06-implementation-plan.md](./06-implementation-plan.md) - sprints, milestones, checkpoints, ownership
- [07-six-agent-runbook.md](./07-six-agent-runbook.md) - Sprint 0 six-agent ownership split and kickoff checklist
- [08-testing.md](./08-testing.md) - unit, integration, security, load, PWA, manual iOS/Android checks
- [09-open-decisions.md](./09-open-decisions.md) - live decision ledger and dated decision log
- [10-pause-record.md](./10-pause-record.md) - historical pause/resumption record, invariants, and pickup context
- [11-transport-contract-decisions.md](./11-transport-contract-decisions.md) - accepted identity/persistence boundaries and the replay/ACK/ticket/hello/E2EE security gates that must close before Sprint 1 transport implementation
- [research-brief.md](./research-brief.md) - research synthesis and source index

## Critical Implementation Principle

Do not expose a generic remote Tauri bridge.

Remote Agents must be a narrow, audited command protocol that maps to a small set of agent operations:

- list hosts, workspaces, providers, models, profiles, conversations
- start or continue an API-agent conversation
- stream existing `api-agent:*` events
- respond to permission/edit prompts
- cancel, retry, change model, close
- observe cost/status summaries

Everything else requires a new explicit protocol command and security review.

## Source Notes

The plan incorporates current product and platform research:

- OpenAI Codex mobile/remote-agent pattern: [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- Claude Code remote-control pattern: [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
- Tokio bounded-channel behavior used by `packet-relay`: [Tokio `mpsc`](https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html)
- Tungstenite WebSocket limits used by `packet-relay`: [`WebSocketConfig`](https://docs.rs/tungstenite/latest/tungstenite/protocol/struct.WebSocketConfig.html)
- MDN PWA installability: [Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- MDN WebSocket API: [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- MDN WebAuthn/passkeys: [Web Authentication API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)
- Apple web push for installed web apps: [Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/UserNotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- OWASP WebSocket security: [WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)

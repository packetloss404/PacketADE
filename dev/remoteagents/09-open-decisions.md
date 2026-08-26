# 09 - Open Decisions

## Locked Decisions

### Primary UX

Use cloud sign-in as the main flow. Do not use QR as primary pairing. QR may be a later convenience link.

### Execution

Desktop PacketADE owns execution. Cloud relay does not call providers or run tools.

### MVP Platform

PWA first. Native iOS/TestFlight later.

### MVP Runtime Scope

API agents only. Raw PTY remote control is not in MVP.

### Transport

WebSocket relay for real-time control. Web Push for notifications only.

### Relay Architecture

Use the standalone Rust service at `D:\projects\packetrelay`. Extend it with
PacketADE-specific HTTP/WebSocket routes, PostgreSQL persistence, durable replay
and outbox processing, Web Push, audit, and object-storage references. Do not
build a second relay on Cloudflare.

### Code Location

The relay remains an independently built/deployed sibling repository at
`D:\projects\packetrelay`. Shared protocol schemas and the PWA begin under
PacketADE's `remoteagents/` workspace so desktop and mobile can evolve in
lockstep. Contract fixtures gate changes across both repositories.

## Open Decisions

### Auth Provider

Options (reframed 2026-08-16 — "buy" splits into two sub-flavors):

- hosted SaaS identity provider (Clerk/Auth0/Stytch class): vendor runs
  sign-in, passkeys, magic links, and recovery; the Rust relay only validates
  tokens. Least owned surface; per-active-user pricing after free tiers.
- self-hosted open-source IdP (Keycloak/Zitadel/Ory class): standard OIDC, no
  vendor or per-user fees, but one more service to deploy, patch, and secure.
- build passkey/magic-link auth in the Rust relay backed by PostgreSQL —
  fully owned, including the WebAuthn ceremony, session design, recovery, and
  the security review.
- compile/runtime-gated dev identity provider for internal smoke tests only

Recommendation:

- internal prototype can use explicitly dev-only auth
- private beta should use a product-grade passkey/magic-link provider or a carefully scoped in-house implementation

Decision owner: Security/Auth agent. Still OPEN as of 2026-08-16.

### Payload Encryption Timing — RESOLVED 2026-08-16

Decision (owner-ratified, 2026-08-16): the written recommendation is adopted as
the launch gate.

- plaintext (TLS-only) is permitted for local/internal development only
- encrypted agent, approval, and file payloads are a hard gate before any
  external private beta

Decision owner: project owner plus Security/Auth agent.

### Backend Conversation Persistence Shape

Options:

- keep opaque JSON conversation files and add remote wrappers
- introduce Rust DTO for `AgentConversation`
- migrate all conversation persistence backend-native

Recommendation:

- MVP: add minimal Rust DTO/snapshot for remote creation and use existing opaque persistence where possible
- Post-MVP: move conversation schema fully backend-native

Decision owner: Desktop Remote Gateway and Backend Conversation agents.

### Native iOS Strategy

Options:

- Swift native
- React Native
- Capacitor wrapper around PWA
- Tauri mobile

Recommendation:

- decide after PWA beta
- evaluate notification, backgrounding, and keychain needs first

Decision owner: project owner after PWA beta.

## Decision Log

Dated record of the Sprint-0 kickoff decisions. Auth remains the sole blocking
decision; payload-encryption timing was resolved 2026-08-16. Relay/code
location was resolved by the owner on 2026-08-02; no Cloudflare relay scaffold
should be created.

### 2026-08-02 — Rust Packet Relay selected

**Relay architecture and code location** — Resolved.

- Use and extend the standalone Rust service at `D:\projects\packetrelay`.
- Keep PacketADE host/device messages separate from inherited relay protocols.
- Use PostgreSQL for durable account/device/ticket/replay/audit/outbox state.
- Keep live routing single-instance for v1; require explicit coordination work
  before horizontal scaling.
- Keep `remoteagents/shared` and `remoteagents/pwa` in PacketADE initially.
- Cloudflare Workers, Durable Objects, D1, R2, and Queues are not the target
  implementation.

### 2026-06-15 — Sprint-0 kickoff decisions

**(a) Auth provider build-vs-buy for v1** — Open.

- See "Auth Provider" under Open Decisions for options and recommendation.
- Resolution / date: _pending_.
- Decision owner: Security/Auth agent.

**(b) Payload-encryption launch gate** — Resolved 2026-08-16.

- The written recommendation was ratified by the owner: plaintext for
  local/internal development only; encrypted agent/approval/file payloads
  required before any external private beta.
- Decision owner: project owner plus Security/Auth agent.

**(c) Code location (in-repo `remoteagents/` vs `apps/` vs separate repo)** — Resolved 2026-08-02.

- Relay: standalone `D:\projects\packetrelay` repository.
- PWA/shared schemas: PacketADE `remoteagents/` workspace initially.
- Decision owner: implementation lead.

Note: decision (a) remains BLOCKING; (b) was resolved 2026-08-16. Decision (c)
is closed and must not be reopened implicitly by creating a provider-specific
relay scaffold.

## Deferred Decisions

- team/org access model
- cloud runner mode
- billing model
- WebRTC/LAN direct mode
- remote PTY policy
- mobile file browser depth
- long-term transcript retention

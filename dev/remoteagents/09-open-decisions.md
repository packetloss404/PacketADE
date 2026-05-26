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

### Cloud Architecture

Cloudflare Workers + Durable Objects + D1 + R2 + Queues is the recommended default.

## Open Decisions

### Auth Provider

Options:

- build passkey/magic-link auth on Workers
- use Clerk/Auth0/Stytch/Supabase Auth and integrate with Workers
- use Cloudflare Access for internal beta only

Recommendation:

- internal prototype can use dev auth or Cloudflare Access
- private beta should use a product-grade passkey/magic-link provider or a carefully scoped in-house implementation

Decision owner: Security/Auth agent.

### Payload Encryption Timing

Options:

- implement before any external user
- ship private beta with TLS-only and no sensitive projects
- encrypt only diffs/tool payloads first

Recommendation:

- allow plaintext for local/internal development only
- require encrypted agent/approval/file payloads before external private beta

Decision owner: project owner plus Security/Auth agent.

### Code Location

Options:

- `remoteagents/relay-worker`, `remoteagents/pwa`, `remoteagents/shared`
- separate repos for cloud/PWA
- packages under `apps/`

Recommendation:

- start in this repo under `remoteagents/` for velocity and protocol lockstep
- split later if deployment/security boundaries need it

Decision owner: implementation lead.

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

## Deferred Decisions

- team/org access model
- cloud runner mode
- billing model
- WebRTC/LAN direct mode
- remote PTY policy
- mobile file browser depth
- long-term transcript retention


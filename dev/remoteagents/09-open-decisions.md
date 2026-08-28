# 09 - Open Decisions

Program status: **ACTIVE — resumed by owner decision 2026-08-27** (paused
2026-08-16 to 2026-08-27). See [`10-pause-record.md`](./10-pause-record.md).

## Locked Decisions

### Primary UX

Use cloud sign-in as the main flow. Do not use QR as primary pairing. QR may be a later convenience link.

### Execution

Desktop PacketBench owns execution. Cloud relay does not call providers or run tools.

### MVP Platform

PWA first. Native iOS/TestFlight later.

### MVP Runtime Scope

API agents only. Raw PTY remote control is not in MVP.

### Transport

WebSocket relay for real-time control. Web Push for notifications only.

### Relay Architecture

Use the standalone Rust service at `D:\projects\packetrelay`. Extend it with
PacketBench-specific HTTP/WebSocket routes, PostgreSQL persistence, durable replay
and outbox processing, Web Push, audit, and object-storage references. Do not
build a second relay on Cloudflare.

### Code Location

The relay remains an independently built/deployed sibling repository at
`D:\projects\packetrelay`. Shared protocol schemas and the PWA begin under
PacketBench's `remoteagents/` workspace so desktop and mobile can evolve in
lockstep. Contract fixtures gate changes across both repositories.

### Relay Ownership — RESOLVED 2026-08-27

PacketRelay is PacketBench's infrastructure. It is no longer shared with, or
driven by, Syndicate, which was separated from the Packet\* product family on
2026-08-27 (its PacketBench execution-target integration was removed in commit
`68ce85ee`). **Remote Agents is the relay's only consumer**, and therefore
carries 100% of its build and run cost — previously shared against Syndicate's
value. The sprint sizing in `06-implementation-plan.md` predates that
reweighting.

The disposition of the relay's existing `/v1/product-route` surface and its
live Syndicate deployment (retire, keep as a compatibility contract, or hand
over) is an open question **for the relay repository**, not a Remote Agents
decision. Do not break or delete that route on this program's authority.

### Relay Deployment Target — RESOLVED 2026-08-27

**Railway.** This replaces the Google Cloud Run deployment the relay ran while
it served Syndicate. `railway.json` already exists in the relay repo and builds
the root `Dockerfile`; `cloudbuild.yaml` and `deploy.sh` are the retired Cloud
Run path.

This does **not** reopen the 2026-08-02 relay-architecture decision — the relay
is still the Rust service and Cloudflare is still rejected. Railway answers
*where the chosen relay runs*, which that decision never fixed.

Deployment-behavior questions that Railway raises are recorded as open
verifications in `02-architecture.md` § Deployment target (edge WebSocket
connection lifetime, deploy-time instance overlap, managed-PostgreSQL
durability, region selection). They are Sprint-0 checks, not design work, but
Sprint 1's sequence-assignment and reconnect design depends on the first two.

## Open Decisions

### Auth Provider — OPEN, BLOCKING

This is the sole blocking owner decision. It was blocking when the program was
paused on 2026-08-16, was demoted to "first action of the pickup runbook"
while paused, and **reverted to a live blocking decision when the program
resumed on 2026-08-27**. Nothing about it was answered or rejected during the
pause; the menu below is unchanged.

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

If the hosted-SaaS option is taken, re-survey the vendor field before naming
one: the recommendation is over two months old and pricing and passkey support
move fast.

Decision owner: Security/Auth agent. Still OPEN as of 2026-08-27, and blocking
Sprint 0.

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
should be created. Relay ownership and deployment target were resolved
2026-08-27, the same day the program resumed.

### 2026-08-27 — Program resumed; relay ownership and deployment target

**Program status** — Resumed. The Remote Agents program was unpaused by the
owner after a pause running 2026-08-16 to 2026-08-27. Implementation remains
zero; Sprint 0 is the next step.

**Relay ownership** — Resolved.

- PacketRelay is PacketBench's infrastructure, not shared with Syndicate.
- Remote Agents is its only consumer and carries 100% of its build and run
  cost.
- Syndicate was separated from the Packet\* family on 2026-08-27 and its
  PacketBench execution-target integration was removed (commit `68ce85ee`).

**Relay deployment target** — Resolved.

- Railway, replacing Cloud Run. Does not reopen decision (c) or the
  Cloudflare rejection.
- Follow-on verifications are recorded as open in `02-architecture.md`
  § Deployment target.

**Auth provider** — Reverts to BLOCKING (it was demoted to a pickup-runbook
step while the program was paused). Still unanswered.

- Decision owner: project owner, with the Security/Auth agent.

### 2026-08-02 — Rust Packet Relay selected

**Relay architecture and code location** — Resolved.

- Use and extend the standalone Rust service at `D:\projects\packetrelay`.
- Keep PacketBench host/device messages separate from inherited relay protocols.
- Use PostgreSQL for durable account/device/ticket/replay/audit/outbox state.
- Keep live routing single-instance for v1; require explicit coordination work
  before horizontal scaling.
- Keep `remoteagents/shared` and `remoteagents/pwa` in PacketBench initially.
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
- PWA/shared schemas: PacketBench `remoteagents/` workspace initially.
- Decision owner: implementation lead.

Note: decision (a) remains BLOCKING (re-confirmed 2026-08-27 on resumption);
(b) was resolved 2026-08-16. Decision (c) is closed and must not be reopened
implicitly by creating a provider-specific relay scaffold — naming Railway as
the deployment target on 2026-08-27 does not reopen it.

## Deferred Decisions

- team/org access model
- cloud runner mode
- billing model
- WebRTC/LAN direct mode
- remote PTY policy
- mobile file browser depth
- long-term transcript retention

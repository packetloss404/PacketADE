# 10 - Pause Record and Pickup Runbook

**Status: PAUSED by owner decision, 2026-08-16.** This document is the single
entry point for resuming the Remote Agents program. A future session (human or
agent) should read this file first, then `09-open-decisions.md`, before
touching anything else.

---

## 1. The decision

On 2026-08-16 the owner paused the Remote Agents program deliberately, during
a blocker-review session, rather than by neglect. Scope of the pause:

- **No Sprint 0.** No `remoteagents/` workspace, no relay routes, no PWA
  scaffold, no `src-tauri/src/commands/remote_agents/` module gets created.
- **The auth decision is parked, not pressured.** It was the last blocking
  owner decision (see §3); while paused it converts from "blocking P1" to
  "first action of the pickup runbook."
- **Planning artifacts are frozen as-is.** Docs 01–09 remain the design of
  record; nothing in them is invalidated by the pause.

What the pause explicitly does **not** cover:

- **PacketRelay keeps evolving.** The relay repo at `D:\projects\packetrelay`
  is live production infrastructure for the **Syndicate** execution target
  (product-route WSS deployed on Cloud Run). Syndicate work continues and will
  change the relay under this program's feet — that drift is expected and is
  handled by pickup step 3.
- **The Syndicate program is unaffected.** Syndicate and Remote Agents share
  the relay binary but are separate programs with separate docs
  (`dev/archive/syndicate/syndicate-execution-target.md`). Do not read this pause as pausing
  Syndicate.

## 2. Exact state at pause (2026-08-16)

### Implementation: zero

Verified absent on this date: no root `remoteagents/` workspace, no
`src-tauri/src/commands/remote_agents/`, no `src/stores/remoteAgentsStore.ts`,
and zero `remote_agents` / `remoteAgents` references in `src`,
`src-tauri/src`, or `agent-sidecar`. The program is 100% planning.

### Planning: complete

Eleven markdown docs (01–09, README, research-brief) plus two HTML war-room
briefs (~110 KB). The implementation plan is seven sprints (0–6) sized for a
six-agent team with separate write areas (Rust Relay/Data, Desktop Remote
Gateway, Backend Conversation Service, PWA, Security/Auth, QA/Protocol/Docs/
Release). V1 capacity targets: 1 desktop socket per host, ≤5 mobile clients,
≤20 active conversations, 1,000-event/24h replay buffer, 64 KiB inline
envelope ceiling.

### Decision ledger at pause

| Decision | State |
| --- | --- |
| Primary UX: cloud sign-in, QR not primary | **Locked** |
| Desktop owns execution; relay never calls providers/tools | **Locked** |
| PWA first; native iOS deferred until after PWA beta | **Locked** |
| MVP runtime scope: API agents only, no remote PTY | **Locked** |
| Transport: WS relay for control, Web Push wake-only | **Locked** |
| Relay: extend `D:\projects\packetrelay` (Rust/Tokio + PostgreSQL); Cloudflare rejected | **Resolved 2026-08-02** — must not be reopened implicitly |
| Code location: relay stays sibling repo; shared schemas + PWA under PacketBench `remoteagents/` | **Resolved 2026-08-02** |
| Payload-encryption launch gate | **Resolved 2026-08-16** — plaintext (TLS-only) for local/internal dev only; encrypted agent/approval/file payloads are a hard gate before any external private beta |
| **Auth provider** | **OPEN — the sole blocking decision.** See §3 |
| Backend conversation persistence shape | Open, non-blocking (recommendation written: minimal Rust DTO for MVP) |
| Native iOS strategy | Deferred until after PWA beta |
| Team/org model, cloud runner, billing, WebRTC/LAN, remote PTY, file browser depth, transcript retention | Deferred |

### The open auth decision, as clarified 2026-08-16

"Buy" was clarified into two sub-flavors during the blocker review. The full
menu (recorded in `09-open-decisions.md` § Auth Provider):

1. **Hosted SaaS IdP** (Clerk / Auth0 / Stytch class) — vendor runs sign-in,
   passkeys, magic links, recovery; the relay only validates tokens. Least
   owned surface; free tiers cover a private beta, then per-active-user
   pricing. *This was the session's recommendation.*
2. **Self-hosted open-source IdP** (Keycloak / Zitadel / Ory class) —
   standard OIDC, no vendor or per-user fees, but one more service to deploy,
   patch, and secure next to the relay.
3. **Build into the relay** — passkey/magic-link in Rust on PostgreSQL; fully
   owned including the WebAuthn ceremony, session design, recovery flows, and
   the security review those imply.
4. **Dev-only identity** — permitted for internal smoke tests regardless of
   the above; never for any external user.

The decision was presented to the owner on 2026-08-16 and deliberately left
unanswered when the pause was chosen instead. Nothing about it was rejected.

### Corrections applied at pause time

- **The `packet-relay` path bug is fixed.** Every planning doc previously
  cited the relay repo as `D:\projects\packet-relay`; the real directory is
  `D:\projects\packetrelay` (the *crate* is named `packet-relay`, which is how
  the error propagated). Corrected 2026-08-16 in: `backlog.md`,
  `dev/mobile/README.md`, all `dev/remoteagents/*.md`, and both HTML briefs.
  Left intact as dated evidence: `docs/reports/state-of-the-ade-2026-07-30.md`
  line ~66 — do not "fix" dated audit snapshots.

## 3. Why it was paused

- The portfolio's bottleneck is **packaged, real-environment proof**, not new
  surfaces — the owner rejected the v1.0.0 definition the same day and chose
  to continue the 0.10.x proof/hardening cadence. Remote Agents is the
  largest possible new surface (XL: relay control plane + desktop gateway +
  conversation service + PWA + auth + E2EE).
- The pause is **strategic sequencing, not doubt about the design**. The
  market validated the architecture: Claude Remote Control and Codex-in-
  ChatGPT-mobile both ship exactly this shape (execution local, phone as a
  thin approval window over a relay).

## 4. What ages while this sits — the staleness map

Read this table before trusting any doc at pickup.

| Artifact | Trust at pickup |
| --- | --- |
| `09-open-decisions.md` | **Authoritative** — the live decision ledger, updated 2026-08-16. |
| `01-product-scope.md`, `04-security.md`, `05-pwa.md`, `06-implementation-plan.md`, `07-six-agent-runbook.md`, `08-testing.md` | Design of record; sound unless a pickup step below invalidates a specific assumption. |
| `02-architecture.md`, `03-protocol.md` | Design of record **but must be re-baselined against `D:\projects\packetrelay` HEAD** — the relay evolves under Syndicate (see `PRODUCT_ROUTE_PROTOCOL.md` in that repo, the live Cloud Run WSS route, room auth). The single-instance router and "extend with /ws/host + /ws/device" assumptions must be re-checked against whatever Syndicate added. |
| `research-brief.md` | **Background only.** Dated 2026-05-26 — 2.5 months older than the rest and predates the Cloudflare→Rust reversal. Re-verify its platform facts before consuming: iOS PWA Web Push behavior, WebAuthn/passkey support matrices, WS connection limits, push-provider choices. |
| The two HTML briefs | Presentation snapshots of the plan; never authoritative over the markdown. |
| Market baseline | Refresh at pickup. As of 2026-08-16 the first parties ship phone supervision (Claude Remote Control, Codex mobile QR pairing, GitHub mission control mobile); the "Ten Empty Lanes" strategy report (artifact, 2026-08-16) argues the differentiated version of this surface is **the attention-budget's remote endpoint, not a desktop mirror** — Lane 10: urgency-typed interruptions, decision windows, batched approvals, voice triage via Dictation. |

## 5. Invariants that survive the pause

Do not violate these at pickup without an explicit new owner decision:

1. Desktop PacketBench owns execution, providers, models, secrets, workspaces,
   permissions. The cloud never calls a provider or runs a tool.
2. **No generic remote Tauri invoke bridge.** A small audited command set
   only, wrapping the existing `api-agent:*` event vocabulary — never a
   second event vocabulary and never a general RPC surface.
3. API agents only in MVP; raw PTY remote control is out.
4. PWA first at `remote.packetbench.app`; account sign-in primary (QR at most a
   later convenience).
5. The relay is the Rust service at `D:\projects\packetrelay`; no Cloudflare
   implementation, and decision (c) is not reopened by creating one.
6. The ratified E2EE gate: encrypted agent/approval/file payloads before any
   external private beta.
7. Web Push is wake-only; the WS relay is the control channel.

## 6. Pickup runbook (ordered)

0. **Read** this doc, then `09-open-decisions.md`, then `README.md`.
1. **Decide auth** (§2 menu). This is the only blocking decision. If the
   hosted-SaaS recommendation is taken, re-survey the vendor field at pickup
   time before naming one — pricing and passkey support move fast.
2. **Confirm the E2EE gate still stands** (one-line ratification check; it
   was owner-ratified 2026-08-16).
3. **Re-baseline `02-architecture.md` / `03-protocol.md` against
   `D:\projects\packetrelay` HEAD.** Diff the plan's assumed relay surface
   against what Syndicate has since built (`PRODUCT_ROUTE_PROTOCOL.md`, room
   auth, deployment topology on Cloud Run/Railway). Decide extend-vs-separate
   for the PacketBench routes in light of the real code, and record the answer
   in `09-open-decisions.md`.
4. **Refresh the research brief's platform facts** (30–60 min web sweep):
   iOS PWA push, passkey UX, WS limits, and the first-party competitor
   baseline (what Claude/Codex/GitHub mobile now ship).
5. **Re-scope against Lane 10.** Explicit product decision: is v1 a
   supervision mirror (the 01-product-scope MVP as written) or the
   attention-budget remote endpoint (urgency-typed queue, decision windows,
   batched approvals)? The Ten Empty Lanes report argues the latter is the
   defensible version. Amend `01-product-scope.md` if the answer changes it.
6. **Confirm team shape.** The sprint plan assumes six parallel agents with
   separate write areas (`07-six-agent-runbook.md`). If picking up with less
   capacity, re-cut the sprint plan before starting, don't improvise.
7. **Verify prerequisites**: PostgreSQL for the relay's durable state, a Web
   Push key strategy, and the contract-fixture gating between the two repos
   described in `09-open-decisions.md` § Code Location.
8. **Then run Sprint 0** per `06-implementation-plan.md`.

## 7. Pointers

- Program docs: this directory (`dev/remoteagents/`), `01`–`09` + README.
- Relay repo: `D:\projects\packetrelay` (crate `packet-relay`; Rust 1.83,
  Dockerfile, `cloudbuild.yaml`, `railway.json`, CI workflow).
- Task register: `backlog.md` § Owner decisions (auth entry annotated as
  paused) and the Remote Agents rows in `ROADMAP.md`.
- Strategy context: the "Ten Empty Lanes" artifact (2026-08-16, Lane 10 and
  §5 Sequencing) and the "Forty Plans, One Gate" plan-review artifact
  (2026-08-16) — both in the owner's artifact gallery.
- Sibling background: `dev/mobile/` is superseded research; its Cloudflare
  conclusions are dead, its PWA-first/account-first conclusions survived.

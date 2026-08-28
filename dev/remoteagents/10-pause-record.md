# 10 - Pause and Resumption Record

**Status: ACTIVE — resumed by owner decision, 2026-08-27** (paused 2026-08-16;
the pause held for eleven days). This document remains the single entry point
for the Remote Agents program. A session (human or agent) picking the program
up should read this file first, then `09-open-decisions.md`, before touching
anything else.

The pause is preserved below as history, not as noise: it was a deliberate
sequencing decision made during a blocker review, not neglect, and the reasons
recorded in §3 are still the reasons — they were overtaken, not refuted.

---

## 1. The decisions

### 1.1 The pause (2026-08-16) — history

On 2026-08-16 the owner paused the Remote Agents program deliberately, during
a blocker-review session, rather than by neglect. Scope of the pause:

- **No Sprint 0.** No `remoteagents/` workspace, no relay routes, no PWA
  scaffold, no `src-tauri/src/commands/remote_agents/` module got created.
- **The auth decision was parked, not pressured.** It was the last blocking
  owner decision; while paused it converted from "blocking P1" to "first
  action of the pickup runbook."
- **Planning artifacts were frozen as-is.** Docs 01–09 remained the design of
  record; nothing in them was invalidated by the pause.

### 1.2 The resumption (2026-08-27)

On 2026-08-27 the owner unpaused the program. Three decisions were recorded
the same day:

- **The program is live again.** Sprint 0 in `06-implementation-plan.md` is
  once more the next step, gated only by the auth decision (§1.3).
- **PacketRelay belongs to PacketBench.** The standalone Rust relay at
  `D:\projects\packetrelay` is no longer shared with, or driven by, Syndicate.
  It is PacketBench's infrastructure and **Remote Agents is its only
  consumer**. Nothing else in the Packet\* family drives its roadmap.
- **The relay's deployment target is Railway.** This replaces the Google
  Cloud Run deployment the relay ran while it served Syndicate. It does not
  reopen the 2026-08-02 relay-architecture decision (Rust service, Cloudflare
  rejected); Railway is the answer to *where the chosen relay runs*, which
  that decision never fixed. `railway.json` already exists in the relay repo
  and builds the root `Dockerfile`; the Cloud Run path (`cloudbuild.yaml`,
  `deploy.sh`, Artifact Registry) is the retired one.

### 1.3 The premise that died, and what it costs

Syndicate was separated from the Packet\* product family on 2026-08-27, and
its execution-target integration was deleted from PacketBench (commit
`68ce85ee`; the archived program doc is
`dev/archive/syndicate/syndicate-execution-target.md`). Two statements this
document made at pause time are now **false and are withdrawn**:

- ~~"PacketRelay is live production infrastructure for the **Syndicate**
  execution target (product-route WSS deployed on Cloud Run)."~~ The relay is
  PacketBench's, and its deployment target is Railway.
- ~~"Syndicate work continues and will change the relay under this program's
  feet — that drift is expected."~~ There is no Syndicate work touching the
  relay. The drift this program planned around does not exist, and the pickup
  step that handled it is retired (see §6, step 3).

**The consequence, recorded plainly: Remote Agents now bears 100% of the
relay's build and run cost.** While the relay served Syndicate, its
implementation work (control plane, PostgreSQL state, auth, replay, audit,
Web Push) and its hosting bill were shared against another program's value.
They are not any more. That is a real reweighting of this program's economics
and it has not been scored anywhere — the sprint plan in
`06-implementation-plan.md` still allocates relay work as if it were partly
someone else's. This is stated as a consequence, not as an argument for or
against the program.

The separation also raised the disposition of the relay's `/v1/product-route`
surface. That was recorded here as an open relay-repo question on the
understanding that the route backed a live Syndicate deployment. **That
understanding was wrong.** The owner confirmed on 2026-08-28 that the route is
not serving live traffic, and the decision is to **cut it** — see
`09-open-decisions.md` § Relay `/v1/product-route` disposition. The removal
happens in the relay repo, ahead of the Railway migration.

## 2. State of record

### Implementation: zero

Verified absent again on 2026-08-27 (and originally on 2026-08-16): no root
`remoteagents/` workspace, no `src-tauri/src/commands/remote_agents/`, no
`src/stores/remoteAgentsStore.ts`, and zero `remote_agents` / `remoteAgents`
references in `src`, `src-tauri/src`, or `agent-sidecar`. The program is 100%
planning. Nothing was built during the pause and nothing has been built since.

### Planning: complete

Eleven markdown docs (01–09, README, research-brief) plus two HTML war-room
briefs (~110 KB). The implementation plan is seven sprints (0–6) sized for a
six-agent team with separate write areas (Rust Relay/Data, Desktop Remote
Gateway, Backend Conversation Service, PWA, Security/Auth, QA/Protocol/Docs/
Release). V1 capacity targets: 1 desktop socket per host, ≤5 mobile clients,
≤20 active conversations, 1,000-event/24h replay buffer, 64 KiB inline
envelope ceiling.

### Decision ledger (current)

| Decision | State |
| --- | --- |
| Primary UX: cloud sign-in, QR not primary | **Locked** |
| Desktop owns execution; relay never calls providers/tools | **Locked** |
| PWA first; native iOS deferred until after PWA beta | **Locked** |
| MVP runtime scope: API agents only, no remote PTY | **Locked** |
| Transport: WS relay for control, Web Push wake-only | **Locked** |
| Relay: extend `D:\projects\packetrelay` (Rust/Tokio + PostgreSQL); Cloudflare rejected | **Resolved 2026-08-02** — must not be reopened implicitly |
| Code location: relay stays sibling repo; shared schemas + PWA under PacketBench `remoteagents/` | **Resolved 2026-08-02** |
| **Relay ownership** | **Resolved 2026-08-27** — PacketRelay is PacketBench's infrastructure; Remote Agents is its only consumer. Not shared with Syndicate. |
| **Relay deployment target** | **Resolved 2026-08-27** — Railway (replaces Cloud Run). Does not reopen the 2026-08-02 architecture decision. |
| Payload-encryption launch gate | **Resolved 2026-08-16** — plaintext (TLS-only) for local/internal dev only; encrypted agent/approval/file payloads are a hard gate before any external private beta. Unchanged by the resumption. |
| **Auth provider** | **Resolved 2026-08-28** — build passkey/magic-link auth into the relay (Rust on PostgreSQL), fully owned. The owner accepted the ownership burden explicitly. No blocking owner decision remains. See §2 and `09-open-decisions.md` § Auth Provider. |
| Railway deployment questions (edge WS connection lifetime, deploy-time instance overlap, managed-PostgreSQL durability, region) | **Open, Sprint-0 verification** — see `02-architecture.md` § Deployment target |
| Relay `/v1/product-route` disposition after the Syndicate separation | **Resolved and DONE 2026-08-28** — cut, executed in the relay repo as `b2bcff5`. Bridge/broadcast/room were explicitly *not* cut; they are a separate inherited lineage. |
| Backend conversation persistence shape | Open, non-blocking (recommendation written: minimal Rust DTO for MVP) |
| Native iOS strategy | Deferred until after PWA beta |
| Team/org model, cloud runner, billing, WebRTC/LAN, remote PTY, file browser depth, transcript retention | Deferred |

### The auth decision — RESOLVED 2026-08-28

**Option 3 was chosen: build it into the relay.** Passkey/magic-link in Rust
on PostgreSQL, fully owned, with the owner explicitly accepting the ownership
burden that implies. This was the last blocking owner decision; Sprint 0 is
unblocked.

It stayed open through the whole pause — nothing about it was answered or
rejected between 2026-08-16 and 2026-08-27 — and was resolved the day after
the program resumed. "Buy" had been clarified into two sub-flavors during the
2026-08-16 blocker review. The full menu is retained below as the record of
what was weighed:

1. **Hosted SaaS IdP** (Clerk / Auth0 / Stytch class) — vendor runs sign-in,
   passkeys, magic links, recovery; the relay only validates tokens. Least
   owned surface; free tiers cover a private beta, then per-active-user
   pricing. *This was the 2026-08-16 session's recommendation.*
2. **Self-hosted open-source IdP** (Keycloak / Zitadel / Ory class) —
   standard OIDC, no vendor or per-user fees, but one more service to deploy,
   patch, and secure next to the relay.
3. **Build into the relay** — passkey/magic-link in Rust on PostgreSQL; fully
   owned including the WebAuthn ceremony, session design, recovery flows, and
   the security review those imply. **← CHOSEN 2026-08-28.**
4. **Dev-only identity** — permitted for internal smoke tests regardless of
   the above; never for any external user.

Options 1 and 2 remain the fallbacks if in-house auth lands more expensive
than expected — most likely at account recovery or at the pre-beta security
review. If either is ever taken, re-survey the vendor field rather than
reusing the 2026-06 comparison: pricing and passkey support move fast. Option
4 is unaffected and still appropriate as the internal-prototype scaffold.

### Corrections applied at pause time

- **The `packet-relay` path bug is fixed.** Every planning doc previously
  cited the relay repo as `D:\projects\packet-relay`; the real directory is
  `D:\projects\packetrelay` (the *crate* is named `packet-relay`, which is how
  the error propagated). Corrected 2026-08-16 in: `backlog.md`,
  `dev/mobile/README.md`, all `dev/remoteagents/*.md`, and both HTML briefs.
  Left intact as dated evidence: `docs/reports/state-of-the-ade-2026-07-30.md`
  line ~66 — do not "fix" dated audit snapshots.

## 3. Why it was paused — and what changed

The pause reasoning, preserved:

- The portfolio's bottleneck was **packaged, real-environment proof**, not new
  surfaces — the owner rejected the v1.0.0 definition the same day and chose
  to continue the 0.10.x proof/hardening cadence. Remote Agents is the
  largest possible new surface (XL: relay control plane + desktop gateway +
  conversation service + PWA + auth + E2EE).
- The pause was **strategic sequencing, not doubt about the design**. The
  market validated the architecture: Claude Remote Control and Codex-in-
  ChatGPT-mobile both ship exactly this shape (execution local, phone as a
  thin approval window over a relay).

What changed on 2026-08-27: the owner unpaused the program, and PacketRelay
became PacketBench's own infrastructure with Railway as its deployment target
(§1.2). No rationale beyond those decisions was recorded, and none is invented
here. The sequencing argument above is preserved as the reason the pause
happened, not as a live objection to the program running now.

## 4. What aged during the pause — the staleness map

Read this table before trusting any doc.

| Artifact | Trust at resume |
| --- | --- |
| `09-open-decisions.md` | **Authoritative** — the live decision ledger, updated 2026-08-27. |
| `01-product-scope.md`, `04-security.md`, `05-pwa.md`, `06-implementation-plan.md`, `07-six-agent-runbook.md`, `08-testing.md` | Design of record; sound unless a resume step below invalidates a specific assumption. `06`'s sprint sizing predates the cost reweighting in §1.3. |
| `02-architecture.md`, `03-protocol.md` | Design of record **but must be re-baselined once against `D:\projects\packetrelay` HEAD** — the plan's "extend with `/ws/host` + `/ws/device`" and single-instance-router assumptions were written before the relay's `/v1/product-route` surface existed. The relay is no longer moving under this program (§1.3), so this is a one-time reconciliation, not continuous drift management. `02` now carries the Railway deployment notes and their open questions. |
| `research-brief.md` | **Background only.** Dated 2026-05-26 — three months older than the rest and predates the Cloudflare→Rust reversal. Re-verify its platform facts before consuming: iOS PWA Web Push behavior, WebAuthn/passkey support matrices, WS connection limits, push-provider choices. |
| The two HTML briefs | Presentation snapshots of the plan; never authoritative over the markdown. They never carried the pause status and they predate the 2026-08-27 decisions, so they say nothing about relay ownership or Railway. Regenerate them only if they are used for a kickoff. |
| Market baseline | Refresh now. As of 2026-08-16 the first parties ship phone supervision (Claude Remote Control, Codex mobile QR pairing, GitHub mission control mobile); the "Ten Empty Lanes" strategy report (artifact, 2026-08-16) argues the differentiated version of this surface is **the attention-budget's remote endpoint, not a desktop mirror** — Lane 10: urgency-typed interruptions, decision windows, batched approvals, voice triage via Dictation. |

## 5. Invariants

Do not violate these without an explicit new owner decision:

1. Desktop PacketBench owns execution, providers, models, secrets, workspaces,
   permissions. The cloud never calls a provider or runs a tool.
2. **No generic remote Tauri invoke bridge.** A small audited command set
   only, wrapping the existing `api-agent:*` event vocabulary — never a
   second event vocabulary and never a general RPC surface.
3. API agents only in MVP; raw PTY remote control is out.
4. PWA first at `remote.packetbench.app`; account sign-in primary (QR at most a
   later convenience).
5. The relay is the Rust service at `D:\projects\packetrelay`, owned by
   PacketBench and deployed on Railway; no Cloudflare implementation, and the
   2026-08-02 decision is not reopened by creating one.
6. The ratified E2EE gate: encrypted agent/approval/file payloads before any
   external private beta.
7. Web Push is wake-only; the WS relay is the control channel.

## 6. Resume runbook (ordered)

0. **Read** this doc, then `09-open-decisions.md`, then `README.md`.
1. ~~**Decide auth**~~ — **done 2026-08-28**: build passkey/magic-link into
   the relay. No blocking owner decision remains. Carry the owned surface
   listed in `09-open-decisions.md` § Auth Provider into Sprint 0 sizing; the
   pre-beta security review is a gate alongside E2EE, not a nice-to-have.
2. **Confirm the E2EE gate still stands** (one-line ratification check; it
   was owner-ratified 2026-08-16 and is unchanged by the resumption).
3. **Cut `/v1/product-route` in the relay repo, then re-baseline
   `02-architecture.md` / `03-protocol.md` against `D:\projects\packetrelay`
   HEAD, once.** This step is no longer about tracking Syndicate drift — that
   premise is dead (§1.3). Two things remain, in order:

   a. **Remove the inherited surface.** Resolved 2026-08-28: the route carries
      no live traffic, so `/v1/product-route`, the bridge/broadcast/room
      compatibility modes serving it, `PRODUCT_ROUTE_PROTOCOL.md`, and the
      retired Cloud Run artifacts (`cloudbuild.yaml`, `deploy.sh`) come out.
      Verify no client is connected and check the relay's access logs first —
      the "live deployment" claim went unchallenged in these docs for a while,
      so confirm the correction rather than inheriting a second assumption.
      Do this before the Railway migration so a dead route is not ported into
      a new deployment target.
   b. **Then diff** the plan's assumed relay surface against what is actually
      left, and record the answer in `09-open-decisions.md`. With the
      inherited surface gone, extend-vs-separate largely collapses: the
      PacketBench routes replace it rather than sitting alongside it.
4. **Stand up the Railway deployment path** and answer the open deployment
   questions in `02-architecture.md` § Deployment target (edge WebSocket
   connection lifetime, deploy-time instance overlap, managed-PostgreSQL
   durability, region). These are Sprint-0-sized verifications, not design
   work, but Sprint 1's sequence-assignment and reconnect design depends on
   the first two answers.
5. **Refresh the research brief's platform facts** (30–60 min web sweep):
   iOS PWA push, passkey UX, WS limits, and the first-party competitor
   baseline (what Claude/Codex/GitHub mobile now ship).
6. **Re-scope against Lane 10.** Explicit product decision: is v1 a
   supervision mirror (the 01-product-scope MVP as written) or the
   attention-budget remote endpoint (urgency-typed queue, decision windows,
   batched approvals)? The Ten Empty Lanes report argues the latter is the
   defensible version. Amend `01-product-scope.md` if the answer changes it.
7. **Confirm team shape, with §1.3's cost reweighting in view.** The sprint
   plan assumes six parallel agents with separate write areas
   (`07-six-agent-runbook.md`) and was sized when relay work was shared with
   another program. If picking up with less capacity, re-cut the sprint plan
   before starting, don't improvise.
8. **Verify prerequisites**: PostgreSQL for the relay's durable state (Railway
   managed instance), a Web Push key strategy, and the contract-fixture
   gating between the two repos described in `09-open-decisions.md` § Code
   Location.
9. **Then run Sprint 0** per `06-implementation-plan.md`.

## 7. Pointers

- Program docs: this directory (`dev/remoteagents/`), `01`–`09` + README.
- Relay repo: `D:\projects\packetrelay` (crate `packet-relay`; Rust 1.83,
  Dockerfile, `railway.json` — the live deployment path — plus the retired
  Cloud Run artifacts `cloudbuild.yaml` and `deploy.sh`, and a CI workflow).
- Task register: `backlog.md` § Owner decisions (the auth entry is resolved
  2026-08-28) and the Remote Agents rows in `ROADMAP.md`.
- Strategy context: the "Ten Empty Lanes" artifact (2026-08-16, Lane 10 and
  §5 Sequencing) and the "Forty Plans, One Gate" plan-review artifact
  (2026-08-16) — both in the owner's artifact gallery.
- Sibling background: `dev/mobile/` is superseded research; its Cloudflare
  conclusions are dead, its PWA-first/account-first conclusions survived.
- Syndicate background: archived at
  `dev/archive/syndicate/syndicate-execution-target.md`; the integration was
  removed from PacketBench in commit `68ce85ee`.

# `device.refresh` — client-side method-shape proposal

Status: **proposal / input to a cross-repo negotiation.** Nothing here is built.

Owner of the method: **Syndicate** (`PACKETADE_COORDINATION.md` §3, item P4#2 —
it signs grants, owns revocation epochs and the SQLite device row). Owner of the
client call: **PacketADE**, afterwards.

This document is PacketADE's input: what the client needs the method to look
like, and why. Both sides agreed to settle the shape before either builds it.

Citations to `src-tauri/`, `src/` are this repo, verified 2026-08-15. Citations
to `apps/host/`, `docs/` are Syndicate's tree, read-only.

---

## 1. What actually breaks at day 30

`approveDevice` mints a grant with
`expiresAt: new Date(this.now() + 30 * 24 * 60 * 60 * 1_000)`
(`apps/host/src/controller-auth.ts:420`). There is no code path that ever moves
that value again. `CONTROLLER_PROTOCOL_V1.md:58` states it plainly: _"Approved
grants expire after 30 days and may be refreshed only by a future locally
approved flow."_

At expiry, `authenticate` rejects with `DEVICE_UNAUTHORIZED`
(`controller-auth.ts:536-537`) — status stays `active`, only `grant_expires_at`
has passed. Three consequences the client has to live with:

- The rejection sits **inside `authenticate`**, which runs before the scope
  check (`:539`) and before the idempotency receipt block (`:459`). So it
  applies to _every_ method — including `device.revoke_self`. An expired device
  cannot clean itself up.
- `deviceIsActive` (`:281-285`) applies the same test to long-lived streams, so
  an established connection cannot outlive the grant either.
- Relay admission is separately dead: `validate_material` rejects a stored grant
  whose `expiresAt` has passed (`src-tauri/src/commands/syndicate_relay.rs:331-339`),
  so PacketADE stops before the socket even opens.

### What PacketADE already does

The typed-error work on `codex/syndicate-integration-toggle` closed the
five-link "day-30 chain" from `PACKETADE_COORDINATION.md` §5. Current behaviour:

| Behaviour                                                                                        | Where                                                                            |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Native layer forwards `{code, retryable, correlationId}` verbatim instead of flattening to prose | `syndicate.rs:308-318`, `:1288-1305`                                             |
| `DEVICE_UNAUTHORIZED` → grant marked `expired`; `DEVICE_REVOKED` → `revoked`                     | `src/lib/syndicateErrors.ts:84-91`                                               |
| Terminal reconnect loop stops on `retryable: false` instead of a message regex                   | `src/lib/syndicateErrors.ts:103-105`, `SyndicateTerminalPane.tsx:216-220`        |
| `grantExpiresAt` carried on the machine record, read from the relay grant in `machine.snapshot`  | `src/types/syndicate.ts:294-299`, `syndicateStore.ts:299`                        |
| Amber warning in the final 7 days                                                                | `src/lib/syndicateMachineStatus.ts:107-121`, `SyndicateMachinesCard.tsx:490-495` |
| Relay-detected expiry classified locally as `GRANT_EXPIRED`, `retryable: false`                  | `syndicate_relay.rs:37`, `:46`, `:49-61`                                         |

So PacketADE can **warn, classify, and stop retrying**. What it cannot do is
**renew**. The warning text is literally an instruction to re-pair
(`SyndicateMachinesCard.tsx:493-494`: _"Grants cannot be renewed — pair this
machine again before then to avoid an interruption."_).

### And the re-pair path is worse than it looks

At day 30 the user is told to re-pair. In practice:

1. `syndicateStore.revoke` (`:415-425`) calls `device.revoke_self` first, which
   `authenticate` now rejects, so the promise rejects at `:418` and the local
   `forgetSyndicateMachine(machine.machineId)` at `:419` **never runs**.
2. `forgetOffline` (`:427-435`) is the only escape — it is local-only and
   deliberately ungated (`syndicate.rs:1684-1691`).
3. Until the local keyring record is gone, pairing a replacement is blocked by
   `ensure_machine_not_already_paired` (`syndicate.rs:692-701`, called at
   `:1351`) and by the store's own pre-check (`syndicateStore.ts:210-235`).
4. The Host keeps a stale `active`-but-expired device row that only a browser
   administrator can revoke.

That chain is the cost of not having `device.refresh`, restated concretely.

---

## 2. Recommended method shape

| Method           | Scope        | Strict params |
| ---------------- | ------------ | ------------- |
| `device.refresh` | active grant | `{}`          |

```jsonc
// result
{
  "deviceId": "device_...",
  "scopes": ["machine.read", "..."], // unchanged, from the device row
  "revocationEpoch": 3, // unchanged
  "relayGrant": {
    // byte-shape identical to machine.snapshot
    "grant": {
      "protocolVersion": 1,
      "type": "device_grant",
      "...": "...",
      "issuedAt": "...",
      "expiresAt": "...",
      "revocationEpoch": 3,
    },
    "grantSignatureBase64Url": "...",
  },
}
```

**Scope: "active grant", not a named scope.** Refresh is a lifecycle operation
on the device's own credential, not a capability over the machine. Gating it on
`machine.read` would mean a device approved with a narrow scope set could lose
the ability to renew — an authority-shaped decision leaking into a
credential-shaped one. `device.revoke_self` already sets this precedent
(`CONTROLLER_PROTOCOL_V1.md:115`).

**Params: strictly `{}`.** No `scopes` (a refresh that accepts scopes reopens
the escalation surface `approveDevice` closes at `controller-auth.ts:409`), no
`expiresAt` (the client must not choose its own lifetime), no `deviceId` (it is
already in the signed envelope and authenticated). `{}` matches
`machine.snapshot` and `device.revoke_self`.

**The single highest-value ask: make `relayGrant` byte-identical in shape to the
one `machine.snapshot` already returns.** PacketADE's `capture_relay_grant`
(`syndicate.rs:921-1013`) already verifies a full certificate — protocol version
and type, machine/device identity binding, self-certifying `routeId` against the
pinned Host key, both Host public keys against the pairing invitation, both
device public keys against the keyring, and the Ed25519 signature over
`SYNDICATE-RELAY-GRANT-V1\n` + canonical JSON — then persists it. If refresh
returns that same object, the client implementation is: call the method, hand
the result to the existing capture function, drop the `method == "machine.snapshot"`
condition at `syndicate.rs:1308-1310`. **Zero new verification code, zero new
trust decisions.** Any other result shape means writing a second verifier, which
is exactly where a client gets a security check subtly wrong.

---

## 3. The central question: what authenticates a refresh for an expired grant?

The device Ed25519 signing key lives in the OS keyring
(`syndicate.rs:683-690`, `:761-790`) and does not expire. It can sign a valid
`SYNDICATE-CONTROLLER-V1` envelope on day 31 exactly as well as on day 1. The
only thing stopping it is `controller-auth.ts:536-537`. So this is purely a
policy choice, and it is the whole design.

### Option A — refresh requires a still-valid grant (recommended)

`device.refresh` is an ordinary authenticated method. Past `expiresAt` it fails
with the same rejection as everything else. Recovery is re-pairing.

_For:_ the 30-day expiry keeps meaning what it says. A device signing key that
has not reached the Host in 30 days is dead — a stolen laptop that never phones
home, a decommissioned machine, a forgotten VM. That is a real property, and it
is the only remaining hard ceiling on unattended `terminal.input` authority once
renewal exists at all. No change to `authenticate`, which is currently a single
uniform choke point and stays one.

_Against:_ a legitimately offline device (three-week holiday, host down for
maintenance) is unrecoverable without browser access to the Host. This is
exactly today's behaviour, so Option A is strictly an improvement on the status
quo rather than a regression — it just doesn't fix that case.

### Option B — bounded grace window after expiry

The Host accepts a signed `device.refresh` for a grant expired by ≤ N days,
only when `status = 'active'` (never `revoked`).

_For:_ covers the offline-device case, which is the one users will actually hit.

_Against:_ this is a carve-out **inside `authenticate`** — the function whose
value is that it is unconditional. Every carve-out there is a place a future
change can widen. And it converts the ceiling from 30 days to 30 + N days for a
stolen key, with no compensating signal: the operator sees a device that keeps
working. If Syndicate wants this, N should be small (7 days, matching the
client's existing warning window), the carve-out should be expressed as a
`method === "device.refresh"` guard and nothing else, and the Host should mark
the device row so the dashboard can show "renewed after expiry" — because the
security value of a grace window is entirely in it being visible.

### Option C — locally approved re-approval

What `CONTROLLER_PROTOCOL_V1.md:58` currently gestures at: a human at the Host
browser re-approves. Safe, and no protocol change needed at all.

_Against:_ it is re-pairing with extra steps, so it does not solve P4#2 — it
only removes the key-regeneration cost. Worth having as the _fallback_ for an
expired device, not as the method.

### Recommendation

**Option A, with C as the documented recovery.** Take the security property
seriously: a grant that carries `terminal.input` is code execution as the
Syndicate OS user (`CONTROLLER_PROTOCOL_V1.md:14-16`), and if an expired grant
can bootstrap a fresh one on the strength of the same key, the expiry has been
converted from a bound into a reminder. The offline-device gap is real but is
better closed by making the client refresh _early and often_ (§8) than by
softening the one check that currently cannot be argued with.

PacketADE will implement B correctly if Syndicate chooses it — but B should be
chosen deliberately, in the spec, with the window written down, not arrived at
by relaxing a condition.

---

## 4. New certificate, not extension; and `revocationEpoch`

**Mint a new signed certificate.** There is no "extend" that is not "re-sign" —
`expiresAt` is inside the signed canonical JSON
(`controller-auth.ts:413-421`), so any change to it invalidates
`grantSignatureBase64Url` and requires a fresh signature anyway. Same
`deviceId`, same device and Host keys, same `routeId`, same scopes read from the
device row, new `issuedAt`, new `expiresAt = now + 30 days`.

**`revocationEpoch` is copied unchanged from the device row.** Refresh is not
revocation. Bumping it would emit — or worse, imply — a `grant_revoked` notice
(`controller-auth.ts:592-610`) for a device that is being _kept alive_, and
would disturb PacketRelay's in-memory revocation acceleration. `revokeDevice`
(`:437-446`) and `device.revoke_self` (`:471-487`) remain the only writers of
that counter.

**Storage:** the Host overwrites `relay_grant_json` /
`relay_grant_signature_base64url` / `grant_expires_at` on the same row, exactly
as `approveDevice` does. One current certificate per device, no history table.

### Two client-side invariants the design must not break

These are properties of code that already ships, and they constrain the Host
half:

1. **Grant lifetime is bounded at 31 days by the client.**
   `validate_material` rejects a grant where `expires - issued > 31 days`
   (`syndicate_relay.rs:336`), and also where `issued > now + 1 minute`
   (`:333`). A refresh that issues, say, a 60-day certificate would be
   **rejected by every already-shipped PacketADE build** — silently, as a local
   `GRANT_EXPIRED` (`:337-338`). Keep the 30-day term.

2. **The relay AEAD keys do not change on refresh, so the counters must not
   reset.** The directional keys derive from
   `HKDF(X25519(device priv, host pub), salt = SHA-256("SYNDICATE-RELAY-V1\n" + machineId + "\n" + deviceId), info = direction)`
   (`syndicate_relay.rs:406-419`; `CONTROLLER_PROTOCOL_V1.md:256-258`). The
   grant is **not** an input. A refresh that keeps the same keypairs therefore
   produces the same AES-256-GCM keys — and the nonce is fully derived from the
   counter (`CONTROLLER_PROTOCOL_V1.md:252-255`). If either side treated a new
   grant as a reason to reset `controller_relay_counters`, that is **nonce reuse
   under a reused key**, which breaks GCM outright. PacketADE's counters are
   persisted in the keyring credential across grants
   (`syndicate.rs:713-716`, `:719-733`, `:749-759`) and would not reset, but the
   Host half must not either. If Syndicate ever wants counters to restart, the
   refresh must rotate the X25519 keypair as well — which is a much larger
   change, and a reason not to want it.

Also note `capture_relay_grant` does **not** compare the incoming
`revocationEpoch` against anything stored, and does not reject a certificate
whose `expiresAt` is _earlier_ than the one already held
(`syndicate.rs:921-1013`). A Host-signed older certificate could therefore be
captured over a newer one. That is not an escalation (an older grant is
strictly weaker) and it is not reachable today because only `machine.snapshot`
captures and the Host holds one current row — but once refresh exists it is
worth PacketADE adding a monotonicity check on `issuedAt`. Flagged here as a
client-side follow-up, not an ask.

---

## 5. Idempotency: no durable receipt

**Recommendation: keep `device.refresh` out of `mutatingMethods`
(`controller-auth.ts:169-171`), and have the client send a fresh random
`requestId` per attempt.**

Reasoning. Refresh is naturally idempotent in effect: the Host row holds exactly
one current certificate, and a duplicate call costs one wasted Ed25519
signature. If a response is lost, the client is still holding its previous —
still valid, since Option A requires it — grant and simply calls again.

The reason to _avoid_ a receipt is concrete. A receipt found in `processing`
after a crash returns `UNCERTAIN_DELIVERY` with `retryable: false`
(`controller-auth.ts:465`), and PacketADE derives stable request ids
deterministically from operation plus identities
(`syndicate.rs:672-681`) — a `stable_request_id("device-refresh", [machineId, deviceId])`
would be **permanently poisoned by one crash**, making that device unrefreshable
forever. `send_rpc` already generates a random UUID when no id is supplied
(`syndicate.rs:1151`), so the client side of this is free.

This flips if Syndicate makes refresh bump anything monotonic (a grant serial,
an epoch, a renewal counter). Then it is genuinely mutating and needs the
receipt — see open question 6.

---

## 6. Error codes the client needs distinguished

Under the recommended shape, **no new error codes are strictly required**. The
three cases already have distinct, correctly-mapped codes:

| Case                            | Code                                        | Client mapping today                                           |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Device explicitly revoked       | `DEVICE_REVOKED`                            | → `grantStatus: "revoked"`, terminal (`syndicateErrors.ts:87`) |
| Grant expired, refresh refused  | `DEVICE_UNAUTHORIZED`                       | → `grantStatus: "expired"`, terminal (`:88`)                   |
| Called with plenty of life left | _no error_ — return the current certificate | writes the same `expiresAt` back, no-op                        |

That last row is a deliberate recommendation: **do not define a "too early"
error.** Let `device.refresh` always succeed and return whatever the current
certificate is, minting a new one only when the remaining life is inside the
Host's renewal window. The client then has one unconditional code path and no
branch that can misfire. If Syndicate would rather reject early calls, the code
must be `retryable: true` and must not be one the client maps to a dead grant —
`REFRESH_TOO_EARLY` would be fine; anything matching `syndicateErrors.ts:84-91`
would wrongly mark a healthy grant as dead.

One optional improvement, cheap and useful: **split `DEVICE_UNAUTHORIZED` into a
distinct `GRANT_EXPIRED`** for the expiry case specifically. The check at
`controller-auth.ts:536` runs _after_ signature verification, so distinguishing
them leaks nothing to an unauthenticated caller — the oracle argument in the
comment at `:525-530` applies to the row-miss collapse into `INVALID_SIGNATURE`,
not to this line. PacketADE already reserves `GRANT_EXPIRED` as a local code and
maps it to `expired` (`syndicate_relay.rs:46`, `syndicateErrors.ts:90`), so a
Host-emitted `GRANT_EXPIRED` lands correctly with **zero client change** and
lets the UI say "your 30-day grant ran out, re-pair" instead of a generic
authorization failure.

Rate limiting, if any, needs `retryable: true` so the client backs off rather
than declaring the grant dead.

---

## 7. Capability discovery

An older Host does not merely reject an unknown method — it answers
`{code: "INVALID_REQUEST", retryable: false}` with **`requestId: "invalid"`**
(`apps/host/src/server.ts:1778-1779`, because `parseControllerRequest` rejects
any method absent from `controllerMethodScope`, `controller-contract.ts:118`).
PacketADE checks response correlation _before_ reading the error
(`syndicate.rs:1275-1277`), so the client sees the untyped local message
_"Syndicate returned a response for a different protocol request"_ — **no code,
no `retryable`**. Blind-probing for the method therefore produces a confusing,
unclassifiable failure.

**Ask:** advertise support in `machine.snapshot`. A string array on the
`controller` block, e.g. `controller.methods: ["device.refresh", ...]` or a
narrower `controller.features`. PacketADE's snapshot parser builds a whitelisted
object and ignores unknown fields (`src/types/syndicate.ts:244-281`), and the
native `RpcResponse` is deliberately **not** `deny_unknown_fields`
(`syndicate.rs:183-194`), so this is a purely additive change that shipped
builds tolerate. Without it, PacketADE has to gate the call on a Host version
string it does not currently receive.

---

## 8. Client behaviour

**Proactive, at the existing 7-day threshold.** `SYNDICATE_GRANT_WARNING_DAYS`
already exists (`syndicateMachineStatus.ts:107`) and already produces the
`expiring` state (`:118-119`). The change is that `expiring` becomes
_actionable_ rather than merely informational: the same threshold now triggers
a refresh instead of only painting a badge. Natural hook is
`syndicateStore.refresh` (`:267-339`) — it already runs `machine.snapshot`, and
already writes `grantExpiresAt` at `:299`, so it knows the remaining life at
exactly the moment a follow-up call is cheapest. Also attempt on app start for
any machine already inside the window.

Seven days is generous against a 30-day term: a device that connects even once a
week never expires, and a device that has been dark for three weeks still has a
week of grace in which any single launch renews it.

**On demand.** A "Renew grant" action on the machine card, beside the existing
expiry line (`SyndicateMachinesCard.tsx:490-500`), whose copy stops saying
"grants cannot be renewed". This covers a user who returns to a machine inside
the window and wants to renew before starting work.

**Not on `DEVICE_UNAUTHORIZED`.** Under Option A a refresh at that point cannot
succeed, and wiring one into the failure path would re-create precisely the
unbounded retry loop the typed-error work removed
(`SyndicateTerminalPane.tsx:216-220`). The response to `DEVICE_UNAUTHORIZED`
stays: mark `expired`, stop retrying, offer re-pair. Under Option B this becomes
"attempt exactly one refresh, then fall back to the same terminal handling".

**Never while the integration is disabled.** This falls out of existing code —
`send_rpc_with_authority` gates every method on `require_integration_enabled`
except `device.revoke_self` (`syndicate.rs:1129-1149`, `:1693-1723`). Refresh
must not take the revoke exemption: revocation is the one operation that
_reduces_ authority, and refresh is the one that extends it. A user who flipped
the kill switch on suspicion must not have their grant quietly renewed.

### Should the refresh be silent, given `terminal.input`?

Arguments for silence: refresh grants **no new authority**. Same `deviceId`,
same keys, same scopes, same `revocationEpoch`. The operator already approved
this exact device with `terminal.input` at pairing, through a local browser
confirmation that enforced approved ⊆ requested
(`controller-auth.ts:409`). A confirmation prompt every 23 days that always
has one sensible answer is consent theatre, and trains the user to click through
prompts that _do_ matter.

Arguments against: 30 days is currently a hard ceiling on unattended
code-execution authority. Automatic renewal removes it, and the removal is
invisible.

**Recommendation: silent, on by default, but visible after the fact.** What
makes it acceptable is not a prompt, it is three properties that hold together:

1. Under Option A a refresh requires a live grant, so a device the user has
   stopped using still dies at 30 days. Silence never extends a dead credential.
2. The machine card shows the current expiry and can show the last renewal — so
   renewal is _observable_, not hidden. That is the property a prompt is
   actually trying to buy, obtained without training click-through.
3. The operator keeps instant browser-side revoke, propagated by the signed
   `grant_revoked` notice (`CONTROLLER_PROTOCOL_V1.md:273-276`).

If Syndicate picks Option B, this changes: a refresh accepted _after_ expiry is
a genuinely different act and should be user-confirmed on the PacketADE side and
recorded on the Host side.

---

## 9. Migration

**Devices with an unexpired grant when both halves ship:** nothing to do. Their
next `machine.snapshot` puts them inside or outside the renewal window, and the
existing capture path stores whatever certificate comes back. No re-pair, no
protocol version bump — `device.refresh` is an additive row in the method table
and every domain separator is unchanged.

**Devices already past 30 days:** must re-pair. The chain in §1 applies, and
PacketADE owns fixing it regardless of what Syndicate builds:

- `revoke` should fall back to local forget when `device.revoke_self` fails with
  a dead-grant code, so a user is not stuck between a Host call that can never
  succeed (`syndicateStore.ts:418`) and a local cleanup it gates
  (`:419`).
- The expired-state UI should route to `forgetOffline` + re-pair explicitly,
  and say that the Host will keep a stale device row until an administrator
  revokes it in the browser.

**Devices paired with no relay endpoint:** these are the awkward case.
`grantExpiresAt` is only ever read out of `relayGrant` inside `machine.snapshot`
(`src/types/syndicate.ts:294-299`), and `machine.snapshot` includes `relayGrant`
only when the device row has one (`apps/host/src/server.ts:1004`). In practice
`approveDevice` always mints one (`controller-auth.ts:414-427`) so the field is
present for any approved device — but PacketADE's own comment at
`src/types/syndicate.ts:33-36` assumes SSH-only pairings have none, and
`syndicateGrantExpiry` returns `unknown` in that case
(`syndicateMachineStatus.ts:113-115`), producing **no warning at all**. Either
that comment is stale or there is a Host path that omits the grant; see open
question 7. It matters because a proactive refresh window needs a reliable
expiry, and today the SSH-only path may silently have none.

---

## 10. Open questions for Syndicate

1. **Option A, B, or C?** Must a refresh be presented with a still-valid grant
   (A), or will `authenticate` carve out a bounded post-expiry window for
   `device.refresh` only (B)? If B, what is the window, and is the carve-out
   scoped strictly to `method === "device.refresh"` and `status === 'active'`?
   Everything else in this document assumes A.

2. **Will the result carry `relayGrant` in exactly the `machine.snapshot`
   shape** — `{grant, grantSignatureBase64Url}`, same canonical JSON, same
   `SYNDICATE-RELAY-GRANT-V1` signature domain? This is the difference between
   PacketADE reusing `capture_relay_grant` verbatim and writing a second
   certificate verifier.

3. **Scope: "active grant" (like `device.revoke_self`), or a named scope?** If
   named, which — and what happens to a device approved without it?

4. **Does the Host confirm the 30-day term stays?** PacketADE's shipped
   `validate_material` rejects any grant with `expires - issued > 31 days`
   (`syndicate_relay.rs:336`), so a longer term breaks existing builds.

5. **Confirmation that refresh never resets `controller_relay_counters`.** The
   AEAD key does not depend on the grant (§4.2); resetting counters across a
   refresh is nonce reuse under a reused key.

6. **Is refresh in `mutatingMethods`?** PacketADE's recommendation is no, with a
   random `requestId` per attempt, because a `stable_request_id` plus one
   `UNCERTAIN_DELIVERY` would permanently poison a device's ability to refresh.
   If Syndicate wants a receipt anyway, say so and PacketADE will use random ids
   with retry-on-`IDEMPOTENCY_CONFLICT` instead.

7. **Does refresh ever return `revocationEpoch` different from the current
   row's?** PacketADE will treat an increase as evidence of revocation; confirm
   that is right, or that it can never happen.

8. **Behaviour when the grant has plenty of life left:** return the current
   certificate unchanged (PacketADE's preference — one unconditional client
   path), or reject? If reject, what is the code, and can it be `retryable:
true`?

9. **Will `DEVICE_UNAUTHORIZED` be split so expiry gets its own code?**
   PacketADE already maps `GRANT_EXPIRED` to `expired` with no client change
   required. The check at `controller-auth.ts:536` is post-signature, so this
   leaks nothing.

10. **How does a client detect support?** Request: an additive
    `controller.methods` / `controller.features` array in `machine.snapshot`.
    Without it, probing an older Host yields a correlation mismatch rather than
    a typed verdict (§7), which is the least useful possible failure.

11. **Is there any Host configuration under which an approved device has no
    relay grant** — and therefore no `expiresAt` visible to the client at all
    (§9)? If not, PacketADE will treat a missing grant as an error rather than
    as "SSH-only, no expiry known", and fix its own stale comment.

12. **Should a post-expiry refresh (Option B only) be recorded on the device row
    and shown in the dashboard?** A grace window's security value is almost
    entirely in being visible to the operator.

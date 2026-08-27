# Syndicate grant-expiry acceptance runbook

Status: **acceptance not yet run.** The day-30 fix is verified against the
Host's source and against mocked payloads in PacketBench's own suites. It has
never been exercised against a grant that actually expired on real
infrastructure. This document is what someone follows to close that gap.

Written 2026-08-15. Companion to
[`syndicate-execution-target.md`](./syndicate-execution-target.md) (the target
contract and its broader acceptance matrix). The Host-side record of the
defect chain is Syndicate's `docs/PACKETBENCH_COORDINATION.md` §5.

Owner split: PacketBench owns this document and every client-side observation in
it. Syndicate owns the Host tree — **do not edit anything under
`/mnt/d/projects/syndicate` while running this runbook.** Method B below needs
a Host source change; that change is requested from Syndicate, not made here.

---

## 1. Why this path needs real-infrastructure proof

Grants last **30 days and have no renewal path**. The lifetime is hardcoded at
approval time — `expiresAt: new Date(this.now() + 30 * 24 * 60 * 60 * 1_000)`
(`syndicate/apps/host/src/controller-auth.ts:420`) — and the same value is
written to both the device row's `grant_expires_at` and the Host-signed relay
grant in one statement (`controller-auth.ts:425-426`). Every paired device
therefore reaches this cliff, at a predictable time, with no recovery except
re-pairing.

What is already proven, and by what:

| Claim                                                                  | Evidence                                                              | Level             |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| `retryable: false` classifies as fatal; absent verdict stays retryable | `src/lib/__tests__/syndicateErrors.test.ts:37,58`                     | unit, mocked      |
| Poll loop stops on an expired-grant rejection                          | `src/components/session/__tests__/SyndicateTerminalPane.test.tsx:135` | component, mocked |
| Poll loop stops on a revoked grant and records `revoked`               | `SyndicateTerminalPane.test.tsx:202`                                  | component, mocked |
| `DEVICE_UNAUTHORIZED` marks the machine `expired`                      | `src/stores/__tests__/syndicateStore.test.ts:262`                     | store, mocked     |
| The Host's `expiresAt` is captured for the warning                     | `syndicateStore.test.ts:305`                                          | store, mocked     |

None of that proves the wire shape a real Host emits at the moment a real
grant dies, and none of it exercises the transport. That is this runbook's job.

## 2. The two expiry paths are different code

An expired grant produces **one of two entirely different failures**, decided
by which transport carried the request. Both must be covered; proving one says
nothing about the other.

|                        | Host-reported expiry                                                                | Client-local expiry                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Code                   | `DEVICE_UNAUTHORIZED`                                                               | `GRANT_EXPIRED`                                                                                                                    |
| Decided by             | `syndicate/apps/host/src/controller-auth.ts:536-537`                                | `src-tauri/src/commands/syndicate_relay.rs:331-338`                                                                                |
| Reached over           | Managed SSH forward (`syndicate.rs:1233-1272`)                                      | PacketRelay, before any bytes leave the machine                                                                                    |
| Also reachable         | any relay request whose _signed grant_ is still valid but whose Host row has passed | in-flight variant at `syndicate_relay.rs:236-238`                                                                                  |
| Typed as               | forwarded verbatim from `RpcError` (`syndicate.rs:1281-1299`)                       | `SyndicateCommandError::local_typed`, `retryable: false` (`syndicate_relay.rs:333-341`, `syndicate.rs:333-340`)                    |
| Banner text            | `DEVICE_UNAUTHORIZED: Syndicate rejected the controller request · correlation <id>` | `PacketRelay request failed without an automatic retry over SSH: The Syndicate relay grant is expired or has an invalid lifetime.` |
| Mapped to grant status | `expired` via `DEAD_GRANT_CODES` (`src/lib/syndicateErrors.ts:84-91`)               | `expired`, same table                                                                                                              |

Transport selection is `use_relay_transport(relay_endpoint, relay_grant_available)`
(`src-tauri/src/commands/syndicate.rs:745-747`): the relay is used **only** when
the pairing has a relay endpoint _and_ a stored grant. There is no fallback —
a failed relay request is never resent over SSH (`syndicate.rs:1212-1223`).

The consequence that matters for test design: on a relay-configured pairing,
`validate_material` runs before every single request (`syndicate_relay.rs:141-146`)
and rejects a grant whose `expiresAt` has passed. So **a relay pairing whose
grant has genuinely expired never reaches the Host at all**, and you will never
see `DEVICE_UNAUTHORIZED` from it. To exercise the Host's line 536 on a relay
pairing you must expire the _row_ without expiring the _signed grant_ — which
is exactly what Method A does.

The stored relay grant cannot be tampered with to force the client-local path:
it is canonical-JSON and Ed25519-verified against the Host signing key on every
use (`syndicate_relay.rs:322-330`, and the `SYNDICATE-RELAY-GRANT-V1` verify at
`syndicate_relay.rs:374-377`). Only the Host can issue a short-lived grant.

## 3. Producing an expired grant without waiting 30 days

### What the Host exposes: nothing

Verified: grant lifetime is the hardcoded literal at `controller-auth.ts:420`.
It is not in `HostConfig` and there is no `SYNDICATE_*` environment variable
for it (`syndicate/apps/host/src/config.ts:255-320`). The `now` constructor
parameter (`controller-auth.ts:196`) is real but production wires `Date.now`
explicitly (`syndicate/apps/host/src/server.ts:610`); it is a test seam, not an
operator control. _Invite_ lifetime is configurable (`expiresInSeconds`, capped
at 15 minutes, `controller-auth.ts:28,246-247`) — that is the pairing invite,
not the grant, and shortening it proves nothing here.

So there are four options, in descending fidelity per unit of effort.

### Method A — rewrite `grant_expires_at` in the Host's SQLite row

```bash
# On the Syndicate host, as the service user.
# Default DB path (config.ts:285): $SYNDICATE_HOME/data/syndicate.db
#   SYNDICATE_HOME defaults to $XDG_STATE_HOME/syndicate, i.e.
#   ~/.local/state/syndicate  (config.ts:264-267)
DB=~/.local/state/syndicate/data/syndicate.db

sqlite3 "$DB" "SELECT id, name, status, grant_expires_at FROM controller_devices;"

# Take a copy first. This is the only reversible artefact in the whole run.
sqlite3 "$DB" ".backup '/tmp/syndicate-preexpiry.db'"

# Expire it (past):
sqlite3 "$DB" "UPDATE controller_devices SET grant_expires_at = '2026-01-01T00:00:00.000Z' WHERE id = '<deviceId>';"

# Or park it inside the 7-day warning window (future):
sqlite3 "$DB" "UPDATE controller_devices SET grant_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 days') WHERE id = '<deviceId>';"
```

**What it exercises.** The literal production predicate at
`controller-auth.ts:536` — `row.status !== "active" || (row.grant_expires_at &&
Date.parse(row.grant_expires_at) <= this.now())` — and its
`DEVICE_UNAUTHORIZED` branch, on a real signed request over a real transport.
This is the _real_ Host code path. Nothing is simulated on the Host side.

**What it gives up.** It does not expire the Host-signed relay grant, so
PacketBench's own `validate_material` check never fires. Method A cannot produce
`GRANT_EXPIRED`.

**Notes.**

- `authenticate` does a fresh `SELECT` per request (`controller-auth.ts:530`)
  and the long-stream re-check `deviceIsActive` does the same
  (`controller-auth.ts:281-285`). There is no cache. **The very next poll after
  the `UPDATE` sees the new value** — no restart, no reconnect. That is what
  makes it possible to cross the cliff _while a pane is attached and polling_,
  which is matrix row 4.
- The Host uses better-sqlite3 in WAL mode; a concurrent `sqlite3` writer is
  safe, but do not hold a long transaction open.
- Roll back by restoring the backup, or by setting `grant_expires_at` back to
  its original ISO string (capture it in the first `SELECT`).
- No re-pairing is needed to undo it, which makes this the cheapest method to
  run repeatedly.

### Method B — have Syndicate build a short-lifetime Host

Ask Syndicate to change `30 * 24 * 60 * 60 * 1_000` at `controller-auth.ts:420`
to, say, `10 * 60 * 1_000`, on a **test host only**, then restart the service
and re-pair PacketBench against it.

**What it exercises.** Everything, at full fidelity, in the correct order: a
genuinely Host-signed short-lived grant means the row and the signed certificate
expire in the same instant, so the client-local `GRANT_EXPIRED` check
(`syndicate_relay.rs:331-338`) fires on the relay path and `DEVICE_UNAUTHORIZED`
fires on the SSH path — each on its own real code, with no clock or database
tampering anywhere. **This is the only method that proves the client-local path.**

**What it gives up.** It needs a Host source change and a rebuild, and it is
Syndicate's tree to change — coordinate, do not edit. It also needs a re-pair
per iteration (approve device in the local Syndicate UI each time), so it is
slow to repeat. And a minutes-long grant distorts the warning arithmetic:
`syndicateGrantExpiry` computes `Math.ceil((expiresAt - now) / 86_400_000)`
(`src/lib/syndicateMachineStatus.ts:117`), so any sub-day grant renders as
"expires in 1 day". Use lifetimes of ~6 days and ~8 days if you want to test
the warning boundary with this method; otherwise test the boundary with
Method A, which sets the date directly.

Note `validate_material` also rejects a grant whose _span_ exceeds 31 days
(`syndicate_relay.rs:335-338`) — a shortened lifetime is well inside that, but
do not ask for a _lengthened_ one.

### Method C — move a clock

Three variants, and two of them do not work.

- **C1, controller clock forward.** Fires the client-local `GRANT_EXPIRED`
  (`syndicate_relay.rs:331-338`) and makes the card render the expired copy,
  because `syndicateGrantExpiry` compares against `Date.now()`
  (`syndicateMachineStatus.ts:112-116`). But on the SSH path the Host rejects
  the honestly-timestamped envelope with **`STALE_AUTH_ENVELOPE`** first —
  `Math.abs(this.now() - timestamp) > MAX_CLOCK_SKEW_MS` where
  `MAX_CLOCK_SKEW_MS = 60_000` (`controller-auth.ts:26,522`) — so line 536 is
  never reached.
- **C2, Host clock forward.** Symmetrically useless: the grant does expire, but
  the same 60-second skew check rejects the client's envelope with
  `STALE_AUTH_ENVELOPE` before the grant is ever evaluated. **A Host-only clock
  move can never produce `DEVICE_UNAUTHORIZED`.**
- **C3, both clocks moved together, within 60 seconds of each other.** This does
  work — SSH gives `DEVICE_UNAUTHORIZED`, relay gives `GRANT_EXPIRED`. But
  jumping two machines 30 days forward also expires TLS chains, fires every
  other time-based sweep on the Host (pairing invites at
  `controller-auth.ts:364`, nonce expiry at `:546-549`, receipt bookkeeping),
  and desynchronises every log timestamp you would use to attribute the result.

**The trap in C1 and C2:** `STALE_AUTH_ENVELOPE` is also `retryable: false`
(`ControllerProtocolError`'s default, `controller-auth.ts:103`), so the poll
loop stops and the pane says "Disconnected" — the test _looks_ like it passed.
It did not; it proved the skew check, not the expiry check. **Always read the
error code in the banner, never just the stop.** If you use Method C at all,
treat it as C3 only, and treat it as a simulation.

### Method D — pair a device and wait 30 days

The only method that proves nothing was overlooked. Unusable as a release gate,
but worth starting: pair a dedicated long-lived test device today, record the
`grant_expires_at`, and schedule a check for day 29 (warning) and day 31
(expiry). It costs nothing to run in the background and is the only evidence
that the real 30-day value behaves as the shortened ones did.

### Recommendation

**Run Method A for everything Host-reported, and request Method B once for the
client-local path.**

Method A is the only option that touches the exact production predicate at
`controller-auth.ts:536` with no other variable changed, is reversible from a
backup, takes effect on the next request without a restart, and is the only way
to cross the cliff mid-poll on an attached pane. Method B is unavoidable for
`GRANT_EXPIRED` — the signed grant cannot be forged or edited, so only the Host
can issue a short-lived one — but it needs a cross-repo request and a re-pair
per iteration, so run it once, deliberately, for rows 5 and 6b. Method C is a
simulation with a failure mode that mimics success; use it only if B is
unavailable, and only as C3. Method D runs in the background regardless.

---

## 4. Setup before running the matrix

1. A Syndicate test host, service running (`systemctl --user status
syndicate.service`), reachable through a verified `ServerConfig` with
   `hostFingerprint` populated. Never a production host.
2. Two pairings if you want rows 5 and 7 in one pass: one paired **with** a
   relay endpoint, one **without**. `use_relay_transport` needs both an endpoint
   and a stored grant (`syndicate.rs:745-747`), so leaving the relay endpoint
   blank in the pairing form is what makes a pairing SSH-only.
3. PacketBench running from `pnpm tauri dev` so the devtools console and
   localStorage are available.
4. Keep these open while testing:
   - **Tools → Syndicate machines** card (`SyndicateMachinesCard.tsx`).
   - The Workspace with the Syndicate-targeted terminal pane.
   - Devtools → Application → Local Storage → key
     `packetbench:syndicate-machines-v1` (`syndicateStore.ts:32`, prefix from
     `src/lib/brand.ts:14`). `grantStatus` and `grantExpiresAt` are visible
     there and are the store's own record, independent of what the card paints.
   - Devtools → Network, filtered to the loopback forward, to count
     `session.attach` requests. This is the primary regression instrument.
5. Record, for each pairing: `machineId`, `deviceId`, the original
   `grant_expires_at`, and which transport the card reports under
   "Last successful path".

---

## 5. Acceptance matrix

Each row is independent. Restore `grant_expires_at` between rows unless the row
says otherwise. "The card" means the machine row in **Tools → Syndicate
machines**; "the pane" means the Syndicate terminal pane.

### 1. Healthy grant renders its expiry

- **Preconditions.** Active grant, more than 7 days remaining, integration
  enabled, a successful `machine.snapshot` in this session.
- **Steps.** Open the card. Press the Refresh button on the machine row.
- **Expected.** Status chip reads `active` (green). Below the transport lines,
  muted grey text: `Grant expires <local date-time> · N days left`, with N > 7
  (`SyndicateMachinesCard.tsx:496-501`). `grantExpiresAt` is a finite number in
  localStorage, equal to `Date.parse(grant_expires_at)` from the Host row
  (`syndicateStore.ts:299`, `src/types/syndicate.ts:294-299`).
- **Fails if.** No expiry line at all — that means `grantExpiresAt` is
  undefined and `syndicateGrantExpiry` returned `unknown`
  (`syndicateMachineStatus.ts:113-115`); see row 7.

### 2. Warning window paints the countdown

- **Preconditions.** Row 1 passed. Method A available.
- **Steps.** `UPDATE controller_devices SET grant_expires_at =
strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 days') WHERE id = '<deviceId>';`
  then press Refresh on the card.
- **Expected.** The muted line is replaced by **amber** text: `This device grant
expires in 3 days (<date-time>). Grants cannot be renewed — pair this machine
again before then to avoid an interruption.`
  (`SyndicateMachinesCard.tsx:490-495`). Status chip is still `active`.
- **Boundary.** Repeat at `+8 days` → muted "N days left" wording (valid).
  At `+7 days` → amber. The threshold is
  `SYNDICATE_GRANT_WARNING_DAYS = 7` with `Math.ceil` day arithmetic
  (`syndicateMachineStatus.ts:107,117-120`), so `+6 days 20 hours` reports
  "7 days", not "6".
- **Fails if.** Amber copy appears outside the window, or the countdown never
  appears while `grantExpiresAt` is populated.

### 3. Expiry crosses while a pane is attached and polling — SSH path

**This is the row the fix exists for.**

- **Preconditions.** SSH-only pairing (no relay endpoint). A Syndicate terminal
  pane open, `alive`, footer showing `running`, cursor advancing. Devtools
  Network open and filtered to `session.attach`. Grant currently valid.
- **Steps.**
  1. Confirm the poll is idling at ~350 ms / advancing on output
     (`SyndicateTerminalPane.tsx:202`).
  2. On the Host, run the Method A expire-to-the-past `UPDATE`.
  3. Watch the next `session.attach`.
- **Expected.**
  - The next attach returns `ok: false` with `error.code =
"DEVICE_UNAUTHORIZED"`, `retryable: false`.
  - The pane's red banner reads `Disconnected · DEVICE_UNAUTHORIZED: Syndicate
rejected the controller request · correlation <id>` — **"Disconnected", not
    "Reconnecting"** (`SyndicateTerminalPane.tsx:568-571`).
  - Footer state changes `running` → `detached`
    (`SyndicateTerminalPane.tsx:576-584`).
  - **`session.attach` stops. Zero further requests, ever.** The loop `break`s
    on `isFatalSyndicateError` (`SyndicateTerminalPane.tsx:216-220`).
  - The card's status chip flips `active` → `expired` without any user action,
    because the poll's catch calls `recordControllerFailure`
    (`SyndicateTerminalPane.tsx:206-208` → `syndicateStore.ts:437-450`), and the
    machine's `grantStatus` in localStorage becomes `"expired"` and persists.
  - The card shows amber: `This device grant has expired. Syndicate rejects its
requests until you pair this machine again.`
    (`SyndicateMachinesCard.tsx:482-489`).
  - The permissions list flips from Granted to **"Previously granted"** and the
    authority summary to **"Expired"** — `effectiveScopes` empties once
    `grantStatus !== "active"` (`SyndicateMachinesCard.tsx:397-398,604-626`,
    `syndicateMachineStatus.ts:46`).
- **Watch for at least 60 seconds.** The pre-fix signature was a retry every
  5 s (backoff capped at `5_000`, `SyndicateTerminalPane.tsx:222`), so a minute
  of silence is ~12 absent requests.

### 4. Same crossing, PacketRelay path, Host-reported

- **Preconditions.** Relay-configured pairing, "Last successful path" showing
  `PacketRelay`, pane attached and polling.
- **Steps.** Method A `UPDATE` (row only — the signed grant stays valid, so the
  client's own check passes and the request reaches the Host).
- **Expected.** Identical outcome to row 3 — `DEVICE_UNAUTHORIZED`, poll stops,
  card flips to `expired` — but the banner is prefixed `PacketRelay request
failed without an automatic retry over SSH:` (`syndicate.rs:1216-1221`).
- **Also expected.** **No SSH request is made after the relay rejection.** The
  no-silent-fallback rule is `syndicate.rs:1212-1223`; a retry over the tunnel
  here would be a separate, serious regression.

### 5. Client-local expiry, PacketRelay path (`GRANT_EXPIRED`)

- **Preconditions.** Method B host (short-lifetime grant), relay-configured
  pairing, freshly re-paired, pane attached and polling. Requires Syndicate to
  have built the short-lifetime Host.
- **Steps.** Let the grant's own `expiresAt` pass while the pane polls.
- **Expected.**
  - Banner: `Disconnected · PacketRelay request failed without an automatic
retry over SSH: The Syndicate relay grant is expired or has an invalid
lifetime.` — no Host error code, because the Host was never contacted
    (`syndicate_relay.rs:141-146,331-338`).
  - Poll stops; card flips to `expired`. `GRANT_EXPIRED` maps to `"expired"` in
    `DEAD_GRANT_CODES` (`syndicateErrors.ts:84-91`), and `local_typed` sets
    `retryable: false` (`syndicate.rs:333-340`).
  - **Nothing appears on the wire.** No relay frame, no SSH request. Confirm in
    Network and, if you have access, in the Host log — the Host should record
    no rejected request at all for this device.
- **Variant 5b (in-flight).** If the grant lapses between sending and receiving,
  the message is `The Syndicate relay grant expired while awaiting the Host
response.` (`syndicate_relay.rs:35-36,236-238`), classified identically. Hard
  to hit deliberately; record it if you see it, do not chase it.

### 6. Grant already expired at app start

- **Preconditions.** Grant expired (Method A or B). PacketBench **closed**. A
  Workspace with a Syndicate pane that has `autoStart` on and a persisted
  `syndicateSessionId`.
- **Steps.** Start PacketBench. Open the Workspace. Do not touch the card.
- **Expected.**
  - `startOrAttach` runs after its 200 ms delay
    (`SyndicateTerminalPane.tsx:529-537`), the attach is rejected, and the pane
    writes a red line **into the terminal buffer**: `[Syndicate]
DEVICE_UNAUTHORIZED: …` (`SyndicateTerminalPane.tsx:328-333`) plus the
    banner above it.
  - Footer reads `detached`. **No poll loop ever starts** — `pollOutput` is only
    launched after a successful start/attach (`SyndicateTerminalPane.tsx:326-327`),
    so the request count here is exactly **one**, not one per 5 s.
  - **Known asymmetry, expected and worth recording:** `startOrAttach`'s catch
    does _not_ call `recordControllerFailure` (contrast the poll's catch at
    `:206-208`). So the card may still show `active` with the full permission
    list until some other controller call runs. Press Refresh on the card —
    `refresh` classifies the failure itself (`syndicateStore.ts:320-328`) and
    the chip then flips to `expired`. Record which state the card was in
    _before_ you pressed Refresh; that is the finding.
  - Restored `grantStatus: "expired"` from a previous session survives reload —
    `loadMachines` validates it against `GRANT_STATUSES` and drops unrecognised
    values rather than defaulting them (`syndicateStore.ts:67,84-88`).
- **Variant 6b.** Same on a Method B relay pairing: expect the `GRANT_EXPIRED`
  message instead, and again a single attempt.

### 7. SSH-only pairing: does expiry data arrive at all?

**Record the actual result; this row exists because the source and the code
comments disagree.**

- **Preconditions.** A pairing created with the relay endpoint field left blank,
  approved on the Host, one successful Refresh.
- **Steps.** Read the card's expiry line and `grantExpiresAt` in localStorage.
- **Two possible results, both valid findings.**
  - **(a) A countdown appears.** This is what the Host source predicts:
    `approveDevice` writes a relay grant on **every** approval regardless of
    relay configuration (`controller-auth.ts:417-426`), `deviceFromRow` returns
    it whenever both columns are populated (`controller-auth.ts:146-149`), and
    `machine.snapshot` spreads it unconditionally —
    `...(device.relayGrant ? { relayGrant: device.relayGrant } : {})`
    (`syndicate/apps/host/src/server.ts:1004`), with no dependence on
    `controllerRelayUrl`. `parseMachineSnapshot` passes `controller` through
    untouched (`src/types/syndicate.ts:261`), so `grantExpiryFromSnapshot`
    should find `expiresAt`.
  - **(b) No expiry line; `grantExpiresAt` undefined; `syndicateGrantExpiry`
    returns `unknown`.** This is what `src/types/syndicate.ts:29-35` and
    `syndicateMachineStatus.ts:96-98` currently claim ("Undefined when the Host
    has issued no relay grant, which is the case for SSH-only pairings").
- **Either way**, row 3 must still pass for this pairing — the Host verdict does
  not depend on the client knowing the expiry date. If the result is (a), the
  two comments above are stale and should be corrected. If it is (b), find out
  why the grant is absent from the row (a `device.revoke_self` clears
  `relay_grant_json`, `controller-auth.ts:478-480`) and record it.
- **`unknown` is never rendered as safe.** Confirm the card shows no expiry text
  at all rather than an optimistic one — the states are exhaustive and `unknown`
  falls through to `null` (`SyndicateMachinesCard.tsx:482-501`).

### 8. Revoked is not expired

- **Preconditions.** A second paired device (or restore the first). Grant
  active and **not** expired. Pane attached and polling.
- **Steps.** On the Host: `POST /api/v1/controller/devices/<deviceId>/revoke`
  from the local Syndicate dashboard (the route requires the dashboard's
  `syndicate_session` cookie — `server.ts:1723`, guard at `server.ts:1627-1634`),
  or use the device list in the local browser UI.
- **Expected.**
  - Rejection code is **`DEVICE_REVOKED`**, not `DEVICE_UNAUTHORIZED` — the Host
    branches on `row.status === "revoked"` first (`controller-auth.ts:536-537`).
  - Card status chip reads `revoked`; authority summary reads **"Revoked"**, not
    "Expired" (`syndicateMachineStatus.ts:45-46`,
    `DEAD_GRANT_CODES` mapping at `syndicateErrors.ts:87`).
  - Poll stops, same as row 3.
  - The expired-specific copy ("pair this machine again…") does **not** appear;
    the card's expiry block is gated on `grantStatus === "expired"`
    (`SyndicateMachinesCard.tsx:482`).
- **Why this row matters.** The two codes collapsing into one status would hide
  a revocation behind an "it just expired, re-pair it" message — the opposite of
  the security signal intended.
- **Relay variant.** If PacketRelay reports the revocation itself, the message is
  `This PacketBench device was revoked by Syndicate.` and classifies as
  `DEVICE_REVOKED` too (`syndicate_relay.rs:34,50-52`) — the same status from
  either detector.

### 9. Recovery: Revoke fails on an expired grant, Forget locally works

- **Preconditions.** Machine in `expired` state from row 3 or 6.
- **Steps.** Press the **Revoke** (trash) button on the card and confirm.
- **Expected.** It **fails**, and the modal shows the failure under
  "Revocation did not complete" (`SyndicateMachinesCard.tsx:807-817`).
  `device.revoke_self` is an ordinary signed controller RPC
  (`syndicate.rs:1693-1723`) and `authenticate` runs before the method
  dispatch (`controller-auth.ts:456,470`), so an expired grant cannot revoke
  itself — `DEVICE_UNAUTHORIZED` again. The machine stays in the list.
- **Then.** Press **Forget locally** (unlink) and confirm. This must succeed: it
  is local-only, deletes the OS-keychain record, opens no transport, and is
  deliberately ungated (`syndicate.rs:1684-1691`, `syndicateStore.ts:427-435`).
  The machine disappears from the card and from
  `packetbench:syndicate-machines-v1`.
- **Also confirm** both buttons are enabled while the integration switch is
  **off** — they are deliberately not gated on it
  (`SyndicateMachinesCard.tsx:544-571`, `syndicateStore.ts:411-414`).
- **Note.** Forget-locally leaves the grant row on the Host. Clean up the test
  host's `controller_devices` afterwards, or the next pairing accumulates a
  dead row.

### 10. Re-pairing restores service and the pane recovers cleanly

- **Preconditions.** Row 9 completed (machine forgotten locally). The stale pane
  still open in its Workspace, showing the expired banner.
- **Steps.**
  1. On the Host, create a fresh controller invite and approve the new device in
     the local Syndicate UI.
  2. In PacketBench: **Pair machine**, same SSH server, paste the payload.
  3. Refresh the card.
  4. Return to the Workspace pane and restart it from the pane header.
- **Expected.**
  - Pairing succeeds. It would have been _refused_ had the old record still been
    present — `pair` rejects a duplicate `machineId` with "This Syndicate machine
    is already paired…" (`syndicateStore.ts:210-235`), which is why row 9 must
    run first.
  - Card returns to `active`, full permission list Granted, and a fresh
    `Grant expires <date> · 30 days left` (`approveDevice` issues a new 30-day
    grant, `controller-auth.ts:420`).
  - **The pane resets rather than reusing dead identities.** The new `deviceId`
    differs, so the device-change effect clears `syndicatePaneId`,
    `syndicateTerminalSessionId`, `syndicateSessionId` and the cursor, and bumps
    the operation generation (`SyndicateTerminalPane.tsx:494-527`).
  - Restart creates a _new_ Host pane and session and streams normally. Footer
    returns to `running`, banner clears.
  - **Failure signature to watch for:** a `SESSION_NOT_OWNED` rejection means the
    pane attached the previous device's session — the exact bug the comment at
    `SyndicateTerminalPane.tsx:488-493` records.

### 11. Negative control: an ordinary fault must still retry

**Run this last. Without it, "the loop stopped" proves nothing — a loop that
stops on everything would pass rows 3 through 6.**

- **Preconditions.** Valid, unexpired grant. Pane attached, polling, healthy.
- **Steps.** Break the transport without involving the grant: stop the Syndicate
  service (`systemctl --user stop syndicate.service`) or drop the SSH forward.
  Wait ~30 seconds. Restore it.
- **Expected.**
  - Banner reads **"Reconnecting"**, not "Disconnected"
    (`SyndicateTerminalPane.tsx:221,570`).
  - `session.attach` keeps being attempted, with the interval doubling to a
    5 s ceiling (`SyndicateTerminalPane.tsx:222`).
  - Card `grantStatus` stays `active` — a local fault carries no Host verdict,
    so `grantStatusFromSyndicateError` returns `undefined` and
    `recordControllerFailure` is a no-op (`syndicateErrors.ts:108-113`,
    `syndicateStore.ts:437-439`).
  - On restore, the pane reconnects on its own and resumes from its cursor with
    no duplicated output.
- **Fails if.** The pane gives up permanently on a transient fault. That is the
  over-correction failure mode: `isFatalSyndicateError` requires
  `retryable === false` explicitly, and an _absent_ verdict must never read as
  fatal (`syndicateErrors.ts:103-105`).

---

## 6. How to observe

**The pane banner** (`SyndicateTerminalPane.tsx:568-572`) is the fastest read.
Its first word is the verdict: `Reconnecting` = the loop is still alive,
`Disconnected` = it stopped. The text after `·` is the message, which for a Host
rejection always begins with the error code (`syndicate.rs:1282-1296`) — read
the code, not just the state.

**The pane footer** (`:574-592`) gives `running` / `detached` / `disabled` /
`initializing` / `blocked`, plus the live cursor value. A frozen cursor with a
`running` state means output stopped but the loop did not.

**The terminal buffer** carries start-time failures that predate any banner —
`[Syndicate] <message>` in red (`:331`). Only `startOrAttach` writes there, so
its presence tells you the failure happened at start, not mid-poll.

**The machines card** is the durable record: status chip, expiry paragraph,
authority summary, and the per-scope Granted / Previously granted list. Note the
chip prefers `offline` (red) when a `connectionError` is set, which can mask the
grant status momentarily (`SyndicateMachinesCard.tsx:414-432`) — the
paragraph below and the authority summary are the reliable reads.

**localStorage `packetbench:syndicate-machines-v1`** is the store's own truth,
unmediated by rendering: `grantStatus`, `grantExpiresAt`, `scopes`,
`lastConnectedAt`. Check it whenever the card and the pane seem to disagree.

**Devtools Network** is the instrument for the regression itself. Filter to the
loopback forward and count `session.attach`. A healthy stopped loop shows a
final rejected request and then nothing. Approximate expected counts over
60 seconds: idle-healthy ≈ 170 (350 ms); backing-off ≈ 12–15; fatal-stopped = 0.

**Host side**, if you have shell access: the rejected request appears in the
Syndicate service log with its `correlationId`, which is echoed verbatim in
PacketBench's banner (`syndicate.rs:1292-1295`) — that is how you tie a specific
UI message to a specific Host decision.

---

## 7. Regression signatures

The fix has regressed if any of these appear.

1. **A `session.attach` repeating every ~5 seconds after a fatal rejection.**
   This is the original day-30 bug's exact signature: `DEVICE_UNAUTHORIZED`
   falling through to `setReconnecting(true)` with the backoff pinned at its
   5 s ceiling, re-signing a request that can never succeed, forever. Watch for
   it in Network; it is unmistakable — an evenly spaced request every 5 s with
   an identical rejection each time.
2. **The pane banner says "Reconnecting" on a Host verdict with
   `retryable: false`.** The word itself is the tell.
3. **The card still says "Full coding control" (or any Granted scope) for a
   machine the Host is rejecting.** Means the grant status was not recorded from
   the failure — `recordControllerFailure` not reached, or `DEAD_GRANT_CODES`
   no longer maps the code.
4. **`DEVICE_REVOKED` and `DEVICE_UNAUTHORIZED` producing the same UI state.**
   The distinction is deliberate; collapsing it hides a revocation behind
   re-pair advice.
5. **A relay rejection followed by the same request over SSH.** The
   no-silent-fallback guarantee is broken.
6. **A transient fault (service stopped, tunnel dropped) permanently stopping
   the loop.** The over-correction: an absent Host verdict being read as fatal.
7. **Any classification derived from message text rather than `code` /
   `retryable`.** The whole fix is that the typed fields cross the native
   boundary intact (`syndicateErrors.ts:3-17,50-71`). A new regex over
   `error.message` anywhere in this path is a regression even if it currently
   produces the right answer.
8. **`grantStatus` silently defaulting.** An unrecognised persisted status must
   be dropped, not coerced — a dead grant reading as `active` is how the
   original bug presented (`syndicateStore.ts:82-88`).

---

## 8. What this runbook cannot establish

- **The real 30-day value.** Every method here shortens or relocates the
  deadline. Only Method D confirms the production constant behaves as the
  shortened ones did.
- **`RpcError.retryable` when the field is absent.** It deserializes with
  `#[serde(default)]` → `false` (`syndicate.rs:196-202`), so a Host that ever
  omitted it would make every rejection fatal. Today's Host always sends it
  (`controller-auth.ts:497`), so this cannot be exercised without a
  protocol-violating Host. Note it, do not test it.
- **The relay's `routeRevoked` frame** (`syndicate_relay.rs:252-254`) needs the
  relay operator to revoke a route; it is out of reach from either repo's test
  environment.
- **Renewal.** There is none. `device.refresh` is Syndicate's P4#2 and does not
  exist. Re-pairing is the only recovery, and this runbook proves that it is a
  clean one — not that it is a good one.
- **Multi-device behaviour.** v1 is one device per Host machine
  (`syndicateStore.ts:208-235`), so "one device expires while another stays
  live" is not testable and not a supported configuration.

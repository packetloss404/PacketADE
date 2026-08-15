# Native controller protocol v1 — device ↔ relay half

Status: implemented and shipping in PacketADE. This document is the companion to
[`CONTROLLER_PROTOCOL_V1.md`](https://github.com/packetloss404/syndicate/blob/main/docs/CONTROLLER_PROTOCOL_V1.md)
in the Syndicate repository, which specifies the controller → Host authority and
the Host → relay leg. Syndicate owns the merged document; PacketADE wrote this
half because PacketADE owns the only device implementation.

Everything here was derived from source, not from intent:

- `packetade/src-tauri/src/commands/syndicate_relay.rs` — the device transport.
- `packetade/src-tauri/src/commands/syndicate.rs` — grant capture, canonical
  JSON, credential storage, and envelope construction.
- `packetrelay/src/product_route.rs` — the relay's admission and forwarding.
- `packetrelay/src/rate_limit.rs` — the relay's connection and message budgets.

Citations are `repo/path:line`. Where the two implementations disagree, or where
the source does not decide a question an independent client would have to
answer, this document says so rather than inventing a rule.

## Where this leg sits

The relay is a routing fabric, never an authority. It admits two roles onto one
self-certifying route — the Host (`host_hello`) and one or more devices
(`device_hello`) — and forwards opaque encrypted frames between them
(`packetrelay/src/product_route.rs:27-32`, `:512-586`). It can authenticate
route membership, enforce bounds, and drop a revoked device, but it cannot read
a controller request or response.

The payload carried inside the device's encrypted frame is the same signed
`{request, auth}` envelope the loopback HTTP surface accepts. Relay delivery
changes the transport and nothing else: the Host still verifies the
`SYNDICATE-CONTROLLER-V1` signature, the timestamp, the nonce, and the device's
scopes exactly as it does for an HTTP request.

**One RPC per connection.** PacketADE opens a fresh WSS connection for each
controller request, sends one frame, waits for one response, and closes
(`packetade/src-tauri/src/commands/syndicate_relay.rs:141-252`, `:247`). There
is no long-lived device socket today. A per-`(machineId, deviceId)` async mutex
serializes the whole exchange, because the relay admits one live socket per
device and because durable receive-counter ordering depends on it
(`syndicate_relay.rs:69-87`, `:129-130`).

**Delivery failures are never retried automatically.** The auth nonce cannot be
reused, and the Host may already have executed a request whose response was
lost (`syndicate_relay.rs:125-139`). A failed relay request is also never
resent over the SSH forward
(`packetade/src-tauri/src/commands/syndicate.rs:1213-1223`).

## Endpoint policy

The route is the exact path `/v1/product-route` over `wss://`
(`syndicate_relay.rs:64`, `:572-585`). PacketADE rejects, before any secret is
used:

- a scheme other than `wss`, except `ws` to `127.0.0.1`, `localhost`, or `::1`;
- any path other than `/v1/product-route`;
- any query string or fragment;
- any userinfo (`user:password@`) in the authority.

The endpoint is chosen from the pairing envelope's top-level `relayEndpoint`, or
from an explicit PacketADE override, which wins
(`syndicate.rs:1091-1097`). PacketADE validates the packaged endpoint through
the same policy _before_ claiming the one-use invitation
(`syndicate.rs:1068-1084`), so a hostile endpoint cannot burn the invite.

The relay serves the product route only on this exact target; a trailing slash
or a query string is classified as a different (rejected) route
(`packetrelay/src/main.rs:507-511`, `:646-655`).

## Route identity

The route id is derived, never provisioned:

```text
route_<base64url(SHA-256(Host Ed25519 SPKI DER))>
```

using unpadded base64url over the SHA-256 of the 44-byte RFC 8410
SubjectPublicKeyInfo DER, not the raw 32-byte key
(`packetrelay/src/product_route.rs:602-604`).

Three independent parties recompute it and must agree:

- the relay, against the key in `host_hello` and again against the key inside
  every `device_hello` grant (`product_route.rs:203`, `:274-277`);
- PacketADE, when it first captures a grant, against the Host key pinned at
  pairing (`syndicate.rs:950-956`);
- PacketADE, again on every relay connection, against the Host key inside the
  grant itself (`syndicate_relay.rs:361-371`).

A client must derive the route id and refuse a grant whose `routeId` does not
match. Accepting a server-supplied route id would give up the property the
design exists for: the route names a specific Host key and nothing else.

**A device cannot connect while the Host is offline.** Device admission looks
the route up in the relay's live table and fails with `host route is offline`
if the route is absent or has no connected Host
(`product_route.rs:295-300`). Only the Host creates a route.

## The device grant certificate

The grant is a Host-signed certificate that admits one device to one route. Its
schema is closed — both the relay and PacketADE parse it with
`deny_unknown_fields` (`product_route.rs:72-89`,
`syndicate_relay.rs:255-272`), so an extra field breaks admission on both
sides rather than being ignored.

```json
{
  "protocolVersion": 1,
  "type": "device_grant",
  "routeId": "route_<base64url(SHA-256(Host Ed25519 SPKI DER))>",
  "machineId": "syn_...",
  "deviceId": "device_...",
  "hostSigningPublicKeyBase64Url": "<Ed25519 SPKI DER, base64url>",
  "hostKeyAgreementPublicKeyBase64Url": "<X25519 SPKI DER, base64url>",
  "deviceSigningPublicKeyBase64Url": "<Ed25519 SPKI DER, base64url>",
  "deviceKeyAgreementPublicKeyBase64Url": "<X25519 SPKI DER, base64url>",
  "scopes": ["machine.read", "workspace.read"],
  "issuedAt": "2026-08-12T00:00:00.000Z",
  "expiresAt": "2026-09-11T00:00:00.000Z",
  "revocationEpoch": 0
}
```

| Field                                  | Type     | Rule                                                                            |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `protocolVersion`                      | integer  | Exactly `1`.                                                                    |
| `type`                                 | string   | Exactly `device_grant`.                                                         |
| `routeId`                              | string   | Must equal the derivation above from `hostSigningPublicKeyBase64Url`.           |
| `machineId`                            | string   | Relay: 8–128 bytes of `[A-Za-z0-9._-]`. Must match the route's Host.            |
| `deviceId`                             | string   | Same character class and length bound (`product_route.rs:266`, `:672-677`).     |
| `hostSigningPublicKeyBase64Url`        | string   | Ed25519 SPKI DER, 44 bytes, base64url unpadded.                                 |
| `hostKeyAgreementPublicKeyBase64Url`   | string   | X25519 SPKI DER, 44 bytes, prefix checked (`product_route.rs:663-671`).         |
| `deviceSigningPublicKeyBase64Url`      | string   | Ed25519 SPKI DER of the device key that signs `device_hello` and every frame.   |
| `deviceKeyAgreementPublicKeyBase64Url` | string   | X25519 SPKI DER of the device key used for ECDH.                                |
| `scopes`                               | string[] | 1–8 entries, **strictly ascending**, each from the fixed set below.             |
| `issuedAt`                             | string   | RFC 3339.                                                                       |
| `expiresAt`                            | string   | RFC 3339.                                                                       |
| `revocationEpoch`                      | integer  | Monotonic per device; must exceed any epoch the relay has already seen revoked. |

The SPKI encodings are the RFC 8410 forms. PacketADE checks the exact 12-byte
prefixes and a 44-byte total length (`syndicate_relay.rs:88-93`, `:618-628`):

```text
Ed25519  30 2a 30 05 06 03 2b 65 70 03 21 00 || 32-byte key
X25519   30 2a 30 05 06 03 2b 65 6e 03 21 00 || 32-byte key
```

The scope vocabulary is fixed and identical on both sides
(`syndicate_relay.rs:94-103`, `product_route.rs:678-695`):
`machine.read`, `session.start`, `terminal.input`, `terminal.resize`,
`terminal.stop`, `terminal.view`, `workspace.create`, `workspace.read`. The
strict-ascending requirement means the array is sorted **and** duplicate-free;
`["machine.read","machine.read"]` is rejected.

### Grant signature

```text
SYNDICATE-RELAY-GRANT-V1\n + canonical JSON of the grant object
```

Ed25519, by the Host signing key, encoded base64url unpadded
(`syndicate.rs:1002-1008`, `syndicate_relay.rs:374-379`,
`product_route.rs:280-285`). Canonical JSON here is the same construction the
rest of the protocol uses: object keys sorted recursively, array order
preserved, no insignificant whitespace, and no floating-point numbers
(`syndicate.rs:871-919`).

### Lifetime

The Host's policy is a 30-day grant. Both validators accept a **maximum span of
31 days** and additionally require `issuedAt` to be no more than one minute in
the future, `expiresAt` to be strictly in the future, and `expiresAt > issuedAt`
(`syndicate_relay.rs:330-339`, `product_route.rs:257-265`). A client should
treat 30 days as the issuance contract and 31 days as the validator's slack,
not as licence to issue a 31-day grant.

The relay also enforces expiry _during_ a connection: it arms a timer at
`expiresAt` and drops the device socket when it fires
(`product_route.rs:542-555`), and it refuses to route a Host frame to a device
whose certificate has expired, isolating that device instead of tearing down
the shared Host route (`product_route.rs:374-379`, `:482-510`). PacketADE
re-checks expiry on every inbound frame while a request is in flight
(`syndicate_relay.rs:236-238`).

### How a device obtains and verifies its grant

The grant is not delivered over the relay. It arrives in the `machine.snapshot`
result at `/controller/device/relayGrant`, as
`{grant, grantSignatureBase64Url}`, and PacketADE captures it only from that
method (`syndicate.rs:921-934`, `:1308-1310`). Because the first
post-approval snapshot must therefore travel over the pinned SSH forward, relay
selection is a proven pre-send condition, not a fallback: the transport is only
chosen when a relay endpoint is configured **and** a grant is already stored
(`syndicate.rs:745-747`, `:1187-1189`).

On capture, PacketADE verifies — before persisting anything — that the grant's
`protocolVersion`, `type`, `machineId`, and `deviceId` match the paired target;
that `routeId` matches the derivation from the Host key pinned at pairing; that
the grant's Host signing and key-agreement keys equal the pinned ones; that the
grant's device signing and key-agreement keys equal this device's own public
keys; and that the Host's Ed25519 signature over
`SYNDICATE-RELAY-GRANT-V1\n<canonical>` verifies
(`syndicate.rs:935-1008`).

It is the **canonical** serialization that is persisted, alongside the
signature (`syndicate.rs:1010-1011`), and every later load re-canonicalizes and
requires a byte-identical result before use (`syndicate_relay.rs:318-321`). An
independent client should store the canonical bytes for the same reason: the
grant hash inside `device_hello` is taken over exactly those bytes, and any
re-serialization that reorders keys produces a hash the relay will not accept.

Grants are held in the OS keyring next to the device private keys and the
directional counters (`syndicate.rs:703-717`).

## Admission: `device_hello`

The device's first frame after the WebSocket opens. It must arrive within the
relay's hello deadline (5 seconds by default,
`packetrelay/src/rate_limit.rs:15`, `product_route.rs:520-523`) and must be
**at most 16,384 bytes** — a tighter bound than the 65,536-byte cap that applies
to every later frame (`product_route.rs:524`).

```json
{
  "protocolVersion": 1,
  "type": "device_hello",
  "grant": { "...": "the device grant object above" },
  "grantSignatureBase64Url": "<Ed25519 signature, base64url>",
  "timestampMs": 1786000000000,
  "nonceBase64Url": "<random, base64url>",
  "proofSignatureBase64Url": "<Ed25519 signature, base64url>"
}
```

Field order on the wire is irrelevant — the relay parses with serde and
recomputes the grant's canonical form from the parsed struct
(`product_route.rs:280`). PacketADE happens to transmit the whole hello in
canonical (key-sorted) form because every outbound frame goes through
`send_bounded` (`syndicate_relay.rs:540-552`).

`timestampMs` is Unix milliseconds and must be within **60 seconds** of the
relay's clock in either direction (`product_route.rs:21`, `:626-628`).
`nonceBase64Url` must decode to **16–32 bytes** (`product_route.rs:660-662`);
PacketADE sends 24 random bytes (`syndicate_relay.rs:161`). The nonce is
inserted into a per-route replay cache that holds at most 4,096 entries and
retains them for two clock windows; a repeat is `hello replayed`
(`product_route.rs:315`, `:645-659`).

### The proof signature — the one non-canonical signature in the protocol

**`proofSignatureBase64Url` is Ed25519 over a five-field newline-delimited
ASCII payload. It is NOT a signature over canonical JSON.** Every other
signature in controller protocol v1 — the grant, the frame, `host_hello`,
`grant_revoked`, the HTTP RPC envelope — covers a domain separator plus
canonical JSON. This one does not, and it is the single most likely thing to
trip an independent implementer.

```text
SYNDICATE-RELAY-DEVICE-HELLO-V1
<grant.routeId>
<grant.deviceId>
<timestampMs>
<nonceBase64Url>
<base64url(SHA-256(canonical grant JSON))>
```

That is the domain separator, a `\n`, then the five values joined by `\n`, with
**no trailing newline**. `timestampMs` is rendered as its decimal integer, and
must be the same value carried in the frame's `timestampMs` field. The final
line is the base64url-unpadded SHA-256 of the UTF-8 canonical grant JSON — the
same bytes the grant signature covers, not the bytes as transmitted.

PacketADE builds it at `syndicate_relay.rs:163-167`; the relay reconstructs it
byte-for-byte at `product_route.rs:289-293`. Both use the trailing `\n` of the
`DEVICE_DOMAIN` / format-string constant to attach the separator
(`product_route.rs:23`).

The signature is made with the device Ed25519 private key whose SPKI appears in
`grant.deviceSigningPublicKeyBase64Url`; the relay verifies it against exactly
that key (`product_route.rs:286-294`). This is the device's proof of
possession — the grant alone is a bearer document, and this signature is what
stops a copied grant from being replayed by a party without the private key.

### What the relay checks, in order

1. `protocolVersion == 1` on both the hello and the grant, `grant.type ==
"device_grant"`, timestamp fresh, nonce well-formed (`product_route.rs:249-256`).
2. Grant lifetime bounds (`:257-265`).
3. Scopes valid and strictly ascending; `deviceId` well-formed (`:266-268`).
4. Both X25519 SPKI keys well-formed (`:269-273`).
5. `routeId` equals the derivation from the grant's Host signing key (`:274-277`).
6. Grant signature verifies under that Host key (`:278-285`).
7. Proof signature verifies under the grant's device key (`:286-294`).
8. Route exists and its Host is connected (`:295-300`).
9. Route's `machineId` and both Host keys match the grant's (`:301-307`).
10. `grant.revocationEpoch` is greater than any revoked epoch the relay has
    recorded for this `deviceId` (`:308-314`).
11. Nonce not replayed (`:315`).

**Every failure is silent.** The relay returns from the connection handler
without sending a frame and without a WebSocket close code
(`product_route.rs:532-535`). A device sees only "the socket closed before
`routeReady`" — PacketADE reports `PacketRelay closed the route.`
(`syndicate_relay.rs:561`). A client cannot distinguish an expired grant from a
revoked one, a clock skew, or an offline Host from this leg alone. That is
deliberate on the relay's part but it does mean the device must fall back to the
Host's own typed errors over SSH for a real diagnosis.

If the route already holds a socket for this `deviceId`, the previous one is
sent `{"protocolVersion":1,"type":"routeReplaced"}` and superseded
(`product_route.rs:344-348`). A route holds at most 64 devices
(`:341`), and the relay holds at most 10,000 routes (`:217`).

## `routeReady`

The relay's first and only frame before data flows:

```json
{
  "protocolVersion": 1,
  "type": "routeReady",
  "routeId": "route_...",
  "sender": { "role": "device", "machineId": "syn_...", "deviceId": "device_..." }
}
```

(`product_route.rs:536`.) `sender` echoes the identity the relay admitted —
`role` is `device` for this leg, `host` on the Host leg where `deviceId` is the
literal string `"host"` (`:237`).

A device must validate, at minimum, `protocolVersion == 1`, `type ==
"routeReady"`, and `routeId` equal to its own grant's `routeId`. PacketADE
checks exactly those three and treats any mismatch as a fatal
`PacketRelay rejected or mismatched the device route.`
(`syndicate_relay.rs:194-200`). PacketADE does not currently validate the
`sender` object; a client that does should compare `sender.machineId` and
`sender.deviceId` against its grant, which costs nothing and closes a
mis-routing failure mode.

PacketADE waits up to 10 seconds for this frame (`syndicate_relay.rs:66`,
`:194`) and requires it to be a WebSocket **text** frame; a binary or control
frame here is fatal (`:563-565`).

> **Discrepancy with the Host half.** `CONTROLLER_PROTOCOL_V1.md` documents
> `routeReady` as `{"protocolVersion":1,"type":"routeReady","routeId":"..."}`
> with no `sender`. The deployed relay always includes `sender`
> (`product_route.rs:536`). Any Host or device parser using
> `deny_unknown_fields` on this frame would reject a live relay. The merged
> document should carry the four-field shape.

## The encrypted frame

Both directions use the same object. Device → relay it is sent bare, as a
top-level object; relay → device it arrives wrapped in a `routedEncrypted`
envelope (below).

```json
{
  "protocolVersion": 1,
  "type": "encrypted",
  "routeId": "route_...",
  "machineId": "syn_...",
  "deviceId": "device_...",
  "direction": "controller-to-host",
  "counter": 1,
  "nonceBase64Url": "Q1RIMQAAAAAAAAAB",
  "ciphertextBase64Url": "...",
  "signatureBase64Url": "..."
}
```

(`syndicate_relay.rs:286-300`, `product_route.rs:99-113`; both parse with
`deny_unknown_fields`.)

### Key derivation

```text
ikm   = X25519(own private key, peer public key)          // raw 32-byte shared secret
salt  = SHA-256("SYNDICATE-RELAY-V1\n" + machineId + "\n" + deviceId)
info  = "syndicate-relay-aead-v1\0" + direction
key   = HKDF-SHA256(ikm, salt, info, 32)
```

(`syndicate_relay.rs:645-660`.) `\0` is a literal NUL byte. `direction` is the
same string that appears in the frame, so the two directions never share a key.
The X25519 inputs are the raw 32-byte values extracted from the SPKI DER, not
the DER itself (`syndicate_relay.rs:390-406`, `:618-628`).

The device derives both keys once per exchange:
`controller-to-host` for sending, `host-to-controller` for receiving
(`syndicate_relay.rs:407-419`).

### Nonce

Fully derived, never random. Twelve bytes: a four-byte ASCII direction prefix
followed by the big-endian `u64` counter (`syndicate_relay.rs:662-674`).

| Direction            | Prefix | Example (counter 1) |
| -------------------- | ------ | ------------------- |
| `controller-to-host` | `CTH1` | `Q1RIMQAAAAAAAAAB`  |
| `host-to-controller` | `HTC1` | `SFRDMQAAAAAAAAAB`  |

Counter `0` is rejected outright, on both send and receive
(`syndicate_relay.rs:663-665`, `:493`; `product_route.rs:708`). A receiver must
recompute the nonce from `direction` and `counter` and reject any frame whose
`nonceBase64Url` differs (`syndicate_relay.rs:509-512`). The nonce is
therefore not an input a peer gets to choose — it is a checksum on the
counter.

### AEAD

**AES-256-GCM.** `ciphertextBase64Url` decodes to the GCM ciphertext followed by
the 16-byte tag. PacketADE accepts 17 to 65,536 bytes decoded
(`syndicate_relay.rs:516-518`); the relay independently caps the base64url
_string_ at 60,000 characters (`product_route.rs:710`), which is the binding
limit in practice.

The associated data is the canonical JSON of the frame with
`ciphertextBase64Url` and `signatureBase64Url` removed — that is, the eight
routing/metadata fields (`syndicate_relay.rs:437-455` for send,
`:519-535` for receive). Routing metadata is authenticated but not encrypted,
which is exactly what lets the relay route without reading.

The plaintext is the canonical JSON of the signed controller envelope:

```json
{
  "request": {
    "protocolVersion": 1,
    "requestId": "request-...",
    "deviceId": "...",
    "machineId": "...",
    "method": "machine.snapshot",
    "expiresAt": "2026-08-12T00:00:30.000Z",
    "params": {}
  },
  "auth": { "timestamp": "1786000000000", "nonce": "...", "signature": "..." }
}
```

(`syndicate.rs:1204-1211`.) Note that `auth.timestamp` is a **string** on this
transport, mirroring the `X-Syndicate-Timestamp` header value rather than the
numeric `timestampMs` used by the relay's own hello frames. `auth.nonce` and
`auth.signature` are the same values the HTTP surface would carry in
`X-Syndicate-Nonce` and `X-Syndicate-Signature`, and the signature is the
unchanged `SYNDICATE-CONTROLLER-V1` payload over the canonical request JSON
(`syndicate.rs:1169-1181`). The relay leg adds encryption around that envelope;
it does not replace or weaken it.

The Host's reply plaintext is the ordinary controller response,
`{protocolVersion, requestId, ok, result|error}`.

### Frame signature

```text
SYNDICATE-RELAY-FRAME-V1\n + canonical JSON of the frame WITHOUT signatureBase64Url
```

— that is, the eight metadata fields **plus** `ciphertextBase64Url`. Ed25519,
by the device key outbound and the Host key inbound, base64url unpadded
(`syndicate_relay.rs:456-461` for send, `:497-508` for receive). The relay does
not verify this signature; it only checks that the field is non-empty
base64url of at most 128 characters (`product_route.rs:711`, `:713-718`).

### The `routedEncrypted` wrapper

Relay → device, the frame arrives stamped with the relay's own view of who sent
it (`product_route.rs:130-147`, `:577`):

```json
{
  "protocolVersion": 1,
  "type": "routedEncrypted",
  "routeId": "route_...",
  "sender": { "role": "host", "machineId": "syn_...", "deviceId": "host" },
  "frame": { "...": "the encrypted frame above" }
}
```

A device must require `protocolVersion == 1`, `type == "routedEncrypted"`,
`routeId` equal to its grant's, `sender.role == "host"`, `sender.machineId`
equal to its own machine id, and `sender.deviceId` exactly the literal
`"host"`; PacketADE fails with
`PacketRelay response sender stamp is invalid.` otherwise
(`syndicate_relay.rs:471-480`). It must then check the inner frame's
`protocolVersion`, `type`, `routeId`, `machineId`, `deviceId`, and
`direction == "host-to-controller"` before verifying the signature
(`:487-496`).

Device → relay traffic is **not** wrapped: the device sends the bare encrypted
frame as a top-level object (`syndicate_relay.rs:201-205`), and the relay adds
the stamp when it forwards to the Host. This mirrors the Host leg, where the
Host also sends bare frames and receives stamped ones.

## Counters, replay, and ordering

Each direction carries a durable, strictly increasing counter per
`(deviceId, direction)`.

**Send.** PacketADE reserves and persists the next send counter _before_ the
socket is opened, under a process-wide credential lock
(`syndicate.rs:719-733`, `syndicate_relay.rs:142`). A counter is therefore
consumed even when the exchange fails, and is never reused. The consequence
worth stating: gaps in the Host's received counter sequence are normal and must
not be treated as loss.

**Receive.** PacketADE verifies the frame signature, recomputes the nonce,
decrypts, correlates `requestId`, and only then commits the counter
(`syndicate_relay.rs:239-248`, `:141-151`). The commit itself rejects any
counter less than or equal to the stored value with
`Syndicate relay frame was replayed or rolled back.`
(`syndicate.rs:749-759`), and the plaintext is not returned to the typed
controller layer until that commit succeeds. Ordering is preserved because the
per-device gate serializes exchanges end to end.

**The relay does not track counters at all.** It checks `counter > 0` and
forwards (`product_route.rs:708`). Replay defence lives entirely at the two
endpoints.

## Liveness

The device may send a keepalive at any time after `routeReady`. PacketADE sends
one every 15 seconds while waiting for a response
(`syndicate_relay.rs:68`, `:208-215`).

**The relay compares the received text byte-for-byte against an exact
literal:**

```text
{"protocolVersion":1,"type":"ping"}
```

(`packetrelay/src/product_route.rs:568`.) A match is answered with the literal
`{"protocolVersion":1,"type":"pong"}` and the frame is otherwise ignored.

Anything else is not a ping. There is no JSON-level ping handling: a reformatted
ping, a reordered `{"type":"ping","protocolVersion":1}`, an added field, or a
space after the colon falls through to the encrypted-frame parser, fails to
deserialize as `EncryptedFrame`, and the relay **breaks out of its loop and
drops the socket** (`product_route.rs:575`). For a device mid-request that
surfaces as `PacketRelay closed before the response arrived.`
(`syndicate_relay.rs:217`), with no diagnostic anywhere.

PacketADE currently emits a matching string only by coincidence of two
mechanisms lining up: every outbound frame is serialized through
`canonical_json`, which sorts object keys (`syndicate.rs:898-912`), and
`"protocolVersion"` happens to sort before `"type"`. Nothing tests this, and
nothing in either codebase records the dependency. **This is a fragility, not a
design.** An implementer should treat the ping and pong as opaque byte strings
to be emitted verbatim, not as JSON to be constructed — and the relay should
eventually parse them rather than compare them.

Two further points a client must not get wrong:

- **The relay never initiates an application-level ping**, and there is no pong
  the device is obliged to send. The keepalive is device-driven.
- **The relay applies no idle timeout to a device socket after admission.** Its
  select loop waits on the grant-expiry timer, the outbound queue, and the
  inbound stream, and on nothing else (`product_route.rs:553-584`). A device
  that never pings is not disconnected by the relay. The keepalive exists to
  keep intermediaries (load balancers, Cloud Run) from reaping an idle
  connection, not to satisfy a relay-side liveness requirement.

> **Correction to a common assumption.** The 20-second ping / 45-second
> deadline / close-`1013` behaviour described in `CONTROLLER_PROTOCOL_V1.md` is
> the **Host** leg: it is the Host that pings the relay and the Host that closes
> when no pong arrives. None of it applies to the device leg. On the device leg
> a byte-mismatched ping produces an immediate connection drop, not a delayed
> timeout, and the relay closes without a status code.

## Revocation, replacement, and close behaviour

**`routeRevoked` (relay → device).**

```json
{ "protocolVersion": 1, "type": "routeRevoked", "deviceId": "device_...", "revocationEpoch": 3 }
```

(`product_route.rs:571`.) Note there is no `routeId`, no timestamp, and no
signature. The relay emits it after it has verified a Host-signed
`grant_revoked` and removed the device from the route; dropping the device's
channel then closes its socket (`:439-479`, `:556-563`).

PacketADE treats any frame with `type == "routeRevoked"` as authoritative,
failing the request with the typed code `DEVICE_REVOKED` — the same code the
Host uses — and does not check `deviceId` or `revocationEpoch`
(`syndicate_relay.rs:233-235`, `:34`, `:42`, `:49-61`). This is safe in the
narrow sense that it can only _reduce_ the device's own belief in its
authority, but an implementer should understand that **the device cannot verify
this frame**: it is a relay assertion, not a Host-signed notice. Host rejection
remains the authority; the relay notice is acceleration.

> **Naming mismatch — translation obligation.** The Host sends
> `grant_revoked` to the relay; the relay sends `routeRevoked` to the device.
> They are the same event under two names, and neither name appears on the
> other leg. `CONTROLLER_PROTOCOL_V1.md` documents only `grant_revoked`
> (`product_route.rs:439-479` consumes it; `:571` re-emits it as
> `routeRevoked`). A device that listens for `grant_revoked` will never see one;
> a Host that expects to see `routeRevoked` acknowledged will never get it. The
> merged spec must state both names and which leg carries each.

**`routeReplaced` (relay → device).**
`{"protocolVersion":1,"type":"routeReplaced"}`, sent to a socket that a newer
connection for the same `deviceId` has superseded
(`product_route.rs:344-348`). **PacketADE does not handle this frame.** It
falls through to the response path and fails as
`PacketRelay response sender stamp is invalid.`
(`syndicate_relay.rs:471-480`) — a misleading message for what is really "a
second connection took your slot". An independent client should match on
`type` and report replacement explicitly. Documented here as a known gap in the
PacketADE implementation, not as intended behaviour.

**Close codes.** The relay does not use WebSocket status codes on the product
route. Admission failure returns from the handler without a close frame
(`product_route.rs:532-535`); a protocol violation after admission breaks the
loop and drops the socket (`:567`, `:575`, `:576`, `:578`); a superseded or
isolated peer receives `Message::Close(None)` — a close with no code
(`:560-563`). The `1008` / `1013` codes in `CONTROLLER_PROTOCOL_V1.md` are the
Host's, applied to frames the Host receives. **A device must not attempt to
classify a failure by close code on this leg.**

**After a revocation.** Because PacketADE only holds a socket during an RPC,
a revocation is observed as `routeRevoked` only if it lands inside that ~30
second window. Otherwise the next `device_hello` is rejected by the relay's
`revoked_epochs` check (`product_route.rs:308-314`) and the device sees nothing
but a closed socket. A client should expect revocation to surface, most of the
time, as an unclassified connection failure followed by a Host-side
`DEVICE_REVOKED` over SSH.

## Bounds and timeouts

| Bound                                     | Value                              | Source                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint path                             | exactly `/v1/product-route`        | `syndicate_relay.rs:64`                                                                                                                                                    |
| Device connect timeout                    | 10 s                               | `syndicate_relay.rs:66`                                                                                                                                                    |
| `routeReady` wait                         | 10 s                               | `syndicate_relay.rs:194`                                                                                                                                                   |
| Response timeout                          | 30 s                               | `syndicate_relay.rs:67`, `:207`, `:212`                                                                                                                                    |
| Device keepalive interval                 | 15 s                               | `syndicate_relay.rs:68`, `:208`                                                                                                                                            |
| Max frame, either direction (device view) | 65,536 bytes                       | `syndicate_relay.rs:65`, `:225`, `:546`, `:566`                                                                                                                            |
| Relay hello deadline                      | 5 s (default)                      | `rate_limit.rs:15`, `product_route.rs:520`                                                                                                                                 |
| Relay max first-frame size                | 16,384 bytes                       | `product_route.rs:524`                                                                                                                                                     |
| Ciphertext, decoded                       | 17 – 65,536 bytes                  | `syndicate_relay.rs:516`                                                                                                                                                   |
| Ciphertext, base64url string              | ≤ 60,000 chars                     | `product_route.rs:710`                                                                                                                                                     |
| Nonce field, base64url string             | ≤ 16 chars                         | `product_route.rs:709`                                                                                                                                                     |
| Signature field, base64url string         | ≤ 128 chars                        | `product_route.rs:711`                                                                                                                                                     |
| Hello nonce, decoded                      | 16 – 32 bytes                      | `product_route.rs:660-662`                                                                                                                                                 |
| Hello clock skew                          | ± 60 s                             | `product_route.rs:21`, `:626-628`                                                                                                                                          |
| Grant span                                | ≤ 31 days (30-day issuance policy) | `syndicate_relay.rs:336`, `product_route.rs:262`                                                                                                                           |
| `machineId` / `deviceId`                  | 8 – 128 bytes, `[A-Za-z0-9._-]`    | `product_route.rs:672-677`; PacketADE composes `require_id` (≤128, `syndicate.rs:361-372`) with `valid_id` (≥8, `syndicate_relay.rs:587-596`) for the same effective range |
| Devices per route                         | 64                                 | `product_route.rs:341`                                                                                                                                                     |
| Routes per relay                          | 10,000                             | `product_route.rs:217`                                                                                                                                                     |
| Nonce replay cache                        | 4,096 entries, 2 × 60 s retention  | `product_route.rs:645-659`                                                                                                                                                 |
| Relay outbound queue per connection       | 16 frames                          | `rate_limit.rs:16`                                                                                                                                                         |
| Relay inbound budget per connection       | 3,000 messages / 64 MiB per 60 s   | `rate_limit.rs:17-19`, `product_route.rs:567`                                                                                                                              |

WebSocket read/write buffers on the device are 8 KiB with a write cap of
`MAX_FRAME_BYTES + 8 KiB`, and both `max_message_size` and `max_frame_size` are
pinned to 64 KiB, so an oversized relay frame is rejected by the WebSocket layer
before PacketADE sees it (`syndicate_relay.rs:179-184`).

## Conformance coverage

### What the shared fixture already pins

`controller-relay-crypto-v1.json` is byte-identical in three repositories —
`packetade/src-tauri/tests/fixtures/controller-relay-crypto-v1.json`,
`syndicate/docs/fixtures/controller-relay-crypto-v1.json`, and
`packetrelay/testdata/controller_relay_crypto_v1.json` — and is loaded as a
conformance vector by all three
(`syndicate_relay.rs:906-1001`, `packetrelay/src/product_crypto.rs:157-243`,
`syndicate/apps/host/src/controller-relay-crypto.test.ts:201`).

It pins, for one `controller-to-host` frame at counter 7:

- X25519 keypair round-trip from fixed private keys;
- the HKDF-SHA256 derived key for `(machineId, deviceId, direction)`;
- the derived nonce `Q1RIMQAAAAAAAAAH`;
- the exact AES-256-GCM ciphertext over canonical plaintext with canonical AAD;
- the exact Ed25519 frame signature over
  `SYNDICATE-RELAY-FRAME-V1\n` + canonical metadata + ciphertext;
- the device Ed25519 public key derived from the fixture private key.

### What no fixture covers

Nothing in any of the three repositories pins:

- **`device_hello` and its proof signature.** The five-field newline payload —
  the protocol's one deviation from canonical-JSON signing — has no
  cross-language vector. PacketADE's end-to-end test asserts only
  `hello["type"] == "device_hello"` and never verifies the proof
  (`syndicate_relay.rs:811`); the relay's test constructs a proof with the same
  helper it verifies with (`product_route.rs:1081-1085`), so a shared
  misunderstanding would pass both. **This is the highest-value fixture gap.**
- **The liveness frames.** The byte-exact `ping` literal and its `pong` response
  are untested on both sides. The only thing keeping PacketADE's ping matching
  is incidental key-sort ordering, and no test would catch a change to it.
- **`routeReady`, `routeRevoked`, and `routeReplaced` shapes.** The relay test
  asserts a substring `contains("routeReady")` (`product_route.rs:1051-1058`)
  and `revoked["type"] == "routeRevoked"` (`:1124`); PacketADE's fake relay
  emits a `routeReady` it wrote itself (`syndicate_relay.rs:812-823`). No frame
  shape is cross-pinned.
- **The grant certificate and its `SYNDICATE-RELAY-GRANT-V1` signature.** Each
  repository builds its own grant in its own tests; the fixture contains no
  grant at all. The fixture's `routeId` is the placeholder
  `"route_testvector"`, so **route-id derivation is not pinned either** — only
  the three implementations' agreement in prose keeps it aligned.
- **The `host-to-controller` direction.** The fixture covers one direction. The
  `HTC1` prefix and the host-direction key have no vector.

A merged specification should be accompanied by at least two more fixtures: a
`device_hello` vector (grant, canonical grant bytes, grant hash, proof payload,
proof signature) and a frame-shape vector covering `routeReady`,
`routedEncrypted`, `routeRevoked`, and the two liveness literals as exact
strings.

## Open questions and ambiguities in the source

These are places where the implementations do not decide a question an
independent client would have to answer. They are listed rather than guessed.

1. **Multiple in-flight requests on one device socket.** The relay supports it —
   it forwards frames continuously and enforces no request/response pairing. The
   Host half describes a serialized inbound chain. PacketADE never exercises it
   (one request per connection). Whether a device may pipeline, and what the
   counter and ordering obligations then are, is undefined by any
   implementation.

2. **Long-lived device connections.** Nothing forbids one, and the relay does
   not time out an idle device. But every timeout PacketADE applies is scoped to
   a single request, and the keepalive interval was chosen for a ≤30 s window.
   A client holding a socket for hours has no specified keepalive cadence.

3. **`routeReady.sender` semantics.** The relay always sends it; PacketADE
   ignores it; the Host spec omits it. Whether it is required, optional, or
   advisory is not settled anywhere.

4. **`routeRevoked` authenticity.** The frame is unsigned and carries no
   `routeId`. Whether a device is _permitted_ to act on it (PacketADE does) or
   must treat it as a hint pending Host confirmation is stated nowhere. The
   conservative reading — it can only reduce the device's own authority, so
   acting on it is safe — is this document's inference, not a source claim.

5. **Grant refresh.** `CONTROLLER_PROTOCOL_V1.md` says grants "may be refreshed
   only by a future locally approved flow". PacketADE captures a grant solely
   from `machine.snapshot` (`syndicate.rs:1308-1310`), and that snapshot is
   reachable over the relay once a grant exists — so a refreshed grant would in
   principle arrive over the relay itself. Whether that is the intended refresh
   path is not decided by any code.

6. **Whether `expiresAt` slack is intentional.** Both validators accept 31 days
   while policy issues 30. Nothing records whether that one day is deliberate
   clock slack or an off-by-one that hardened into agreement.

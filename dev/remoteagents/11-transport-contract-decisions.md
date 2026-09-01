# 11 - Sprint 1 Transport Decisions And Security Gates

Status: **Partially accepted 2026-09-01; security-gated items are not ready for
Sprint 1 implementation.**

This record resolves the identity vocabulary, request shapes, envelope identity,
and first migration boundary found when Sprint 0 completed. It also records the
wire/cryptographic decisions that remain open after independent review. It is
intentionally narrower than the full auth design: WebAuthn ceremony,
magic-link delivery, recovery, refresh-family, rate-limit, and retention column
policies remain a separate security review gate before their migrations land.

## 1. Canonical identity vocabulary

`hostId` is the protocol, API, and database identifier for a registered
PacketBench desktop. `desktop` remains a product/UI noun, not an identifier
prefix in wire fields. Existing draft `desktopId` examples are superseded.

The authenticated account is always derived from the HTTPS session or consumed
ticket. A client-supplied `accountId`, `hostId`, or `deviceId` is a selector to
authorize, never proof of ownership.

## 2. Role-discriminated WebSocket tickets

`POST /api/ws-ticket` accepts exactly one of these authenticated request shapes:

```json
{ "role": "host", "hostId": "host_..." }
```

```json
{ "role": "device", "hostId": "host_...", "deviceId": "dev_..." }
```

The server derives the account, capabilities, and bound public-key fingerprint
from durable state. It does not accept those as authority-bearing request
fields. A ticket record binds:

- protocol version and role
- account, host, and optional device
- effective capabilities
- subject public-key fingerprint
- allowed WebSocket path and browser Origin policy
- creation and expiry time, with TTL no greater than 60 seconds
- random ticket digest, consumed time, and revocation state

Only a cryptographic digest of the bearer ticket is stored. A ticket is never
placed in a URL. The role-specific mint responses are:

- host: return the raw ticket, a non-secret random `ticketBinding`, expiry, and
  `/ws/host` URL; the native client uses the upgrade `Authorization` header
- device: set the raw ticket only as a host-only (no `Domain`)
  `__Secure-pb_ws_device` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`,
  `Path=/ws/device`, and `Max-Age <= 60`; return the non-secret `ticketBinding`,
  expiry, and `/ws/device` URL to browser JavaScript

The server stores the binding challenge alongside the ticket digest. Both
roles sign that challenge in the hello; browser code never reads the device
bearer. Raw tickets must be redacted from application, access, edge, and audit
logs.

The upgrade atomically reserves an unused/unrevoked/unexpired matching digest;
signed-hello validation atomically finalizes consumption. An invalid hello gets
no routing authority. Reservations expire, proof attempts are bounded, and the
path/Origin/account/host/device grant is rechecked at finalization. Exact retry
and contention semantics remain part of the security gate below.

## 3. Replay identity, sequence scope, and acknowledgment gate

`envelopeId` is the idempotency/deduplication identity. Earlier references to a
generic replay `id` are superseded.

Each replayable stream has exactly one authenticated producer. The producer
assigns `seq` monotonically within `{hostId, streamId}` **before** it seals the
envelope; `streamId` is mandatory even when `conversationId` is absent. The
relay never adds or mutates authenticated fields. Persistence uses independent
unique constraints on `{hostId, streamId, seq}` and `{hostId, envelopeId}`;
conflicting reuse of either identity is rejected and audited. Multi-producer
stream ids are invalid.

Duplicate `envelopeId` values already processed are valid at-least-once
redelivery and are ignored after authentication/idempotency checks. A forward
sequence gap is not processed out of order; the receiver requests replay, or
`snapshot_required` when the retained window cannot fill the gap.

The scalar `ack` field in the Sprint 0 shared envelope is reserved and must not
drive deletion, replay, or authorization. Its replacement is a gated schema
change: an authenticated receiver emits a control envelope on its own
single-producer control stream and names the separate `ackedStreamId` plus the
highest contiguous `afterSeq`. Relay state is scoped at least by
`{accountId, hostId, receiverSubjectId, ackedStreamId}`. One device can never
advance another device's cursor; replay GC uses the minimum cursor across
eligible receivers plus the retention ceiling.

Before accepting this portion, define and test the ACK control wire shape,
receiver eligibility/removal rules, and producer restart recovery. The latter
must retain a durable per-stream high-water mark beyond replay GC and enforce an
exclusive authenticated producer lease so restart cannot reuse a sequence or
fork history.

Connection resume uses camelCase and carries one cursor per stream:

```json
{
  "resume": [
    { "streamId": "host_01:presence", "afterSeq": 41 },
    { "streamId": "conv_01:events", "afterSeq": 982 }
  ]
}
```

`afterSeq` means the highest contiguous sequence already processed; replay
starts strictly after it. The relay retains at most 1,000 events or 24 hours
per stream, whichever bound is reached first.

## 4. Signed connection hello and key agreement

The first WebSocket application frame is signed plaintext metadata named
`connection.hello`, not an encrypted payload. Encryption cannot begin until
the peers have authenticated the key-agreement material. The hello contains no
prompt, code, tool argument, approval, or other user content.

Required common fields:

- `v: 1`, `type: "connection.hello"`, and `role`
- `hostId`, plus `deviceId` only for the device role
- durable signing `keyId`
- ephemeral key-agreement public key
- the non-secret server-issued `ticketBinding` challenge associated with the
  reserved ticket digest
- random nonce and canonical `createdAt`
- zero or more resume cursors
- signature over the canonical serialization of every preceding field

The relay compares `ticketBinding` with the stored challenge associated with
the reserved ticket digest, checks role/path and durable key fingerprints,
verifies the signature, and finalizes ticket consumption. It may forward
authenticated peer-key metadata, but it must never derive or receive a content
key. A mismatch closes the socket without routing any frame.

Canonical timestamps use the cross-runtime subset already enforced by the v1
envelope: uppercase `T`/`Z` (or a numeric offset), valid calendar time, and
seconds `00` through `59`; space separators, lowercase separators, and leap
seconds are rejected.

This section defines intent, not an implementation-ready wire contract. Before
Sprint 1 encrypted routing begins, security review must accept:

- the exact bounded hello JSON schema and canonical byte serialization
- signature, key-agreement, AEAD, hash, and encoding algorithms
- suite negotiation with downgrade binding and nonce freshness/reuse rules
- resume-cursor count, uniqueness, length, and safe-integer bounds
- receiver-scoped ACK schema/GC rules and producer lease/high-water recovery
- an audited endpoint-to-endpoint HPKE/Noise flow and authenticated peer-key
  forwarding that leaves the relay unable to read content
- per-device fanout and replay-key retention across reconnect/key rotation so
  retained ciphertext remains decryptable only by the intended endpoints
- Rust/browser golden vectors plus negative tests for stale, replayed,
  noncanonical, oversized, duplicate-cursor, invalid-cursor, downgraded, and
  sequence-tampered hellos/envelopes

## 5. Persistence slice boundary

The first migration may cover only the tables whose security contract is now
stable: accounts, identities, hosts, devices, pending device-access requests,
host/device ACLs, and redacted audit events. WebSocket ticket tables/queries may
land only after the reserve/finalize lifecycle and column-retention policy pass
the security gate above.

Do not migrate WebSocket tickets, auth sessions, refresh families, magic links,
WebAuthn credentials, recovery, replay allocation/GC, revocation retention,
distributed rate limits, or the notification outbox until their column-level
lifecycle and retention policies are accepted. A compile-time and runtime-gated
development identity may eventually exercise the ticket path internally; it is
not product auth and must be impossible to enable in an external-beta build.

## Acceptance tests for the next slice

- host and device mint responses expose only their role-appropriate credential,
  URL, and non-secret binding challenge
- browser code can sign the binding challenge without access to the HttpOnly
  device bearer
- a real supported browser accepts the exact cookie attributes and sends the
  cookie on `/ws/device` upgrade, but not on unrelated relay routes
- two concurrent reserve/finalize attempts for one ticket yield one success
- expired, revoked, cross-account, wrong-role, wrong-path, wrong-Origin, and
  wrong-key attempts fail closed
- a restart does not make a consumed ticket reusable
- raw tickets appear in no application, access, edge, or audit log; audit rows
  contain identifiers and outcomes but no signature, key material, or
  encrypted/plaintext user content
- invalid hellos cannot gain routing authority or create an unbounded
  ticket-burning path
- late-assigned or tampered sequence numbers fail cross-runtime authentication
- the legacy bridge, broadcast, and room protocols remain unchanged

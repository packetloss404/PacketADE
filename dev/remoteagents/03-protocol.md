# 03 - Protocol

## Goals

- Versioned and testable.
- Narrow enough to audit.
- Compatible with current `api-agent:*` events.
- At-least-once delivery with idempotency.
- Reconnect/resume friendly.
- Supports encrypted opaque payloads.
- Does not expose raw Tauri commands.

## `packet-relay` Binding

The production transport is the standalone Rust service at
`D:\projects\packetrelay`. PacketBench adds the `/ws/host` and `/ws/device`
routes plus the HTTPS control plane described below. Its envelopes remain
distinct from the existing `desktop_hello`, `mobile_hello`, broadcast, and room
messages so extracting the relay does not silently break inherited clients.

The shared protocol schemas are authoritative across PacketBench Desktop, the
PWA, and the Rust relay. The relay validates routing metadata and ciphertext
shape but never imports PacketBench's Tauri command surface.

`11-transport-contract-decisions.md` records the Sprint 0 vocabulary and
persistence decisions plus the security work that remains before Sprint 1 can
implement tickets or encrypted replay. Where an older draft example conflicts
with that record, the decision record controls.

The relay is PacketBench-owned as of 2026-08-27 and Remote Agents is its only
consumer. Its inherited `/v1/product-route` boundary was removed on 2026-08-28
at `packetrelay@b2bcff5` after the owner confirmed it carried no live traffic
(see `09-open-decisions.md` § Relay `/v1/product-route` disposition). The
PacketBench routes replace that surface rather than being added alongside it,
and `/ws/host` + `/ws/device` do not preserve compatibility with it. The
bridge/broadcast/room lineage remains separate and is not part of the removed
product-route boundary.

## Envelope

Relay-visible fields are for routing, sequencing, abuse controls, and audit metadata. They must not contain prompts, transcript text, tool arguments, edit content, API keys, OAuth material, or raw local environment values.

```ts
export type RemoteEnvelopeV1 = {
  v: 1;
  envelopeId: string;
  traceId: string;
  accountId: string;
  hostId: string;
  deviceId?: string;
  conversationId?: string;
  channel: "presence" | "agent" | "approval" | "host" | "control" | "file" | "push";
  type: string;
  streamId: string;
  seq?: number;
  /** Reserved Sprint 0 field; do not use until the receiver-scoped ACK schema is accepted. */
  ack?: number;
  idempotencyKey?: string;
  createdAt: string;
  ttlMs?: number;
  keyId?: string;
  ciphertext?: string;
  signature?: string;
  payload?: unknown;
};
```

Internal dev may use `payload` for local smoke tests. Production and external beta must use `ciphertext` plus `signature` for agent, approval, file, and control payloads.

AAD for encrypted frames should include every relay-visible field except `ciphertext`, `signature`, and dev-only `payload`.

## Encrypted Payload Union

```ts
export type RemotePayloadV1 =
  | HostRegisterPayload
  | HostCapabilities
  | ProviderSnapshot
  | WorkspaceSnapshot
  | ProfileSnapshot
  | ConversationListRequest
  | ConversationListSnapshot
  | ConversationStartCommand
  | ConversationStartedEvent
  | ConversationSendCommand
  | ConversationCancelCommand
  | ConversationRetryCommand
  | ConversationSetModelCommand
  | RespondPermissionCommand
  | RespondEditCommand
  | CancelPendingToolsCommand
  | AgentEventPayload
  | RemoteErrorPayload
  | AckPayload;
```

## Sequence Rules

- Each `streamId` has exactly one authenticated producer. That producer assigns
  monotonically increasing `seq` within `{hostId, streamId}` **before** sealing
  the authenticated envelope; the relay never mutates authenticated fields.
- The relay persists with independent uniqueness constraints on
  `{hostId, streamId, seq}` and `{hostId, envelopeId}`; either conflicting reuse
  is rejected and audited.
- Device commands include `idempotencyKey`.
- Desktop keeps a short processed-command cache by idempotency key.
- PWA stores the highest contiguous processed `seq` per stream in IndexedDB.
- Desktop stores last outbound event cursor where useful for replay diagnostics.
- The signed `connection.hello` carries a bounded `resume` array of
  `{ streamId, afterSeq }` cursors.
- Replay is at-least-once. Clients dedupe by `envelopeId`; `seq` detects
  duplicates and gaps. Already-processed duplicates are ignored, while a
  forward gap requests replay or a fresh snapshot.
- The Sprint 0 scalar `ack` field is reserved and non-authoritative. Sprint 1
  must first replace it with an accepted receiver-scoped ACK control shape and
  lock producer restart/high-water recovery; see the decision record.

## Channel Overview

### presence

- `host.online`
- `host.offline`
- `device.online`
- `device.offline`
- `heartbeat`
- `heartbeat.ack`

### host

- `host.register`
- `host.capabilities`
- `host.provider_snapshot`
- `host.workspace_snapshot`
- `host.profile_snapshot`
- `host.remote_status`

### control

- `device.access_request`
- `device.access_approved`
- `device.access_denied`
- `device.revoked`
- `resume.request`
- `resume.events`
- `cursor.ack`
- `error`

### agent

- `conversation.list`
- `conversation.snapshot`
- `conversation.start`
- `conversation.send`
- `conversation.cancel`
- `conversation.retry`
- `conversation.close`
- `conversation.set_model`
- `conversation.set_permission_mode`
- `conversation.set_approve_writes`
- `agent.event`

### approval

- `approval.respond_permission`
- `approval.respond_edit`
- `approval.cancel_pending_tools`

### file

Deferred for MVP except attachment references:

- `attachment.create`
- `attachment.created`
- `attachment.error`

## Host Registration

```ts
export type HostRegisterPayload = {
  hostId: string;
  hostName: string;
  packetbenchVersion: string;
  protocolVersion: 1;
  platform: "windows" | "macos" | "linux";
  startedAt: string;
  capabilities: HostCapabilities;
};

export type HostCapabilities = {
  apiAgents: true;
  ptyRemote: false;
  approvals: true;
  pendingEdits: true;
  attachments: boolean;
  pushHints: true;
  maxInlinePayloadBytes: number;
};
```

## HTTPS Control Plane

The WebSocket relay carries real-time frames. A small HTTPS control plane manages registration, access requests, revocation, push subscriptions, and short-lived WebSocket tickets.

### Register Host

`POST /api/hosts/register`

```json
{
  "displayName": "Ian-PC",
  "hostPublicKey": "base64...",
  "appVersion": "0.9.3",
  "remoteProtocolVersion": 1
}
```

Returns:

```json
{
  "hostId": "host_...",
  "registeredAt": 1779811200000
}
```

### List Hosts

`GET /api/hosts`

Returns only hosts owned by the current account:

```json
{
  "items": [
    {
      "id": "host_...",
      "displayName": "Ian-PC",
      "online": true,
      "lastSeenAt": 1779811200000,
      "appVersion": "0.9.3"
    }
  ]
}
```

### Request Device Access

`POST /api/devices/request-access`

```json
{
  "hostId": "host_...",
  "deviceDisplayName": "Ian iPhone",
  "devicePublicKey": "base64...",
  "platform": "ios-pwa"
}
```

The relay service verifies same-account ownership, creates a pending access request, and routes it to the desktop.

### Decide Device Access

`POST /api/devices/access-decision`

Desktop sends a signed decision:

```json
{
  "requestId": "req_...",
  "decision": "approve",
  "capabilities": ["view", "respond", "send", "start"],
  "hostSignature": "base64..."
}
```

### Revoke Device

`POST /api/devices/revoke`

```json
{
  "hostId": "host_...",
  "deviceId": "dev_..."
}
```

The relay service persists revocation, closes active relay sockets, and notifies the desktop so its local trust store rejects future frames.

### Mint WebSocket Ticket

`POST /api/ws-ticket`

Host request:

```json
{ "role": "host", "hostId": "host_..." }
```

Device request:

```json
{ "role": "device", "hostId": "host_...", "deviceId": "dev_..." }
```

Host response (native client):

```json
{
  "ticket": "wst_...",
  "ticketBinding": "bind_...",
  "expiresAt": 1779811260000,
  "relayUrl": "wss://relay.packetbench.app/ws/host"
}
```

Device response (browser): the HTTPS response sets
`__Secure-pb_ws_device=<opaque>` as a host-only cookie (no `Domain`) with
`Secure; HttpOnly; SameSite=Strict; Path=/ws/device; Max-Age=60` and returns
only non-secret metadata:

```json
{
  "ticketBinding": "bind_...",
  "expiresAt": 1779811260000,
  "relayUrl": "wss://relay.packetbench.app/ws/device"
}
```

`ticketBinding` is a random, non-secret server-issued challenge associated with
the stored ticket digest. Browser JavaScript can sign it without reading the
HttpOnly bearer.

Tickets are bound to account, host, optional device, role, capabilities, the
subject public-key fingerprint, allowed path, Origin policy, and binding
challenge. The server
derives these bindings from authenticated durable state.

Only a digest of a ticket is stored. PostgreSQL atomically reserves it during
the upgrade and finalizes consumption only after the signed hello is valid.
Invalid hellos never gain routing authority; reservation expiry, bounded proof
attempts, and rate limits prevent an invalid client from creating an unbounded
ticket-burning path. Raw tickets are redacted from application, access, edge,
and audit logs.

## WebSocket Paths

- `GET /ws/host` with the short-lived host ticket in the upgrade
  `Authorization` header.
- `GET /ws/device` with the short-lived device ticket in a Secure, HttpOnly,
  SameSite cookie scoped to the device WebSocket path.

Handshake requirements:

- WSS only.
- `Origin` validation.
- Single-use ticket with TTL <= 60 seconds; never place it in a URL.
- Role must match path.
- First application frame is signed plaintext metadata named
  `connection.hello`; it contains no user content.
- The relay validates identity and authenticated peer-key metadata, but never
  derives or receives content keys.
- Close on auth expiry, revocation, protocol mismatch, or replay detection.

The exact canonical hello bytes, algorithms, suite/downgrade binding, nonce
rules, cursor bounds, endpoint-to-endpoint key agreement, multi-device key
distribution, and replay-key retention remain a security-review gate in
`11-transport-contract-decisions.md`. Sprint 1 must not implement the encrypted
transport until shared Rust/browser schemas, golden vectors, and negative tests
close that gate.

Connection lifetime is a deployment property, not a protocol guarantee. The
relay's earlier Cloud Run deployment bounded every WebSocket by the platform
request timeout, making periodic reconnects routine even on a healthy relay;
on Railway (the deployment target as of 2026-08-27), WebSocket connections are
documented to remain open indefinitely, including while idle, and the live
legacy WSS smoke passed on 2026-09-01. Both sides must still treat disconnection
as normal and resume from cursors: mobile networks and backgrounded PWAs force
reconnects independently of any platform limit.

## Provider Snapshot

```ts
export type ProviderSnapshot = {
  providers: Array<{
    agentCli: string;
    provider: string;
    name: string;
    models: Array<{ label: string; value: string; speed?: "fast" | "balanced" | "thorough" }>;
    auth: {
      status: "ready" | "login_required" | "missing_key" | "service_down" | "coming_soon";
      hint?: string;
    };
    supportsSsh: boolean;
    supportsAttachments: boolean;
    supportsModelSwitch: boolean;
    supportsRetry: boolean;
  }>;
  generatedAt: string;
};
```

Source of truth starts from `src/lib/api-models.ts`, but Remote Agents should make this backend-exported so the PWA does not duplicate provider rows.

## Workspace Snapshot

```ts
export type WorkspaceSnapshot = {
  workspaces: Array<{
    id: string;
    label: string;
    projectPath: string;
    kind: "local" | "ssh";
    githubRepo?: { owner: string; repo: string };
    lastUsedAt?: number;
  }>;
};
```

Never include secrets, env vars, or SSH private key paths in the PWA snapshot. For SSH targets, send display name and remote path only.

## Profile Snapshot

```ts
export type ProfileSnapshot = {
  profiles: Array<{
    id: string;
    name: string;
    description?: string;
    defaultModel?: string;
    pinnedModel?: string;
    allowedTools?: string[];
    memoryContextEnabled?: boolean;
  }>;
};
```

Remote launch must refer to a `profileId`; the desktop resolves the full system prompt.

## Conversation Start

Device to host:

```ts
export type ConversationStartCommand = {
  workspaceId?: string;
  projectPath?: string;
  agentCli: string;
  model: string;
  profileId?: string;
  initialMessage: string;
  mode: "agent" | "manual" | "ask" | "plan";
  permissionMode?: "auto" | "ask_for_risky" | "allow_all" | "deny_all";
  approveWrites?: boolean;
  enabledMcpServerIds?: string[] | null;
  attachments?: Array<{ artifactId: string; mediaType: string; sha256: string }>;
};
```

Host response:

```ts
export type ConversationStartedEvent = {
  conversation: RemoteConversationSnapshot;
};
```

Desktop responsibilities:

- validate provider/model/profile/workspace
- build effective system prompt
- create conversation id
- persist first conversation snapshot
- install/fanout API-agent event listeners
- call `start_api_agent_session`
- emit local desktop update event

## Conversation Snapshot

```ts
export type RemoteConversationSnapshot = {
  id: string;
  title: string;
  agent: string;
  provider?: string;
  model?: string;
  projectLabel: string;
  projectPathDisplay: string;
  status: "idle" | "active" | "done" | "failed" | "cancelled";
  archived?: boolean;
  planMode?: boolean;
  permissionMode?: "auto" | "ask_for_risky" | "allow_all" | "deny_all";
  approveWrites?: boolean;
  updatedAt: number;
  messages: RemoteMessage[];
  pendingCounts: { permissions: number; edits: number };
  tokenSummary?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    estimatedCostUsd?: number;
  };
};
```

## Agent Event Wrapping

Current desktop event:

```text
api-agent:chunk:{sessionId}
payload: string
```

Remote wrapper:

```ts
export type AgentEventPayload =
  | { kind: "chunk"; payload: string }
  | { kind: "thinking"; payload: { text: string } }
  | { kind: "thinking-stop"; payload: unknown }
  | { kind: "tool-start"; payload: { id: string; name: string; input?: unknown } }
  | {
      kind: "tool-result";
      payload: { id: string; name: string; content: string; is_error: boolean; input: string };
    }
  | { kind: "permission-request"; payload: PendingPermission }
  | { kind: "pending-edit"; payload: PendingEditSummary }
  | { kind: "plan-block"; payload: { items: AgentPlanItem[] } }
  | { kind: "tool-output-extended"; payload: ToolOutputExtended }
  | { kind: "turn-summary"; payload: TurnSummary }
  | { kind: "done"; payload: DonePayload }
  | { kind: "error"; payload: { message: string } };
```

`pending-edit` should not send huge full-file content inline by default. For MVP mobile, send a summary plus an optional encrypted `artifactId` reference when content is large. Every serialized relay envelope must remain at or below the Rust service's 64 KiB inline ceiling.

## Approval Commands

```ts
export type RespondPermissionCommand = {
  conversationId: string;
  toolId: string;
  decision: "allow_once" | "deny";
};

export type RespondEditCommand = {
  conversationId: string;
  toolId: string;
  decision: "apply" | "reject";
  mergedContentRef?: { artifactId: string; sha256: string };
  mergedContentInline?: string;
};

export type CancelPendingToolsCommand = {
  conversationId: string;
};
```

Mobile MVP should not send `allow_always`. That remains desktop-only until step-up auth and a stronger mobile risk UI are implemented. High-risk approvals may later require passkey confirmation; the protocol should include `requiresStepUp?: boolean` in permission payloads even if v1 sets it false.

## Error Model

```ts
export type RemoteErrorPayload = {
  code:
    | "auth_required"
    | "unauthorized"
    | "device_untrusted"
    | "host_offline"
    | "device_revoked"
    | "capability_denied"
    | "invalid_command"
    | "provider_not_ready"
    | "invalid_provider"
    | "invalid_model"
    | "conversation_not_found"
    | "not_pending"
    | "replay_detected"
    | "payload_too_large"
    | "e2ee_required"
    | "rate_limited"
    | "internal";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};
```

## Protocol Contract Tests

Create shared schema tests in `remoteagents/shared`:

- every command parses
- every event parses
- unknown `v` is rejected
- unknown `type` is rejected unless explicitly in forward-compatible bucket
- payload max size enforced
- idempotency key required for mutating commands
- encrypted payload required for external-beta mode

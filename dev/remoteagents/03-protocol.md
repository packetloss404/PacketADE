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

The relay is PacketBench-owned as of 2026-08-27 and Remote Agents is its only
consumer, but that is not licence to break its inherited surfaces. The
implemented `/v1/product-route` boundary and the bridge/broadcast/room
compatibility modes stay intact until their disposition is settled in the
relay repository (see `10-pause-record.md` §1.3); the PacketBench routes are
added alongside them.

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

- The Rust host router assigns monotonically increasing `seq` per `{hostId, conversationId}` for events traveling from desktop to devices and persists replay records before acknowledging them.
- Device commands include `idempotencyKey`.
- Desktop keeps a short processed-command cache by idempotency key.
- PWA stores last processed `seq` per conversation in IndexedDB.
- Desktop stores last outbound event cursor where useful for replay diagnostics.
- Reconnect request includes `resumeAfter`.
- Replay is at-least-once. Clients dedupe by `id` and `seq`.

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

### Register Desktop

`POST /api/desktops/register`

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
  "desktopId": "desk_...",
  "registeredAt": 1779811200000
}
```

### List Desktops

`GET /api/desktops`

Returns only desktops owned by the current account:

```json
{
  "items": [
    {
      "id": "desk_...",
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
  "desktopId": "desk_...",
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
  "desktopId": "desk_...",
  "deviceId": "dev_..."
}
```

The relay service persists revocation, closes active relay sockets, and notifies the desktop so its local trust store rejects future frames.

### Mint WebSocket Ticket

`POST /api/ws-ticket`

```json
{
  "desktopId": "desk_...",
  "deviceId": "dev_...",
  "role": "device"
}
```

Returns a 60-second, single-use ticket:

```json
{
  "ticket": "wst_...",
  "expiresAt": 1779811260000,
  "relayUrl": "wss://relay.packetbench.app/ws/device"
}
```

Tickets are bound to account, desktop, device, role, capabilities, and device public key.

Ticket state is stored in PostgreSQL and consumed atomically so a ticket cannot
be replayed across Rust relay processes or after a restart.

## WebSocket Paths

- `GET /ws/host?ticket=...`
- `GET /ws/device?ticket=...`

Handshake requirements:

- WSS only.
- `Origin` validation.
- Single-use ticket with TTL <= 60 seconds.
- Role must match path.
- First encrypted `hello` includes host/device signature.
- Close on auth expiry, revocation, protocol mismatch, or replay detection.

Connection lifetime is a deployment property, not a protocol guarantee. The
relay's earlier Cloud Run deployment bounded every WebSocket by the platform
request timeout, making periodic reconnects routine even on a healthy relay;
on Railway (the deployment target as of 2026-08-27) the equivalent edge limit
is unverified — see `02-architecture.md` § Deployment target, open
verification 1. Either way, both sides must treat disconnection as normal and
resume from a cursor: mobile networks and backgrounded PWAs force reconnects
independently of any platform limit. Do not tune heartbeat or resume windows
against an assumed edge timeout until that verification is answered.

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

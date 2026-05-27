# Architecture Fit — Mobile Client ↔ PacketADE Codebase

> Captured 2026-05-12. Codebase snapshot at v0.6.0. Superseded for
> implementation by `dev/remoteagents/README.md` on 2026-05-27. Keep this as
> research/background; current phone/PWA planning uses Packet Cloud relay,
> account sign-in, and the live sidecar protocol version in
> `agent-sidecar/src/protocol.ts`.
>
> Note: PacketADE now has **eight** API-agent providers (an OpenAI Agents SDK
> row was added 2026-05-12 alongside the existing seven). Existing event
> contract unchanged.

## 1. Current agent stack — state map

```
        ┌─────────────── React frontend (agentTaskStore.ts) ───────────────┐
        │  Zustand: conversations[] ─► persisted to localStorage           │
        │  Per-conv api-agent:* event listeners installed in               │
        │  installApiAgentListeners() (agentTaskStore.ts:395)              │
        └─────────────▲────────────────────────────▲───────────────────────┘
                      │  Tauri events              │  invoke('start_api_agent_session')
        ┌─────────────┴────────────────────────────┴───────────────────────┐
        │           Rust core (Tauri command layer)                        │
        │  api_agent.rs:319 start_api_agent_session ─routing branch─►      │
        │   ├─ is_sidecar_provider(p) ► sidecar.forward_*                  │
        │   └─ else: ApiAgentState (histories/configs/cancel_senders/      │
        │            pending_permissions/pending_edits) + run_agent_loop   │
        │                                                                  │
        │  ApiAgentState all in-memory (api_agent.rs:78–89):               │
        │     - configs: HashMap<sessionId, SessionConfig>                 │
        │     - histories: HashMap<sessionId, Vec<ChatMessage>>            │
        │     - cancel_senders, pending_permissions, pending_edits         │
        │  No on-disk session state in Rust — only telemetry/usage logs.   │
        └──────┬───────────────────────────────────────────────┬───────────┘
               │ trait LlmProvider (llm_provider.rs)           │ stdio JSON-NL
               ▼                                               ▼
   ┌───────────────────────────┐                ┌────────────────────────────┐
   │ In-process (Rust)         │                │ Node sidecar (PID per app) │
   │  anthropic / openai /     │                │  claude-oauth (Agent SDK)  │
   │  minimax / openrouter /   │                │  openai-codex (codex exec) │
   │  ollama                   │                │  openai-agents-sdk         │
   │                           │                │  echo (test)               │
   └───────────────────────────┘                └────────────────────────────┘
```

### Key facts pulled from code

- **Conversation persistence is frontend-only.** Rust never persists `messages` history. `agentTaskStore.scheduleSave` debounces a 500 ms call to `save_conversation` writing `~/.packetade/conversations/<id>.json` containing the frontend's serialized `AgentConversation` (`commands/conversations.rs:37–46`). On boot, `load_conversations` reads them back.
- **Resume.** Sidecar providers emit an opaque `resumeToken` in their `done` event (`protocol.ts:155–163`, plumbed into `agent_sidecar.rs:1231–1244`). Frontend stores it on `AgentConversation.resumeToken` and re-supplies via `start_api_agent_session.resume_token` (`api_agent.rs:335`). In-process providers don't use resume; they rebuild context by re-sending frontend-held `messages` history each turn.
- **Wire schema — end-to-end.** Both backends emit identical Tauri events: `api-agent:{chunk|thinking|thinking-stop|tool-start|tool-result|permission-request|pending-edit|done|error|plan-block|tool-output-extended|turn-summary}:<sessionId>`. Payload shapes mirrored byte-for-byte (`agent_sidecar.rs:116–225` matches `api_agent.rs:152–229`).
- **State location:**
  - Rust process memory: in-flight sessions, pending permissions/edits, cancel channels.
  - Sidecar memory: live `AbortController`s, model-side conversation handles (Agent SDK objects per session).
  - Frontend Zustand + localStorage: full transcript, model, mode flags, queued messages.
  - On disk: `~/.packetade/conversations/<id>.json` (transcripts), `~/.packetade/sidecar-stats.json` (telemetry), usage CSV, keyring blobs.

## 2. Mobile surface area mapping

| Mobile need | Existing Rust command | New command needed? | Protocol envelope |
|---|---|---|---|
| (a) List active conversations | None — frontend holds it in Zustand. `load_conversations` (`conversations.rs:49`) returns persisted JSONs. | **Yes** — `mobile_list_conversations()` returning summary objects (id, title, model, status, lastMessage, updatedAt). | `{type:"conversations", items:[…]}` |
| (b) Stream live | None — events are Tauri-process-local. | **Yes** — `mobile_subscribe(sessionId)` hooks the same `app_handle.listen` Rust-side and pipes `api-agent:*` events to WebSocket. | Pass-through of existing payloads with `event: "api-agent:chunk", sessionId, payload: …` |
| (c) Approve/deny permission | `respond_permission` (`api_agent.rs:653`), `respond_edit` (`api_agent.rs:721`) | No — wrap. | `{type:"respond_permission", sessionId, toolId, decision}` |
| (d) Send follow-up | `send_api_agent_message` (`api_agent.rs:489`) | No — wrap. | `{type:"send_message", sessionId, content, attachments?}` |
| (e) Push on attention | None. | **Yes** — `mobile_register_device(token)`, plus internal "attention" emitter triggering on `permission_request` / `pending_edit` / `error` events. | Relay → APNs / Web Push API. |

## 3. Three architecture options

### Option A — Embed WebSocket server in Rust core (`core/mobile_relay.rs`)
- **Pros:** Lowest latency. Reuses existing event bus directly. Zero third-party infra.
- **Cons:** Requires LAN reachability + port punch. mDNS/Bonjour discovery is fiddly inside iOS sandbox. Useless from a coffee shop. **APNs still needed for wake** — and APNs requires a cloud endpoint, so this option doesn't avoid hosting; it adds a redundant LAN path.
- **Codebase fit:** Easy. New file `src-tauri/src/core/mobile_relay.rs`. Tauri's `Emitter`/`Listener` already export events to listen on. Add `tokio-tungstenite` or `axum`.

### Option B — Cloud relay (PacketADE relay service) [CHOSEN]
- **Pros:** Works from anywhere. Push naturally lives on same host. Pairing token model well understood. Scales to multiple devices per desktop.
- **Cons:** Infra to maintain. Latency cost on every chunk (desktop → relay → phone). Trust boundary: compromised relay sees every chunk unless E2E.
- **Codebase fit:** Same `mobile_relay.rs` shape, but outbound client. Reuses same event subscription.
- **External dep:** small WS server. We have our own infra to host on.

### Option C — Tunnel-as-a-service (Tailscale Funnel / Cloudflare Tunnel / ngrok)
- **Pros:** Reuses Option A code. Punches NAT without us hosting.
- **Cons:** Requires user to install/configure third-party tool. Doesn't solve push. Tailscale Funnel exposes to public Internet with its own auth that doesn't compose with ours. Operationally messy.
- **Codebase fit:** Same as Option A.

## 4. Recommendation: hybrid A + B with E2E

Ship `core/mobile_relay.rs` as a local WebSocket server (Option A) AND a thin self-hosted relay that does **only**: (1) push token forwarding, (2) NAT-pierce pairing when both ends are remote. Relay never sees plaintext — desktop and phone exchange a symmetric key during pairing and encrypt frames end-to-end. Relay is just a switchboard.

Rationale:
- Hard work is already in Rust: `Emitter`/`Listener` plus `forward_*` methods are the building blocks. WebSocket fan-out is ~300 lines.
- Tauri sidecar architecture proves we can run a long-lived background task supervised by the Rust core. `SidecarManager` (`agent_sidecar.rs:354`) is the template.
- Push needs *something* hosted regardless. Once that exists, having it also act as a fallback relay is a free win.
- SSH-hardening playbook (host-key pinning, explicit "trust this device" gate) ports directly to "trust this phone". Precedent in `ServerFormModal` + `ssh_pin_host`.

## 5. iOS speaks to the RUST CORE, not the sidecar

The sidecar is an internal implementation detail of provider routing. Re-emitting the `api-agent:*` event envelope over WS is the right abstraction:
- Frontend already proves the contract works (`installApiAgentListeners` at `agentTaskStore.ts:395` is the reference consumer).
- Both backends converge on this shape — phone gets one schema, not two.
- Session resume just plumbs `resumeToken` (already in the `done` payload) plus the locally-persisted transcript. When the phone reconnects, `mobile_subscribe(sessionId)` re-attaches listeners; if session was idle, send `mobile_get_transcript(sessionId)` to backfill.

The phone protocol is the existing event protocol with a transport wrapper:

```jsonc
// client → server
{"v":1,"id":42,"type":"subscribe","sessionId":"…"}
{"v":1,"id":43,"type":"send_message","sessionId":"…","content":"…"}
{"v":1,"id":44,"type":"respond_permission","sessionId":"…","toolId":"…","decision":"allow_once"}

// server → client
{"v":1,"type":"event","event":"api-agent:chunk","sessionId":"…","payload":"chunk text"}
{"v":1,"type":"event","event":"api-agent:permission-request","sessionId":"…","payload":{id,name,arguments,batch_id?,batch_size?}}
{"v":1,"type":"ack","id":42}
```

## 6. Permission-request walkthrough (end-to-end)

**Today's desktop path:** `bash` tool call → `api_agent.rs:1280–1382` parks a `oneshot` in `pending_permissions`, emits `api-agent:permission-request:<sid>`, `AgentChatPane` renders `PermissionPrompt`, user clicks Allow, frontend calls `respond_permission` → `api_agent.rs:653` → `tx.send(decision)` unblocks the loop.

**Mobile path** (**reusable** in bold, *new* in italic):
1. Sidecar/in-process emits **`api-agent:permission-request:<sid>`** with **`PermissionRequestPayload`** (`api_agent.rs:159`).
2. *`mobile_relay`* has a global listener for `api-agent:*` events on every owned session; on `permission-request` it (a) forwards WS frame to subscribed phone, AND (b) flags session as "attention-needed" and calls *push API* with notification.
3. Push delivers (mutable-content so the client can fetch + render before showing notification).
4. PWA foregrounds, opens WS (if not already), sends `{type:"subscribe", sessionId}` — relay catches it up with any buffered events since last `ack`.
5. User taps Allow → PWA sends `{type:"respond_permission", sessionId, toolId, decision:"allow_once"}` → relay invokes existing **`respond_permission`** Tauri command → existing oneshot fires → existing agent loop resumes.

**Reusable:** entire Rust permission machinery, all payload shapes, both event names. Only the WS transport wrapper is new.

**Not reusable:** desktop's `PermissionPrompt` React component (touch UX needs redesign — big buttons, swipe-to-allow, etc.).

## 7. v0 MVP scope

See `v0-plan.md` for the full plan. Quick summary:

**In:** List conversations · stream a single conversation · approve/deny permission · pending-edit approve/deny · send follow-up · push on attention · pairing UX modeled on `ServerFormModal`.

**Out:** New conversations from phone · MCP config edits · profile editing · multi-pane · file browsing · voice input · attachments · worktree/SSH selection.

**New Rust modules:**
- `src-tauri/src/core/mobile_relay.rs` — WS lifecycle (mirror of `SidecarManager`).
- `src-tauri/src/core/mobile_protocol.rs` — `MobileRequest` / `MobileEvent` envelope types.
- `src-tauri/src/core/mobile_pairing.rs` — token issuance, fingerprint pinning per device (analog of `ssh_pin_host`).
- `src-tauri/src/commands/mobile.rs` — Tauri commands: `mobile_get_status`, `mobile_start_pairing`, `mobile_revoke_device`, `mobile_list_devices`.

**New sidecar protocol additions:** none. Mobile never talks to the sidecar.

**Frontend additions (desktop side):**
- `src/components/views/MobileView.tsx` — pairing QR, device list, revoke button.
- `src/stores/mobileStore.ts` — paired-device list, persisted under `packetade:mobile-devices`.
- A new `AppView` enum entry `"mobile"` in `appStore.ts`.

## 8. Security playbook (echo the SSH hardening)

- **Pairing must be an explicit gesture.** Same as `host_fingerprint` pinning — no TOFU. Phone fingerprint shown on desktop; user must tap "Trust this device". Mirror `ssh_fetch_fingerprint` / `ssh_pin_host` UX.
- **Long-term device keys in OS keyring**, scheme `mobile-device-<id>`, service `KEYRING_SERVICE`. Parallels `ssh-<ServerConfig.id>` (`commands/ssh_keys.rs`).
- **Transport.** TLS even on LAN (self-signed cert per desktop install, fingerprint surfaced in pairing). For cloud-relay path, relay sees only ciphertext.
- **Secret handling.** API keys NEVER leave the desktop. Phone receives streamed *output* only.
- **Per-device capability scope:** `read_only` (subscribe + list), `respond` (+permission/edit decisions), `send` (+message), `full` (+new conversation). Default v0: `respond` only.
- **Audit log.** Every mobile-originated action lands in `~/.packetade/mobile-audit.log` (append-only, JSON-lines). Parallels `commands/usage.rs`.
- **Rate limits.** Per-device cap on `send_message` (e.g. 30/min). Defense against compromised phone. Implement with `tokio::sync::Semaphore` or token bucket in `mobile_relay.rs`.
- **Shell-escape lessons from v0.6.0.** Any string the phone supplies must go through the same shell-escape/path-validate gauntlet the SSH commands use — see `src/lib/ssh.ts shellEscape` and `super::validate_project_path` (`api_agent.rs:404`).

## 9. Open questions

1. **Self-hosted relay topology** — single tenant or multi-tenant accounts? Affects whether relay needs a user concept or just opaque session IDs.
2. **Desktop ↔ relay connection model** — always-connected or connect-on-demand. Recommend always-connected.
3. **Web Push VAPID key ownership** — single shared key or per-user?
4. **Multi-desktop-per-phone** — design in now or defer to v1?
5. **MCP/tool surface from phone** — today MCP servers are stdio processes started by sidecar. Phone-originated sessions inherit desktop's MCP config — no phone-side config needed. Confirm this is acceptable.
6. **Workspace pane / Missions / SSH** — explicitly out of scope per brief, but user might later want Mission status pushes ("Flight A reached milestone 3"). Cheap to add via same WS. Flag for v1.
7. **Pairing-code TTL** — recommend 60s like OAuth device-flow code. **Max paired devices** per install — recommend 5, configurable.

## File references used

- `D:\projects\PacketADE\src-tauri\src\commands\api_agent.rs` (entry-point, event names, permission/edit machinery)
- `D:\projects\PacketADE\src-tauri\src\commands\agent_sidecar.rs` (sidecar supervisor, event mirroring, lifetime stats — template for `mobile_relay`)
- `D:\projects\PacketADE\src-tauri\src\core\llm_provider.rs` (provider trait — backend symmetry)
- `D:\projects\PacketADE\src-tauri\src\commands\conversations.rs` (on-disk transcript persistence)
- `D:\projects\PacketADE\agent-sidecar\src\protocol.ts` (captured at protocol v4; check the source constant for current protocol)
- `D:\projects\PacketADE\agent-sidecar\src\index.ts` (dispatch loop)
- `D:\projects\PacketADE\src\stores\agentTaskStore.ts` (reference event consumer — `installApiAgentListeners`)
- `D:\projects\PacketADE\src\types\agent-conversation.ts` (`AgentConversation`, `PendingPermission`, `PendingEdit`, `resumeToken`)
- `D:\projects\PacketADE\CHANGELOG.md` (SSH hardening playbook — v0.6.0 Phases 1–3)

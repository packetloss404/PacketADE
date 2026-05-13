# PacketADE Mobile — v0 MVP Plan

> Captured 2026-05-12.

## North star

A PWA at `app.packetade.dev` that lets a phone:
- See live agent chunks from one or more conversations.
- Approve / deny one pending tool call.
- Send a follow-up message.
- Get a Web Push notification when approval is needed.

Without:
- Requiring an Anthropic-style cloud infrastructure.
- Going through Apple's App Store / TestFlight.
- Exposing inbound ports on the user's desktop.

## In scope

- Desktop pairing UX (QR + fingerprint, modeled on `ServerFormModal`)
- Self-hosted relay (Rust, ~600 lines, deployed on existing infra)
- E2E encryption (relay sees ciphertext only)
- Web Push for "permission needed" wake
- PWA shell with the four key screens (see `mock.html`)
- Default device capability scope: `respond` (approve/deny + send messages; no new conversations from phone)

## Out of scope for v0

- Native iOS app (deferred — PWA covers it)
- New conversations from phone
- MCP / profile editing from phone
- Multi-pane / workspace mirroring
- File browser / code viewer
- Voice input
- Attachments (image upload)
- Worktree / SSH workspace selection
- Multi-desktop-per-phone (design in but defer second-desktop UX)

## Build order — smallest leaps first

### 1. Relay v0 — Rust binary that proxies one WS pair by sessionId
- ~200 lines. No auth, no push yet.
- Just: open WS → register by token → forward frames to the other side of the token.
- Deploy to existing infra under a stable hostname.

### 2. Desktop bridge — `core/mobile_relay.rs`
- Mirror of `agent_sidecar.rs::SidecarManager` — supervised long-lived task.
- Opens outbound WS to relay on app boot.
- Subscribes to existing `api-agent:*` Tauri events via `Listener` trait.
- Forwards them as JSON over WS (still cleartext for now).

### 3. Pairing UX on desktop
- New `src/components/views/MobileView.tsx`.
- New `src/stores/mobileStore.ts` (persisted under `packetade:mobile-devices`).
- New `AppView` entry `"mobile"` in `appStore.ts`.
- Backend: `src-tauri/src/commands/mobile.rs` with `mobile_start_pairing`, `mobile_list_devices`, `mobile_revoke_device`.
- QR encodes `{relay URL, sessionId, desktopPubkey, expiry}`.
- "Trust this device" gate mirroring `ssh_fetch_fingerprint` / `ssh_pin_host` UX.

### 4. iOS PWA v0 — paired terminal mode
- React + Tailwind, dark theme, system fonts.
- Vaul for bottom sheets, Framer Motion for spring animations.
- WebSocket connection to relay.
- WebCrypto for X25519 key derivation + AES-GCM frame encrypt/decrypt.
- Screens: pairing (QR scanner), conversation list, chat view, permission sheet.
- Default to one conversation in v0 — multi-conversation lookup in v0.1.

### 5. E2E encryption layer
- Both ends use X25519 + Ed25519 + HKDF + AES-GCM (Noise-style).
- Pairing handshake derives per-device long-term symmetric key.
- All WS frames after pairing are AES-GCM ciphertext.
- Relay code unchanged — it never sees plaintext.
- Long-term keys live in OS keyring (`mobile-device-<id>`, service `KEYRING_SERVICE`).

### 6. Web Push
- Relay gets `web-push` Rust crate + VAPID keypair.
- Desktop calls `push_to_device(deviceId, payload)` on relay when `permission-request` event fires.
- PWA registers a service worker subscribed to relay's VAPID public key.
- Push payload is enough to render the notification but **not** the full agent context — fetch on app foreground.

### 7. Permission-request replay
- Buffer last N (e.g. 50) events per session on the relay.
- When phone reconnects after offline period, send `{type:"subscribe", sessionId, sinceAck:N}` → relay replays buffered events.
- Verify in `api_agent.rs` that the `pending_permissions` `oneshot` channel survives 4 min of phone offline. Likely yes for in-process; check sidecar path.

## Steps 1–4 are the "MVP demo"

Desktop + phone in the same room. Agent streams to phone. Approval works. ~2 weeks for one person.

## New Rust modules (final list)

| Module | Purpose | Template |
|---|---|---|
| `src-tauri/src/core/mobile_relay.rs` | WS lifecycle, outbound supervisor | `agent_sidecar.rs::SidecarManager` |
| `src-tauri/src/core/mobile_protocol.rs` | `MobileRequest` / `MobileEvent` envelopes | `agent-sidecar/src/protocol.ts` |
| `src-tauri/src/core/mobile_pairing.rs` | Token issuance, fingerprint pinning per device | `commands/ssh_keys.rs` + `pty.rs::ssh_pin_host` |
| `src-tauri/src/commands/mobile.rs` | Tauri commands surface | `commands/ssh_keys.rs` |

## New frontend (desktop side)

- `src/components/views/MobileView.tsx` — pairing QR, device list, revoke.
- `src/stores/mobileStore.ts` — paired devices, persisted.
- `AppView` entry `"mobile"` in `appStore.ts`.

## Relay deployment

Single static Rust binary behind nginx/Caddy for TLS termination.

```
relay.packetade.dev
├── /pair/start          POST — issue pairing slot
├── /pair/complete       POST — complete pairing handshake
├── /ws/desktop/:token   WS  — desktop outbound connection
├── /ws/mobile/:token    WS  — phone connection
└── /push/:deviceId      POST (auth'd) — desktop triggers Web Push
```

In-memory state only:
- `Map<token, (desktopSocket, mobileSocket)>` — active routing pairs
- `Map<token, Vec<Frame>>` — last N buffered frames per session

Persistent state on relay:
- VAPID keypair
- Optional: rate-limit counters (per device, per IP)

No agent state. No transcripts. No API keys.

## Success criteria

- One paired phone receives all `chunk` events with < 200 ms latency.
- Approving a `permission-request` from the phone unblocks the desktop agent loop within 100 ms of the Allow tap.
- Phone receives Web Push within 5 s of a `permission-request` even if app is closed.
- Relay can be killed and restarted with no client-visible state loss (desktops reconnect within 1 s).
- A revoked device cannot reconnect.

## Risks

- **Web Push reliability on iOS** — Apple's Web Push implementation has been less reliable than APNs proper. Bake in fallback: in-app banner on next foreground.
- **WebCrypto API gotchas** — some primitives (HKDF in particular) had Safari quirks until iOS 17. Verify on iOS 16.4 vs 17+ early.
- **Relay scaling** — single binary fine for <1k concurrent desktops. Beyond that, shared-state via Redis. Defer.
- **Pairing flow on PWA** — scanning a QR from inside a PWA requires camera permission + `getUserMedia`. Works but takes a permission prompt. Alternative: type a 6-character code shown on desktop.

# Research — iOS / Mobile Stack Building Blocks

> Captured 2026-05-12. Frozen snapshot. Native iOS context preserved here even though current direction is PWA-first (see `distribution-and-pwa.md`) — if we ever revisit native, this stays accurate.

## Framework choice

### Native SwiftUI [recommended if going native]

- ~150 lines of CryptoKit covers X25519 + Ed25519 + HKDF + AES-GCM for E2E. [CONFIRMED — `Curve25519.KeyAgreement`, `Curve25519.Signing`, `HKDF`, `AES.GCM`]
- `URLSessionWebSocketTask` for WS; `NWConnection` if we want lower-level control. [CONFIRMED — [Apple docs](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)]
- `UNUserNotificationCenter` for APNs.
- `BackgroundTasks` for periodic refresh (not for sustained WS — see gotchas).
- Small surface area for a one-person companion.

### Tauri Mobile [NOT recommended]

- Tauri v2 is stable for mobile in name, but **Node.js sidecars are explicitly unsupported on iOS** — [tauri-apps/tauri#11454](https://github.com/tauri-apps/tauri/discussions/11454) still open. [CONFIRMED]
- Since the entire desktop architecture is "Rust + Node sidecar," you'd reimplement the iOS half from scratch anyway. Zero meaningful code reuse.

### React Native / Expo [viable, not recommended for v0]

- Type-sharing win is modest (would share `AgentConversation` / `AgentCli` shapes at best).
- Pay back in APNs setup complexity, background-task plugin maintenance, New Architecture migration treadmill.
- Expo's push pipeline does work and is well documented. [CONFIRMED — [Expo push docs](https://docs.expo.dev/push-notifications/push-notifications-setup/)]

### Flutter / Lynx / Capacitor [not relevant]

- Flutter buys nothing here.
- Lynx is too new.
- Capacitor is for wrapping existing web UIs — only useful if we go PWA and want to wrap it later for App Store presence.

## Transport options

### WebSocket through a self-hosted relay [recommended]

- Default for v0. WebSocket protocol works through Cloudflare Tunnel since 2022. [CONFIRMED — [Cloudflare WS docs](https://developers.cloudflare.com/network/websockets/)]
- Same topology as Remodex uses for OpenAI Codex remote-control case. [CONFIRMED — [Remodex GitHub](https://github.com/Emanuele-web04/remodex)]
- Self-hosted: Fly.io / Cloudflare Workers + Durable Objects / your own VPS with Caddy.
- Relay forwards opaque encrypted frames; never sees plaintext (if E2E enabled).

### LAN direct via Bonjour [defer / fast-path only]

- iOS 14+ requires Local Network permission; prompt is finicky in production vs TestFlight builds. [CONFIRMED — [Apple forum 766133](https://developer.apple.com/forums/thread/766133)]
- `.local` resolution broken on some iOS 17+ setups. [CONFIRMED — [Nabto iOS 14.5 notes](https://docs.nabto.com/developer/platforms/ios/ios145.html)]
- Don't make this the only path. Optional fast-path at most.

### Tailscale embedding

- `libtailscale` ships an iOS-suitable xcframework with a working LocalAPI implementation. [CONFIRMED — [libtailscale swift README](https://github.com/tailscale/libtailscale/blob/main/swift/README.md)]
- Shifts first-time pairing UX onto Tailscale's account model — most non-developer users don't have one. Treat as advanced option, not default.

## Auth / pairing

### QR + Noise-style handshake [recommended]

Remodex's flow is a near-perfect blueprint:
1. Desktop generates Ed25519 identity keypair.
2. QR encodes `{relay URL, session ID, bridge device ID, bridge Ed25519 pubkey, expiry}`.
3. Handshake uses fresh X25519 ephemerals signed by each side's Ed25519 identity.
4. HKDF-SHA256 derives directional AES-256-GCM keys.

Apple's `CryptoKit` ships all of this natively. WebCrypto (PWA) also covers all primitives. [INFERRED from API surface]

### Not recommended

- **SPAKE2** is more useful with a short human-shared password; QR already has high-entropy pubkey in the channel.
- **Apple Sign-In** — overkill for self-hosted single-user.
- **mTLS** — overkill for v0.

Reference designs: Plex (claim token URL), Signal Desktop (QR with identity pubkey), Tailscale Apple TV (QR linking flow). [CONFIRMED]

## iOS-specific gotchas (applies to both native and PWA)

- **WebSockets do not stay alive in background.** iOS suspends sockets within ~30s of backgrounding. You cannot stream chunks to a backgrounded app. [CONFIRMED — [Apple forum 750136](https://developer.apple.com/forums/thread/750136)]
- **Silent push (`content-available: 1`) is best-effort.** Apple gives ~30s of wake time but throttles aggressively on battery / Low Power Mode and may drop them. Never rely on silent push for delivery — surface a real user-visible alert for "approval needed." [CONFIRMED — [Medium: silent pushes opportunities not guarantees](https://mohsinkhan845.medium.com/silent-push-notifications-in-ios-opportunities-not-guarantees-2f18f645b5d5)]
- **PushKit/VoIP push is a trap.** Apple cracked down post-iOS 13 — must call CallKit on every VoIP push or app gets rejected. Don't abuse for approval prompts. [CONFIRMED]
- **BGAppRefresh is unreliable for real-time.** Metered by ML-based system heuristics. Cache warming only. [CONFIRMED — [Apple Background Tasks forum](https://developer.apple.com/forums/tags/backgroundtasks)]
- **iOS 26 introduces `BGContinuedProcessingTask`** which may help, but is new. [CONFIRMED — [WWDC 2025 explainer](https://dev.to/arshtechpro/wwdc-2025-ios-26-background-apis-explained-bgcontinuedprocessingtask-changes-everything-9b5)] [UNKNOWN] whether it fits an always-on WebSocket use case.
- **Local Network permission prompt is unpredictable** between TestFlight and App Store builds. [CONFIRMED]
- **App Review framing:** "Remote control of desktop" is fine — Screens, DeskIn, Apple Remote Desktop all ship — but pure web-mirror "thin clients for cloud apps" get rejected under 4.2. App must feel native, not a WKWebView wrapper around React UI. [CONFIRMED — [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)]
- **TestFlight is the right distribution for v1** of a native app. Free, 90-day builds, up to 10k testers. (See `distribution-and-pwa.md` for the full distribution analysis.)

## MVP architecture (if native)

Add a Rust command `start_relay_bridge` in `src-tauri/src/commands/`. It opens an outbound WebSocket to a small relay (one ~50-line Node/Bun process forwarding by session ID), generates an Ed25519 identity, exposes a "Pair iPhone" button in `AgentsView` that shows a QR with `{relay URL, sessionId, bridgePubkey, expiry}`. Relay forwards opaque encrypted frames between bridge and any iPhone session for that ID. Desktop subscribes to existing `api-agent:*` Tauri events, JSON-serializes them, AES-GCM-encrypts with the per-device key from `appdata/devices/<deviceId>.json`, pushes. iOS (SwiftUI + CryptoKit + URLSessionWebSocketTask) holds chat list, streams chunks into a `Text` view, renders permission-request events as a confirmation sheet, posts approve/deny back as another encrypted frame. When desktop sees a `permission-request` and no phone is connected, it calls APNs HTTP/2 directly using a `.p8` token (no third-party service) with visible alert. User taps, app launches, WebSocket reconnects through relay, pending request is replayed from a small bridge-side queue.

Total moving parts: one self-hosted relay (~$0–5/mo on Fly), one Rust command, one Swift app, one APNs key. No Anthropic-scale infrastructure.

**Current direction (PWA-first) reuses everything above except:** Swift → React; URLSessionWebSocketTask → browser WebSocket API; APNs HTTP/2 → Web Push + VAPID; CryptoKit → WebCrypto API. The relay protocol is identical.

## Open questions

- **Self-hosted vs you-host:** users bring their own relay (set `PACKETADE_RELAY=…`) like Remodex, or PacketADE operates a shared one? Latter is friendlier but carries APNs/VAPID rotation + abuse risk. [Product call]
- **iOS 26 `BGContinuedProcessingTask`** real-world WebSocket viability — worth a TestFlight spike before committing to "APNs wake only." [UNKNOWN]
- **Multi-conversation fan-out:** `api-agent:*` events are per `sessionId`. Verify relay can multiplex N concurrent agent sessions to one phone without re-architecting `agentTaskStore`. [INFERRED yes]
- **Permission-request replay semantics:** if phone is offline when tool needs approval and user approves 4 min later, does desktop's `permission-request` future still exist? In-process `LlmProvider` path stays parked; sidecar path is [UNKNOWN]. Worth a code check in `src-tauri/src/commands/api_agent.rs`.
- **Tailscale tier:** embed `libtailscale` as opt-in "power user" mode or stay relay-only? Adds ~5 MB and second pairing concept; defer to v2.

## Sources

- [Tauri Mobile / iOS status](https://v2.tauri.app/blog/tauri-20/), [Tauri sidecar on mobile #11454](https://github.com/tauri-apps/tauri/discussions/11454)
- [React Native vs SwiftUI 2026](https://www.iswift.dev/comparisons/swiftui-vs-react-native), [Mobiloud RN vs Swift](https://www.mobiloud.com/blog/react-native-vs-swift)
- [URLSessionWebSocketTask vs NWConnection](https://www.appspector.com/blog/websockets-in-ios-using-urlsessionwebsockettask), [Apple WebSocket background forum](https://developer.apple.com/forums/thread/750136)
- [iOS 26 BGContinuedProcessingTask](https://dev.to/arshtechpro/wwdc-2025-ios-26-background-apis-explained-bgcontinuedprocessingtask-changes-everything-9b5)
- [Silent push opportunities not guarantees](https://mohsinkhan845.medium.com/silent-push-notifications-in-ios-opportunities-not-guarantees-2f18f645b5d5)
- [libtailscale Swift README](https://github.com/tailscale/libtailscale/blob/main/swift/README.md), [Tailscale QR pairing](https://tailscale.com/kb/1336/device-add-qr-code)
- [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)
- [Local Network permission iOS](https://developer.apple.com/forums/thread/766133)
- [Remodex (closest prior art)](https://github.com/Emanuele-web04/remodex)
- [SPAKE2 RFC 9382](https://datatracker.ietf.org/doc/rfc9382/), [OuterCorner Noise Swift](https://github.com/OuterCorner/Noise)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Expo push notifications](https://docs.expo.dev/push-notifications/push-notifications-setup/)

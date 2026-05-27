# PacketADE Mobile — Planning Folder

Status: **superseded for implementation** by
[`../remoteagents/README.md`](../remoteagents/README.md). Keep this folder as
May 2026 research/background only; the current phone/PWA plan is Packet account
sign-in plus a Packet Cloud relay, starting as a PWA.

Living folder for the **PacketADE Mobile companion** investigation (May 2026). The
phone client connects to the **API agents** in the desktop app — NOT to
workspaces / PTYs / file editor. It mirrors Claude Code's "Remote Control"
feature pattern, adapted for PacketADE's existing `api-agent:*` event contract.

## Decision log (latest first)

- **2026-05-27** — Superseded by the Remote Agents plan in
  `dev/remoteagents/`: cloud relay is Packet Cloud/Cloudflare-based,
  sign-in is account-first (no QR primary flow), PWA comes before any native
  iOS/TestFlight work, and all provider secrets stay on the desktop.
- **2026-05-12** — Direction set: build as a **PWA first**, native SwiftUI later
  if needed. Reuses existing React components, avoids App Store / TestFlight
  gatekeeping, supports Web Push since iOS 16.4. See
  `distribution-and-pwa.md`.
- **2026-05-12** — Hosting: **self-hosted relay** on existing infra.
  Recommended stack is a small Rust binary (axum + tokio-tungstenite + `a2`
  for APNs / `web-push` for browser). See `architecture-fit.md` §3.
- **2026-05-12** — Architecture: **hybrid local-WS + cloud relay**, E2E
  encrypted (Noise/X25519/Ed25519 via CryptoKit on iOS, equivalent on web
  via WebCrypto). Relay sees only ciphertext.
- **2026-05-12** — iOS app talks to the **Rust core**, not the sidecar. The
  existing `api-agent:*` event envelope is reused over WebSocket.

## Files in this folder

| File | Purpose |
|---|---|
| `README.md` | This index + decision log. |
| `research-claude-code-ios.md` | How Claude Code's iOS "Remote Control" actually works (cloud-relayed via Anthropic API, QR pairing, APNs). |
| `research-competitors.md` | Mobile companion patterns across the AI-coding-agent market (Cursor, Codex, Devin, Replit, etc.) with verdicts. |
| `research-ios-stack.md` | iOS framework / transport / pairing / push tradeoffs. Native SwiftUI vs React Native vs PWA. |
| `architecture-fit.md` | How the iOS client maps onto PacketADE's existing Rust core + sidecar + frontend stack. Specific file refs and module sketches. |
| `distribution-and-pwa.md` | TestFlight vs personal provisioning vs PWA distribution options; PWA fidelity analysis for matching Claude's look and feel. |
| `v0-plan.md` | Concrete v0 MVP: in-scope, out-of-scope, build order, new Rust modules. |
| `mock.html` | Static visual mock of the 4 key PWA screens (conversation list, chat view, permission sheet, pairing). |

## Open questions still to settle

1. **Tenant model.** Single tenant (one relay, anyone with PacketADE installed
   pairs) or multi-tenant (accounts scoping each install)?
2. **Desktop ↔ relay connection model.** Always-connected vs connect-on-demand.
   Leaning always-connected — trivial cost on small scale.
3. **Default device capability scope.** Recommend `respond` for v0 (approve /
   deny / send messages, no new conversations from phone).
4. **Multi-desktop-per-phone.** Design in now or defer to v1?
5. **APNs ownership** — even though we're going PWA-first, Web Push still
   needs a VAPID keypair on the relay. Cheaper than APNs setup but still
   needs an owner.
6. **Pairing-code TTL** — recommend 60s like an OAuth device-flow code.
7. **Permission-request replay semantics** — if the phone is offline and
   approves 4 minutes later via push, does the desktop's pending `oneshot`
   still exist? Worth a code check in `src-tauri/src/commands/api_agent.rs`
   before committing.

## How to revisit

Start with [`../remoteagents/README.md`](../remoteagents/README.md) for current
implementation work. Use this file only to understand the earlier research path.
The research files are frozen snapshots — don't edit them unless you are adding
a clearly dated correction note.

## Cross-refs

- Existing event contract: `src-tauri/src/commands/api_agent.rs` (in-process
  branch), `src-tauri/src/commands/agent_sidecar.rs` (sidecar branch), both
  emit `api-agent:{chunk,thinking,thinking-stop,tool-start,tool-result,permission-request,pending-edit,done,error,plan-block,tool-output-extended,turn-summary}:<sessionId>`.
- Reference event consumer: `src/stores/agentTaskStore.ts::installApiAgentListeners`.
- Sidecar protocol baseline at capture time: `agent-sidecar/src/protocol.ts`
  was protocol v4. Current truth is the constant in that source file.
- Pairing security playbook to copy: `src-tauri/src/commands/pty.rs::ssh_pin_host` and `ServerFormModal.tsx`.

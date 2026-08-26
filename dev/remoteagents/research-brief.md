# Remote Agents Research Brief

Last updated: 2026-05-26

This brief compresses four research lanes into one implementable direction: competitor/UX baseline, auth/security, relay/mobile platform, and encryption/protocol.

## Research Lane 1: Competitor And UX Baseline

### What Claude Remote Control Teaches Us

Anthropic's Remote Control connects `claude.ai/code` and the Claude mobile apps to a local Claude Code session running on the user's machine. Their docs are explicit that the local session keeps running locally and that the machine makes outbound HTTPS requests only. The server routes messages between web/mobile and the local session over a streaming connection. The phone signs into the same Claude Code account and can receive push notifications for completion or decisions.

Source: [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control)

Important interpretation for PacketADE:

- The QR command mentioned by Claude is for downloading the mobile app, not the core trust model.
- The primary cloud UX is account sign-in, same-account discovery, and a local session registered through a vendor cloud.
- The user correction is right: copying the product feel means avoiding QR as the main flow.

### What Claude Code On The Web Teaches Us

Claude Code on the web is distinct from Remote Control. It runs tasks on Anthropic-managed cloud infrastructure, while Remote Control executes locally. Anthropic positions web/mobile as a way to steer the task and answer questions.

Source: [Claude Code on the web docs](https://code.claude.com/docs/en/claude-code-on-the-web)

PacketADE implication:

- PacketADE Remote Agents should be modeled on "remote control of local runtime", not "cloud VM coding task", because PacketADE needs local provider config, MCP, workspaces, and secrets.
- A future "Packet Cloud Workers" feature could run remote cloud workspaces, but that is a separate product surface.

### What Codex Cloud Teaches Us

OpenAI Codex web delegates tasks to Codex cloud environments. It is a cloud-agent pattern rather than a local desktop relay pattern.

Source: [OpenAI Codex web docs](https://developers.openai.com/codex/cloud)

PacketADE implication:

- Codex is useful for UX expectations: start tasks from phone, monitor, steer, continue later.
- It is less useful as a direct architecture because PacketADE's configured providers/models live on the desktop.

## Research Lane 2: Auth And Device Trust

### Passkeys/WebAuthn

WebAuthn creates public-key credentials scoped to a relying party, with user consent and authenticator control. OWASP describes FIDO2/WebAuthn as the foundation of modern passkeys and notes the phishing-resistance benefit from origin binding.

Sources:

- [WebAuthn Level 3](https://w3c.github.io/webauthn/)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [NIST SP 800-63B-4](https://csrc.nist.gov/pubs/sp/800/63/B/4/final)

Recommendation:

- Use passkeys as the primary Packet Cloud sign-in method.
- Provide email magic link or one-time code as recovery/fallback.
- Do not ship username/password in v1 unless the auth provider forces it. Passwords add reset flows, breach handling, credential stuffing defenses, password rules, and support burden.

### OAuth/OIDC For Desktop And PWA

For desktop/native clients, OAuth for Native Apps recommends external user agents and Authorization Code with PKCE. OAuth Security BCP deprecates the resource owner password credentials grant and recommends modern security controls.

Sources:

- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)
- [RFC 9700: OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)

Recommendation:

- Desktop PacketADE signs into Packet Cloud through the system browser using Auth Code + PKCE, loopback redirect, and refresh token rotation.
- The PWA should use a browser session model with HttpOnly Secure SameSite cookies and short-lived WebSocket tickets minted by the backend.
- Do not put long-lived access or refresh tokens in localStorage.

### Device Authorization Flow And QR

RFC 8628 Device Authorization Grant exists for input-constrained devices. It allows QR/NFC as a non-textual optimization, but still relies on user code confirmation. PacketADE desktop is not input constrained; it has a full UI and can use browser PKCE.

Source: [RFC 8628: OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)

Recommendation:

- Do not use OAuth device flow for PacketADE desktop v1.
- Keep device flow in reserve for a future FlightDeck/TUI flow where the client is terminal-first.
- Do not use QR for primary cloud trust. Use account sign-in plus desktop approval.

### DPoP / Proof Of Possession

DPoP binds access/refresh token use to possession of a client private key, reducing the value of leaked bearer tokens.

Source: [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession](https://datatracker.ietf.org/doc/html/rfc9449)

Recommendation:

- Use short-lived WebSocket tickets in MVP.
- Design ticket records to include device public key binding so DPoP or signed request proofs can be added without changing the product flow.
- For desktop host connections, require a host key signature on connection establishment in addition to cloud-issued tickets.

## Research Lane 3: Relay, WebSockets, Push, And PWA

### WebSocket Security

OWASP highlights Cross-Site WebSocket Hijacking, authentication bypass, injection, DoS, and monitoring gaps. It recommends WSS, origin validation, session expiry, token refresh, message-level authorization, schema validation, size limits, rate limits, and logging without sensitive data.

Source: [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)

Recommendation:

- WebSocket connection auth is necessary but insufficient.
- Authorize every route action against user, desktop, device, session, and capability.
- Disable compression unless there is a measured need.
- Enforce envelope size limits.
- Redact tokens and transcript content from logs.
- Close active WebSockets immediately on logout or device revocation.

### API Abuse And Authorization

OWASP API Security Top 10 lists broken object-level authorization, broken authentication, unrestricted resource consumption, and broken function-level authorization as core API risks.

Source: [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)

Recommendation:

- Treat every `desktopId`, `deviceId`, `conversationId`, and `sessionId` as hostile user input.
- Check owner/tenant and capability on each request.
- Rate limit per account, per desktop, per device, per IP, and per action class.
- Apply tighter limits to sign-in, access requests, push sends, and start-session.

### Cloudflare Durable Objects (evaluated alternative)

Durable Objects can act as WebSocket servers and coordinate multiple clients in one stateful object. Hibernation can keep WebSocket clients connected while reducing idle cost.

Source: [Cloudflare Durable Objects WebSockets docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

Disposition (owner decision 2026-08-02):

- Do not implement the PacketADE relay on Cloudflare.
- Preserve the useful host-room, bounded replay, and hibernation lessons as
  provider-neutral requirements.
- Implement those requirements in the standalone Rust service at
  `D:\projects\packetrelay` with PostgreSQL-backed durable state.
- Keep the desktop/PWA protocol relay-neutral and contract-tested.

### Web Push And iOS PWA Constraints

The Push API requires a service worker and produces a subscription endpoint and encryption keys. iOS supports Web Push for web apps saved to the Home Screen starting with Safari/iOS 16.4. VAPID provides application server identification for Web Push.

Sources:

- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Safari 16.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes)
- [RFC 8292: VAPID for Web Push](https://www.rfc-editor.org/rfc/rfc8292)

Recommendation:

- PWA push is good enough for MVP, but treat iOS delivery as best-effort.
- Push payloads should be redacted: "PacketADE needs approval" rather than command content.
- PWA must provide in-app reconnect and attention badges because push may be delayed or suppressed by iOS Focus modes.
- Native iOS later can use APNs, Keychain, and better background behavior.

## Research Lane 4: E2EE And Protocol Choices

### HPKE

HPKE is a standard hybrid public key encryption scheme combining public-key key establishment with symmetric AEAD encryption. RFC 9180 includes X25519 and P-256 instantiations with HKDF and AES-GCM/ChaCha20-Poly1305.

Source: [RFC 9180: Hybrid Public Key Encryption](https://www.rfc-editor.org/rfc/rfc9180.html)

Recommendation:

- Use an audited HPKE library for encrypting relay frames to the desktop/device public keys, or use Noise via audited libraries if bidirectional streaming is easier.
- Prefer X25519 where supported; support P-256 fallback for browser compatibility.
- Do not invent crypto beyond protocol composition, nonce/sequence tracking, and envelope AAD.

### MLS

MLS is a group messaging E2EE standard for multi-device groups with forward secrecy and post-compromise security.

Source: [RFC 9420: Messaging Layer Security](https://www.ietf.org/rfc/rfc9420)

Recommendation:

- Do not adopt MLS for MVP. One desktop plus one or a few devices is simpler than MLS justifies.
- Revisit MLS when PacketADE supports team spaces, multiple desktops, shared conversations, or simultaneous multi-device editing.

## Resolved Arguments

### Cloud Sign-In vs QR

Decision: **Cloud sign-in primary; desktop approval for device trust; no QR primary flow.**

Reasoning:

- Matches Claude/Codex-style user expectation better.
- Supports lost phone, revocation, multiple devices, and future billing/limits.
- Avoids "scan the desktop" friction.
- Desktop approval preserves local-machine trust without making QR the product shape.

### Relay Plaintext vs E2EE

Decision: **E2EE for agent transcript/action frames; cloud sees routing and audit metadata only.**

Reasoning:

- Provider secrets and workspace contents are sensitive.
- A relay breach should not expose transcripts or tool arguments.
- Desktop can enforce action authorization after decrypting and verifying signed device messages.

Tradeoff:

- Cloud cannot inspect or moderate exact content. It can still rate-limit, revoke, route, and audit metadata. Desktop remains the final policy gate.

### PWA vs Native iOS

Decision: **PWA first, native iOS/TestFlight later.**

Reasoning:

- PWA can ship fastest and reuse React/Vite patterns.
- iOS Web Push is available for Home Screen PWAs, though less reliable than APNs.
- Native adds App Review/TestFlight friction and storage/push advantages. It should follow once the core protocol is stable.

### Cloudflare DO vs Rust Relay

Decision (superseded 2026-08-02): **Use the standalone Rust `packet-relay`
service for v1; keep the protocol relay-neutral.**

Reasoning:

- Packet Relay already exists as an independently buildable Rust/Tokio service
  with bounded WebSocket, connection, message, queue, and session limits.
- Owning the relay avoids a second provider-specific implementation and keeps
  deployment portable.
- The service can preserve its inherited bridge/broadcast/room protocols while
  adding a separately versioned PacketADE host/device surface.
- PostgreSQL provides durable tickets, replay, audit, and outbox state while
  active socket routing stays simple and single-instance for v1.

Required evolution before PacketADE beta:

- HTTPS auth/control plane and short-lived single-use WebSocket tickets.
- Origin validation, device ACL/revocation, and multiple devices per host.
- PostgreSQL migrations for identity metadata, replay, cursor, audit, and outbox state.
- Web Push and encrypted artifact references.
- Reconnect/load/security gates without weakening the 64 KiB inline ceiling.

## Source Index

- Claude Remote Control: https://code.claude.com/docs/en/remote-control
- Claude Code on web: https://code.claude.com/docs/en/claude-code-on-the-web
- OpenAI Codex web: https://developers.openai.com/codex/cloud
- WebAuthn Level 3: https://w3c.github.io/webauthn/
- NIST SP 800-63B-4: https://csrc.nist.gov/pubs/sp/800/63/B/4/final
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OAuth Native Apps RFC 8252: https://www.rfc-editor.org/rfc/rfc8252.html
- OAuth Device Authorization RFC 8628: https://www.rfc-editor.org/rfc/rfc8628
- OAuth Security BCP RFC 9700: https://www.rfc-editor.org/rfc/rfc9700.html
- DPoP RFC 9449: https://datatracker.ietf.org/doc/html/rfc9449
- OWASP WebSocket Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- Cloudflare Durable Objects WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- MDN Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- Safari 16.4 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes
- VAPID RFC 8292: https://www.rfc-editor.org/rfc/rfc8292
- HPKE RFC 9180: https://www.rfc-editor.org/rfc/rfc9180.html
- MLS RFC 9420: https://www.ietf.org/rfc/rfc9420
- Apple TestFlight: https://developer.apple.com/testflight/
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/

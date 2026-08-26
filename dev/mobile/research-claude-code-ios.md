# Research — Claude Code iOS "Remote Control"

> Captured 2026-05-12. Frozen snapshot. If the landscape changes, add a new dated section at the bottom rather than editing.

## TL;DR

Claude Code does not ship a standalone iOS app. Mobile access is the **"Code" tab inside the regular Claude iOS app** (App ID `6473753684`). The feature is called **Remote Control** (CLI flag `--remote-control` / `--rc`, slash command `/remote-control`), released Feb 2026. Requires Claude Code v2.1.51+ (push needs v2.1.110+).

## 1. Connection architecture

**Cloud-relayed via Anthropic's API.** [CONFIRMED — official docs at https://code.claude.com/docs/en/remote-control]

> "Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports on your machine. When you start Remote Control, it registers with the Anthropic API and **polls for work**. When you connect from another device, the server **routes messages** between the web or mobile client and your local session over a **streaming connection**."

- Both phone and laptop dial out to Anthropic's API; Anthropic relays.
- The agent itself runs on the user's laptop (filesystem, MCP, tools all local).
- [INFERRED] "Streaming connection" + "polls for work" suggests long-poll or HTTP/2 server-push, but the exact wire format is **[UNKNOWN]** — not publicly documented.
- [CONFIRMED] Offline / CLI off: if the machine can't reach the network for ~10 min, the session times out and exits. **No persistent cloud queue** — when the CLI is dead, the session is dead. Auto-reconnect covers sleep/transient drops only.

## 2. Pairing / auth

- **Account-tied via claude.ai OAuth.** [CONFIRMED] Pro/Max/Team/Enterprise subscription required; API keys explicitly cannot start Remote Control sessions. `claude /login` and workspace trust acceptance are prerequisites.
- **QR code is a deep-link to a session URL** — not part of any key-exchange. [CONFIRMED] You can also pair by selecting the session from a list once signed in.
- **Multiple short-lived scoped credentials.** [CONFIRMED] Error message confirms: long-lived inference-only tokens (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`) cannot establish RC. A full-scope session token is required, and the spec says: "Multiple short-lived credentials, each scoped to a single purpose and expiring independently."
- **Not E2E.** [CONFIRMED] "All traffic travels through the Anthropic API over TLS, the same transport security as any Claude Code session." Anthropic terminates TLS and can see content in principle. No claim of E2E encryption.

## 3. iOS capabilities

**Confirmed in-scope on mobile:**
- Send prompts, see streaming responses.
- View tool activity.
- Watch a single live session.
- Browse the session list (sessions show a computer icon + green online dot).
- `@`-autocomplete against the **local** filesystem (paths come from the desktop).
- Text-output slash commands: `/compact`, `/clear`, `/context`, `/usage`, `/recap`.

**Local-only / NOT on mobile:**
- `/mcp`, `/plugin`, `/resume` (interactive pickers).
- `/extra-usage`, `/exit`, `/reload-plugins`.

**Where the agent runs:** [CONFIRMED] Desktop. Phone is a thin client streaming I/O.

**Tool-call approval UI on mobile:** [INFERRED] Implied by "stays in sync across all connected devices" and "tool activity" mention, but docs don't enumerate explicit allow/deny mobile UX. **[UNKNOWN]** whether destructive-edit gates show a distinct mobile prompt.

**Related but separate feature: "Dispatch"** — phone-initiated tasks dispatched to **Claude Desktop** (not CLI), which executes locally via computer-use/connectors. Same overall cloud-relayed pattern.

## 4. Push behavior

- [CONFIRMED] APNs is used. Enabled via `/config` → "Push when Claude decides."
- Anthropic explicitly says "If `/config` shows **No mobile registered**, open the Claude app on your phone so it can refresh its push token" — confirms standard APNs token registration via the Claude app.
- **Triggers:** long task completion, decision needed, or explicit user ask ("notify me when tests finish").
- **One global toggle**, no per-event configuration.
- iOS Focus modes / notification summaries can suppress.

## 5. Unknown / undocumented

- **Wire protocol** (WebSocket vs HTTP/2 SSE vs long-poll) — not stated.
- **Whether the phone holds a session-scoped credential** or rides the user's account token.
- **Mobile diff-view fidelity / file browser scope** — `@`-autocomplete works but no documented file tree.
- **Tool-call approval mobile UX details.**
- **Whether QR pairing for Dispatch uses any device-bound key material**, or is purely an OAuth-deep-link.

## 6. What PacketBench inherits from this

Patterns to copy:
- **Outbound-only relay** — desktop never exposes inbound ports. Survives any NAT / corp firewall.
- **QR code from desktop + same-account fallback** — friction-free first pair, alternative when QR isn't visible.
- **Short-lived, scoped credentials per session** — limits blast radius if a phone is stolen.
- **Model-decided pushes, not event-spam** — let the agent itself emit "I'm waiting on you" tokens.
- **Sessions die when desktop is offline; no cloud queue** — keeps the trust boundary clean.

Patterns to avoid:
- **Anthropic's relay sees plaintext.** PacketBench should do E2E (relay sees ciphertext only) since we're not Anthropic and not trusted-by-default.
- **One global push toggle is too coarse.** PacketBench can do per-conversation push preferences cheaply.

## Sources

- [Anthropic — Remote Control docs (authoritative)](https://code.claude.com/docs/en/remote-control)
- [Help Net Security — Anthropic Remote Control launch](https://www.helpnetsecurity.com/2026/02/25/anthropic-remote-control-claude-code-feature/)
- [VentureBeat — Anthropic mobile Claude Code "Remote Control"](https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote)
- [Sealos Blog — Claude Code Mobile 2026](https://sealos.io/blog/claude-code-on-phone/)
- [MindStudio — Channels vs Dispatch vs Remote Control](https://www.mindstudio.ai/blog/claude-code-channels-vs-dispatch-vs-remote-control)
- [Claude iOS App Store listing](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684)
- [Anthropic Support — Cowork/Dispatch pairing](https://support.claude.com/en/articles/13947068)
- [GitHub issue anthropics/claude-code#15922 — mobile companion FR](https://github.com/anthropics/claude-code/issues/15922)
- [Happy Coder — third-party companion (QR-pair, claims E2E)](https://apps.apple.com/us/app/happy-codex-claude-code-app/id6748571505)

# Research — Competitor Mobile Companion Patterns

> Captured 2026-05-12. Frozen snapshot. If a tool ships something new, add a new dated section at the bottom rather than editing.

## Per-tool teardown

### Cursor
- **Mobile presence:** yes — PWA only. [CONFIRMED]
- **Connection model:** cloud-mediated. Background agents run in Cursor-provisioned containerized cloud envs; phone is a browser/PWA pointed at `cursor.com/agents`. [CONFIRMED]
- **Auth/pairing:** account-tied OAuth login; no per-device pairing — same web session works. [CONFIRMED]
- **Phone capabilities:** start/stop background agents, monitor progress, send follow-up instructions, review diffs in browser. [CONFIRMED]
- **Push triggers:** in-PWA / Web Push only; no native notification surface documented. [INFERRED]
- **Protocol public?** No — internal cloud-agent API. [CONFIRMED]
- **Takeaway:** skipped native entirely. The agent lives in the cloud anyway, so the device is irrelevant. Minimal mobile engineering.

### GitHub Copilot coding agent + GitHub Mobile
- **Mobile presence:** yes — native iOS/Android (GitHub Mobile, not Copilot-only). [CONFIRMED]
- **Connection model:** cloud-mediated through github.com APIs. Agent runs on GitHub-hosted runners; phone hits the same REST/GraphQL endpoints as web. [CONFIRMED]
- **Auth/pairing:** GitHub OAuth account session. [CONFIRMED]
- **Phone capabilities:** assign issues to Copilot, review/approve PRs, comment line-by-line, merge. [CONFIRMED]
- **Push triggers:** PR ready, review requested, mention, status-check failure, agent completion. [CONFIRMED]
- **Protocol public?** Yes — GitHub REST/GraphQL. [CONFIRMED]
- **Takeaway:** the agent is a *bot user* on the same platform — mobile inherits the entire review/approval surface for free.

### Codex / ChatGPT Code (OpenAI)
- **Mobile presence:** ChatGPT iOS/Android app; Codex-specific mobile control feature shipping ~May 2026 on Android first. [CONFIRMED for Android leak; iOS INFERRED]
- **Connection model:** cloud-mediated via ChatGPT account. Desktop Codex stays the execution environment; phone becomes a control surface for an active desktop session signed into the same account. [CONFIRMED]
- **Auth/pairing:** ChatGPT account; same-account binding. No QR/pairing code. [CONFIRMED]
- **Phone capabilities:** connect to active session, resume later, reconnect after interruption. [CONFIRMED]
- **Push triggers:** not yet documented — feature unreleased. [UNKNOWN]
- **Protocol public?** No. [CONFIRMED]
- **Takeaway:** leveraged existing ChatGPT app + account binding — no new auth surface to build.

### Devin (Cognition Labs)
- **Mobile presence:** **no native app**. Mobile = web at app.devin.ai + Slack mobile. [CONFIRMED]
- **Connection model:** cloud-only. Devin runs in Cognition's cloud sandboxes; user reaches it via web or by `@Devin`-ing in Slack. [CONFIRMED]
- **Auth/pairing:** Cognition account; Slack workspace OAuth for the bot. [CONFIRMED]
- **Phone capabilities:** chat, attach files, kick off runs, review PRs in browser; in-thread updates in Slack. [CONFIRMED]
- **Push triggers:** Slack DM/thread updates on status changes (per-run opt-in). [CONFIRMED]
- **Protocol public?** API exists but proprietary. [CONFIRMED]
- **Takeaway:** outsourced mobile UX to Slack. Zero apps to ship, infinite reach. Anti-pattern if you don't want Slack as a dependency.

### Sourcegraph Cody
- **Mobile presence:** **no** — VS Code / JetBrains / Visual Studio / web only. [CONFIRMED]
- **Takeaway:** explicitly chose not to.

### Replit
- **Mobile presence:** yes — native iOS/Android ("Replit: Vibe Code Apps"). [CONFIRMED]
- **Connection model:** cloud-mediated. Each Repl is a cloud container; app is a chat-first front-end to Replit Agent which writes/deploys code server-side. [CONFIRMED]
- **Auth/pairing:** Replit account login. [CONFIRMED]
- **Phone capabilities:** chat with Agent, scaffold apps, watch live deploys, view simple output. Not a code editor. [CONFIRMED]
- **Push triggers:** Agent/Assistant push notifications on completion or input needed. [CONFIRMED]
- **Protocol public?** SSH to Repls is public; Agent API is not. [CONFIRMED]
- **Takeaway:** chat-first not editor-first — they accepted the phone is bad for code and leaned all the way into conversational delegation.

### Warp
- **Mobile presence:** **no**. iPad/iOS issues open and unresolved. [CONFIRMED]
- **Takeaway:** even an agentic-terminal vendor decided phone isn't worth it yet.

### Cline / Continue / Aider
- **Mobile presence:** **none**. [CONFIRMED] Third parties wrap them via remote-VS-Code tunnels (VSCodeMobile, AirCodum) but nothing first-party.
- **Takeaway:** OSS IDE extensions punt mobile entirely.

### JetBrains Junie
- **Mobile presence:** **no** — IntelliJ/PyCharm/WebStorm only. [CONFIRMED]

### Tailscale (relevant as substrate)
- **Mobile presence:** yes, mature native iOS/Android. [CONFIRMED]
- **Connection model:** WireGuard-based overlay mesh; every device is "on the same LAN". [CONFIRMED]
- **Auth/pairing:** SSO / device-tied; ACLs server-side. [CONFIRMED]
- **Protocol public?** Yes — WireGuard + Tailscale's coordination API. [CONFIRMED]
- **Takeaway:** useful as a *transport* if you want zero-config LAN reach from phone to desktop without exposing ports. Anthropic explicitly avoided this in favor of relay.

### Anthropic Claude iOS app + Claude Code Remote Control
See `research-claude-code-ios.md` for the detailed teardown. Closest analog to PacketADE; best-documented design in the comparable set.

## Patterns worth stealing

1. **Outbound-only relay through your own backend.** Claude Code's model: desktop polls a cloud endpoint, phone talks to the same endpoint, server brokers. No inbound ports, works behind any NAT / corp firewall.
2. **QR code from desktop + same-account fallback.** QR is the friction-free first pairing; "same account signed in" is the fallback when QR isn't visible. Cheap, no PIN entry.
3. **Short-lived, scoped credentials per session.** Don't hand the phone a long-lived API key — issue per-session tokens that expire independently.
4. **Model-decided pushes, not event-spam.** Let the agent itself emit "I'm waiting on you" / "I'm done" tokens. One global toggle beats per-event config sprawl.
5. **Chat-first, not editor-first, on phone.** Replit and Cursor both treated mobile as a delegation/monitoring surface, not a code editor. Match device strengths.

## Anti-patterns to avoid

1. **Requiring overlay networking (Tailscale) for the user.** Adds an install, an account, and an MDM headache.
2. **Pure-PWA with no native shell.** Cursor's PWA works but loses APNs / proper push, Sign-in-with-Apple, share targets, Shortcuts. (See `distribution-and-pwa.md` — iOS 16.4+ Web Push closes most of this gap.)
3. **Outsourcing mobile to Slack only (Devin pattern).** Great reach, locks you to Slack's UX, excludes non-Slack users.
4. **Polling-only with no push.** Without server-initiated push the phone has to be open to see progress — kills the point of mobile delegation.
5. **Long-lived bearer tokens on the phone.** A stolen phone = full agent control.

## Recommendation summary

Build a PWA shell over an outbound-only relay you run yourself. Desktop sidecar already speaks outbound to Anthropic/OpenAI — extend it to also register with your relay and stream `api-agent:*` events upward. Pair via QR (sidecar shows it, browser scans → device-bound short-lived token). Phone is chat-first: pick provider, send prompt, see streamed chunks/tool calls, approve permission requests, get Web Push when the agent's `done` or `permission-request` event fires. Skip Tailscale dependency, skip PTY mirroring, skip a phone-side code editor.

This is essentially the Claude Code Remote Control architecture, adapted for PacketADE's existing event contract.

## Sources

- [Cursor Web & Mobile docs](https://cursor.com/docs/cloud-agent/web-and-mobile)
- [Cursor on web and mobile blog](https://cursor.com/blog/agent-web)
- [GitHub blog: Copilot coding agent + mobile](https://github.blog/developer-skills/github/completing-urgent-fixes-anywhere-with-github-copilot-coding-agent-and-mobile/)
- [GitHub Copilot coding agent docs](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [OpenAI Codex changelog](https://developers.openai.com/codex/changelog)
- [Android Headlines: Codex mobile remote PC control leak](https://www.androidheadlines.com/2026/05/openai-chatgpt-codex-remote-pc-control-android-leak.html)
- [Devin docs intro](https://docs.devin.ai/get-started/devin-intro)
- [Devin Slack integration docs](https://docs.devin.ai/integrations/slack)
- [Cognition Devin 2.0 blog](https://cognition.ai/blog/devin-2)
- [Replit iOS app — App Store](https://apps.apple.com/us/app/replit-vibe-code-apps/id1614022293)
- [Replit Agent on iOS/Android blog](https://blog.replit.com/try-agent)
- [Replit SSH blog](https://blog.replit.com/ssh)
- [Warp mobile feature request](https://github.com/warpdotdev/warp/issues/8037)
- [Sourcegraph Cody docs](https://sourcegraph.com/docs/cody)
- [JetBrains Junie](https://www.jetbrains.com/junie/)
- [Tailscale features](https://tailscale.com/features)
- [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control)
- [Claude consumer iOS App Store](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684)

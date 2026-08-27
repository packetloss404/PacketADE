# Distribution Options & PWA Fidelity

> Captured 2026-05-12.

## The distribution problem

Native iOS apps must pass through Apple's gatekeeping. Three realistic paths for a small/personal-use tool:

### 1. TestFlight — $99/yr Apple Developer Program

- **Internal testing** (up to 100 testers, your own Apple ID + a few friends): **no Apple review at all**. Upload via Xcode → on phone in minutes.
- **External testing** (up to 10,000 testers, public link): one-time "beta review" per build family. Much lighter than App Store review; typically passes in hours. Not enforcing 4.2 "wrapper app" rules same way.
- **Catch:** TestFlight builds **expire after 90 days**. Must re-upload a new build before then.
- This is what most indie dev tools do. Many never graduate to App Store.

### 2. Personal provisioning — free, 7-day expiration

- Free Apple ID, no $99/yr.
- Build in Xcode → install on own device with personal profile.
- **Apps expire every 7 days** — plug into Mac and re-sign weekly. AltStore / SideStore automates this with a desktop helper.
- Limited to 10 app IDs per week per Apple ID.
- Weekly-refresh annoyance compounds for a tool you carry around.

### 3. PWA — zero Apple involvement [CHOSEN]

- Build as web app, "Add to Home Screen" on iPhone.
- **Real push notifications since iOS 16.4** via Web Push API — don't lose the critical "approval needed" wake.
- **Completely bypasses gatekeeping.** Serve from `app.packetbench.dev`, tell users to add to home screen.

## Why PWA-first for PacketBench

1. **Massive code reuse with existing React frontend.** Components like `PermissionPrompt`, chat-bubble layouts, theme tokens (Graphite) — all portable.
2. **No App Store / TestFlight maintenance treadmill** for a 1-person tool.
3. **Web Push closes the critical APNs gap** as of iOS 16.4 (~2 years of users now).
4. **Architecture is identical to native.** Relay + pairing + protocol work is the same. Only the client implementation differs. Can swap to SwiftUI later without re-architecting.
5. **No App Review framing risk** ("wrapper app" rejection under 4.2 doesn't apply).

## What you lose going PWA

- **App switcher screenshot** — generic Safari preview, not a custom card.
- **iOS Shortcuts / Spotlight / Siri** integration.
- **Native blur (`UIVisualEffectView`)** — `backdrop-filter: blur(20px)` is *close*, not identical.
- **Settings.app integration** — PWA doesn't show up in iOS Settings.
- **Edge-swipe back gesture** — workarounds exist but never quite match.
- **Precise Taptic Engine haptics** — Web Vibration API gives a single buzz, not the nuanced Taptic library.

None affect the in-app feel. Ecosystem integration, not look-and-feel.

## Claude Code look-and-feel fidelity in a PWA

**Honest estimate:** ~85–90% visual fidelity, ~80% interactive fidelity. Claude's iOS aesthetic is already web-native — claude.ai desktop has the same look. The pieces that translate 1:1:

- **Dark theme + warm copper accent** — pure CSS.
- **SF Pro typography** — `-apple-system, BlinkMacSystemFont, "SF Pro Display"` renders identically to native on iOS.
- **Rounded cards (16 px radius), generous spacing** — Tailwind defaults.
- **Chat bubbles** (user-right / assistant-left soft backgrounds).
- **Streaming text with blinking cursor on active turn** — CSS animation.
- **Tool call cards with collapsed/expanded states** — CSS + tiny state.
- **Pending-permission cards with allow/deny** — Tailwind + careful spacing/shadow.
- **Status bar bleed** — `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` + `safe-area-inset-*` CSS variables.
- **Standalone mode** (no Safari chrome when launched from home screen) — `<meta name="apple-mobile-web-app-capable" content="yes">`.
- **Custom pull-to-refresh** — disable Safari's default, implement with CSS transform.
- **Smooth 60 fps scroll** — modern iOS Safari handles natively.

PacketBench already has most of the visual language in "Graphite theme" tokens (`bg-bg-primary`, `accent-green`, `text-text-secondary` per CLAUDE.md). Reusing those tokens means the PWA inherits desktop design language for free.

## Tricky but solvable

| Need | Solution | Cost |
|---|---|---|
| iOS-style bottom sheets | [Vaul](https://vaul.emilkowal.ski/) (React drawer library, mimics iOS physics) | ~8 KB |
| Spring animation feel | [Framer Motion](https://www.framer.com/motion/) with `type: "spring", stiffness: 300, damping: 30` | ~50 KB gzipped |
| Edge-swipe back gesture | Always show back button (Anthropic does this too) OR custom `pointermove` handler | Hand-rolled |
| Haptic feedback | Web Vibration API (`navigator.vibrate(10)`) — works on iOS but is single buzz | Acceptable v0 loss |

## Recommended PWA stack

```
Framework:      React (or Solid for tighter perf) — reuses existing components
Routing:        React Router or TanStack Router
Styling:        Tailwind + existing Graphite theme tokens
Components:     Build small kit — Sheet, ListRow, Button, ChatBubble, PermissionCard
Sheets:         Vaul (iOS-feel physics)
Animation:      Framer Motion (spring defaults)
Push:           Web Push API (iOS 16.4+)
Service Worker: Workbox or hand-rolled — offline shell + push handling
```

For component shortcuts: [Konsta UI](https://konstaui.com/) is a Tailwind kit literally designed to look like native iOS. Don't have to use wholesale — even just stealing their button + list-row styles gets you most of the way.

## What the experience feels like

User opens `app.packetbench.dev`, taps "Add to Home Screen" once. From then on the icon is on their dock; tapping it launches full-screen with the PacketBench splash. They see a conversation list that looks like Claude's mobile home tab. Tap a conversation → smooth slide animation (Framer Motion) into a chat view with streaming chunks. When desktop agent asks for permission, a bottom sheet (Vaul) slides up with allow/deny buttons. Phone vibrates briefly. Tap allow → sheet slides down, agent continues.

If handed someone the phone they wouldn't notice it wasn't native unless they tried the edge-swipe back gesture.

## Pivot plan if PWA hits a wall

If the PWA experiment proves the architecture and the user wants more polish, native SwiftUI is a clean follow-on. The relay protocol, pairing flow, and event envelopes are identical. Only swap:

- React → SwiftUI
- WebSocket API → URLSessionWebSocketTask
- Web Push + VAPID → APNs HTTP/2 + `.p8`
- WebCrypto API → CryptoKit

The relay code, Rust modules, and desktop UI don't change at all.

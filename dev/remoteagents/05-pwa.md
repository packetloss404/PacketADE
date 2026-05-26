# 05 - PWA Plan

## PWA First

Start with a PWA because it lets us validate:

- remote relay protocol
- auth and device trust
- mobile conversation UX
- approval flows
- push notifications
- reconnect behavior

Native iOS via TestFlight should come after the PWA proves the product loop. The native app can reuse protocol, reducers, and much of the React UI if built with React Native later, or it can be a Swift shell around the same remote model.

## Target URL

```text
https://remote.packetade.app
```

Relay/API:

```text
wss://relay.packetade.app/ws/device
https://relay.packetade.app/api
```

## Primary Navigation

Bottom tabs:

- **Needs Me** - approvals, failed runs, blocked conversations
- **Active** - running conversations grouped by host/workspace
- **New** - start a new agent
- **History** - completed/archived conversations
- **Hosts** - host status, devices, settings

No marketing page after sign-in. The app should open directly into work.

## Screens

### Sign In

- passkey button
- magic-link fallback
- clear note that providers and secrets remain on desktop

### Host List

Each host row:

- host name
- online/offline
- last seen
- PacketADE version
- active agent count
- approval count
- connection state

States:

- online and trusted
- online, approval needed
- offline
- revoked
- incompatible version

### New Agent

Fields:

- host
- workspace/project
- profile
- provider
- model
- mode: agent/manual/ask/plan
- prompt
- attachment picker later

Provider rows should mirror desktop groupings from `API_PROVIDERS` and show auth badges.

### Conversation

Mobile should not render a terminal wall. Use compact cards:

- user message
- assistant text
- thinking collapsed by default
- tool start/result
- permission request
- pending edit
- plan block
- token/cost summary
- done/error

Toolbar:

- cancel
- retry
- model
- approvals
- host/workspace context

Composer:

- one-line plus expanding textarea
- send
- queued indicator if turn active
- disabled/offline state

### Approval Card

Show:

- tool name
- risk class
- workspace
- summarized arguments
- raw details expandable
- approve once
- allow always for session
- deny
- cancel pending tools

For pending edits:

- file path
- added/removed line count
- risk label
- preview summary
- apply
- reject

Full per-hunk diff review is post-MVP.

### Hosts Settings

- host enable/disable remote
- trusted devices
- revoke device
- last remote commands
- notification settings

## Installability

PWA requirements:

- `manifest.webmanifest`
- service worker
- HTTPS
- app icons
- `display: standalone`
- responsive mobile layout
- offline fallback

Use MDN installability guidance as baseline.

## Push Notifications

Push categories:

- approval needed
- edit approval needed
- run finished
- run failed
- host disconnected while active run exists

iOS note:

- iOS/iPadOS web push is for installed Home Screen web apps.
- Treat push as a user wake-up. Do not rely on background socket execution.

Android note:

- Android Chrome PWA push is generally more forgiving, but still design for reconnect on open.

## Offline And Reconnect UX

PWA stores:

- auth session
- trusted device id
- host list cache
- conversation summaries
- last sequence cursor per conversation
- local prompt drafts
- outbox commands with TTL

Reconnect flow:

1. WebSocket reconnects.
2. PWA sends `resume.request` with per-conversation cursors.
3. Relay replays buffered events.
4. If replay missing, PWA asks host for `conversation.snapshot`.
5. UI marks recovered state.

Outbox rules:

- `conversation.send` may queue for short TTL if desktop offline and user confirms.
- approvals should not queue after prompt expiry.
- cancels can queue briefly but must show uncertain result if desktop offline.

## Mobile Design Constraints

- Prioritize scannable cards.
- Avoid dense desktop sidebars.
- Keep touch targets at least 44 px.
- Do not show raw logs unless expanded.
- Use destructive colors sparingly and consistently.
- Keep model/provider picker searchable.
- Keep host/workspace context always visible.

## PWA Test Matrix

Required devices/browsers:

- iPhone Safari installed to Home Screen
- iPhone Safari browser tab
- Android Chrome installed PWA
- Android Chrome browser tab
- desktop Chrome narrow viewport

Manual checks:

- install works
- login persists
- WebSocket reconnect after lock/unlock
- push opens correct conversation
- offline banner accurate
- approval card usable with one hand
- long assistant stream does not jank


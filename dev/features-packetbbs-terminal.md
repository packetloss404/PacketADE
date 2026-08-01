# PacketBBS Terminal Connection — Feature Note

Created: 2026-08-01

Status: proposed and scoped; no PacketADE implementation has started

Product boundary: PacketADE remains the local desktop development environment. PacketBBS remains an independently deployed community BBS with its own callers, authentication, database, moderation, web terminal, and raw Telnet service.

## Objective

Give PacketADE users one deliberate way to reach a configured PacketBBS node without turning either application into a dependency of the other:

```text
Configure endpoint -> Probe health -> Open web or Telnet terminal -> Authenticate inside PacketBBS
```

The first version is a saved connection preset and launcher. It does not synchronize Packet accounts, inject credentials, mirror BBS messages, or give PacketBBS access to PacketADE workspaces.

## PacketBBS contract available today

PacketBBS 1.2.1 exposes the minimum independent-service contract this feature needs:

- `GET /healthz` returns a bounded, credential-free status document with service name, version, uptime, database readiness, and online-node count.
- The web terminal occupies its full browser viewport and connects to the same BBS session engine over same-origin WebSocket.
- Raw Telnet remains available on an independent internal port and may be exposed through a Railway TCP proxy with a different public port.
- Public web URL, Telnet host, and Telnet port are deployment configuration, not values PacketADE should guess.

PacketADE must tolerate an older or unreachable node by reporting the failed probe and preserving the saved configuration. A failed health probe must not erase or rewrite the endpoint.

## Proposed user experience

### Settings

Add a PacketBBS connection card under the existing Integrations settings group:

- display label;
- HTTPS web-terminal URL;
- Telnet hostname;
- Telnet port;
- preferred launch mode: Web or Telnet;
- explicit `Test endpoint health` action;
- last bounded probe result: reachable state, PacketBBS version, and timestamp.

No username or password field belongs in this card. Authentication occurs inside PacketBBS. PacketADE must not store BBS credentials in frontend state, ordinary files, workspace DTOs, or command history.

### Launch points

After configuration, expose one `Open PacketBBS` action from the normal add-pane/command-palette flow:

- **Web mode:** open the configured HTTPS URL using the existing safe external-URL mechanism. Do not embed a remote page inside a privileged Tauri webview.
- **Telnet mode:** create a normal terminal pane and launch a detected Telnet client with structured executable/argument handling. Never assemble a shell command from hostname or port text.

If no supported Telnet client is present, show the exact `host:port`, offer Web mode, and leave installation to the user. PacketADE does not bundle PacketBBS or a background BBS daemon.

### Terminal behavior

The PacketBBS pane is an ordinary PTY-backed terminal session. Existing resize, close, restart, and workspace persistence rules stay authoritative. PacketVoice can already dictate or paste into that terminal without a new backend integration.

## Security and trust boundary

- Require HTTPS for the configured web URL outside explicit development mode.
- Validate the Telnet host as a hostname/IP literal and the port as an integer from 1–65535.
- Display a persistent warning that Telnet authentication and content are plaintext in transit.
- Pass Telnet launch arguments as a structured argv vector; reject control characters and shell metacharacter interpretation.
- Never fetch arbitrary paths from the configured origin. The health probe is fixed to `/healthz` with a short timeout and a small response limit.
- Do not import PacketBBS caller identities into PacketADE or treat a successful BBS login as PacketADE authorization.
- Do not add automatic reconnect loops; reconnection is user-initiated and bounded.

## Persistence contract

Store non-secret connection metadata under PacketADE's centralized brand/storage conventions. Suggested versioned shape:

```ts
type PacketBbsConnectionV1 = {
  schemaVersion: "packetade.packetbbs-connection/v1";
  label: string;
  webUrl: string;
  telnetHost: string;
  telnetPort: number;
  preferredMode: "web" | "telnet";
};
```

Do not persist probe output as authority. It is a cache for display only and must be refreshed on demand.

## Implementation loop

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID       | Item                                     | Acceptance condition                                                                                                                         | Gate                                                                                | Status |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| **PBI1** | Freeze settings and persistence contract | Versioned non-secret DTO, validation, migration/default behavior, and centralized brand/storage usage are documented and tested              | TypeScript/Rust round-trip tests if the setting crosses the Tauri boundary          | queued |
| **PBI2** | Bounded health probe                     | `Test endpoint health` calls only `/healthz`, enforces HTTPS outside development, caps time/body size, and preserves config on every failure | Unit tests for success, timeout, invalid JSON, oversize, HTTP error, and older node | queued |
| **PBI3** | Web launch                               | Configured web terminal opens through PacketADE's safe external-URL path with no privileged embedding                                        | Command/component tests plus manual Windows/macOS/Linux smoke                       | queued |
| **PBI4** | Telnet detection and launch              | Supported client detection and structured argv launch work for configured host/port; missing-client recovery is explicit                     | PTY argument tests including spaces, IPv4/IPv6, invalid host, and absent executable | queued |
| **PBI5** | Cross-repository proof                   | A released PacketADE build probes and opens a tagged PacketBBS release over HTTPS and its public TCP proxy                                   | Versioned smoke transcript naming both commits/tags and public endpoints            | queued |

## Acceptance bar

The feature is complete only when a user can save one PacketBBS endpoint, obtain an honest health result, open the selected terminal mode, log in inside PacketBBS, close the pane without affecting the board, restart PacketADE, and repeat the launch without credentials having been stored or echoed by PacketADE.

## Explicit non-goals

- shared Packet suite login or SSO;
- shared SQLite/Postgres tables;
- PacketBBS credentials in the OS keyring during the first version;
- message/conference mirroring with PacketChat;
- SysOp paging through PacketPhone;
- PacketAgent-triggered BBS bulletins or digests;
- embedding the remote BBS web application in a privileged Tauri surface;
- automatically installing a Telnet client.

Those service-to-service ideas require signed, versioned APIs and independent moderation/identity decisions. They must not be smuggled into a terminal connection preset.

## Recommended sequencing

Keep this feature behind the current PacketADE product decisions and release gates. When reprioritized, implement PBI1–PBI4 as one small local feature, then run PBI5 against an explicitly supplied PacketBBS deployment. Do not block PacketADE startup, ordinary terminal panes, or offline use on PacketBBS availability.

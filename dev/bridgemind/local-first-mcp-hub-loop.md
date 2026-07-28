# Local-First MCP Hub — Scoped Loop

Created: 2026-07-28
Status: approved, later; not the first PacketADE focus
Product decision: **Option B — consolidate MCP inside PacketADE**

## Objective

Turn PacketADE's already-shipped MCP client and provider capabilities into one
coherent local-first Hub. Users can discover and configure useful servers,
understand live capabilities and health, apply explicit trust profiles, inspect
provenance and audit history, and expose scoped Packet suite resources without
creating a separate hosted PacketMCP product.

Implementation begins only when this track is promoted from Later.

## Existing substrate — do not rebuild

- MCP client configuration for local and project servers.
- MCP servers owned by remote SSH targets.
- PacketADE's localhost Streamable HTTP provider with bearer/origin controls.
- Read resources/tools plus opt-in event-routed `append_handoff` and
  `escalate` writes.
- Bounded activity/audit history and provider Settings UI.
- Conversation-level enabled-server snapshots.

The historical provider/transport plans remain design records. This loop starts
above that substrate.

## Product boundary

- Local and SSH execution remain the default; secrets stay in their current
  owner/keyring and are never copied into a catalog manifest.
- The provider binds locally. No public endpoint or managed cloud MCP service
  is introduced.
- Catalog installs always show the source, command, files, permissions, and
  target before the user approves them.
- Read-only is the default. Write grants are explicit by workspace, server,
  capability, and tool family, with non-overridable denial floors.
- A running agent keeps its capability/trust snapshot. Configuration changes
  require an explicit reconnect or new session and never silently broaden it.
- Provenance follows MCP-derived context and mutations into transcript,
  coordination, review, and memory surfaces.
- PacketAgent resources arrive only through its published versioned contract;
  the Hub does not imitate its runtime.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID | Item | Acceptance condition | Gate | Depends on | Status |
|---|---|---|---|---|---|
| **MCPH1** | Hub inventory and contracts | Freeze server identity, execution owner, transport, capability snapshot, trust profile, provenance, catalog manifest, and compatibility versions while migrating current config losslessly. | DTO/schema/migration fixtures and old-state hydration | — | queued |
| **MCPH2** | Curated starter catalog | Ship a reviewable catalog with official source, supported platforms/transports, install/config steps, required secrets, capabilities, and removal instructions. Catalog entries cannot embed secrets or silently execute. | Manifest validation, platform, tamper, and unsafe-command tests | MCPH1 | queued |
| **MCPH3** | Unified lifecycle and diagnostics | Show configured/connected/degraded/failed state, capability diffs, bounded logs, latency, restart/reconnect, and exact recovery guidance for local and SSH-owned servers. | Local/SSH/crash/reload/version-skew tests | MCPH1 | queued |
| **MCPH4** | Scoped trust profiles | Configure read/write/network/root/tool grants per workspace and server, preview effective authority, enforce denial floors, and snapshot it into each agent session. | Policy matrix, downgrade, reload, and privilege-escalation tests | MCPH1, MCPH3 | queued |
| **MCPH5** | Provenance and audit | Attribute resources, prompt injections, tool results, mutations, host, server version, and trust decision through transcripts and downstream Flight/Memory/review records. | Correlation, redaction, retention, and export fixtures | MCPH1, MCPH3 | queued |
| **MCPH6** | Suite resources | Organize scoped resources/tools for Flights, Issues, coordination, current Memory Hub, PacketCode health/context, and later PacketAgent contracts without duplicating their source of truth. | Resource-schema, unavailable-product, scope, and compatibility tests | MCPH3–MCPH5; Memory MH7; PacketAgent W9 later | queued |
| **MCPH7** | MCP Hub UI | Merge the current client/provider management into one searchable Hub for catalog, servers, capabilities, trust, health, provenance, activity, and explicit session reconnect. | Component, accessibility, destructive-action, and visual QA | MCPH2–MCPH6 | queued |
| **MCPH8** | Regression, packaging, and docs | Exercise existing configs, provider reads/writes, local/SSH servers, install/removal, trust downgrade, reconnect, offline operation, and backward compatibility. | Full Vitest/Rust/build gates plus packaged local/SSH smoke | MCPH1–MCPH7 | queued |

## Sequencing

```text
MCPH1 -> MCPH2 ---------> MCPH7 -> MCPH8
     \-> MCPH3 -> MCPH4 -/
              \-> MCPH5 -> MCPH6 -/
```

## Definition of done

- MCP servers and PacketADE's provider are understandable from one surface.
- Installation and trust changes remain explicit and reviewable.
- Every MCP-derived action or context fragment carries useful provenance.
- Existing local/project/SSH configs continue to work.
- The Hub adds no hosted service, public listener, or silent authority growth.

# Syndicate — archived program

**Status: ARCHIVED 2026-08-27. Not live work. Do not resume from these files.**

Syndicate separated from the Packet\* product family on 2026-08-27 (operator
decision). The PacketBench-side integration was deleted rather than left behind
a toggle — see `68ce85ee` ("refactor: remove the Syndicate execution-target
integration") and the CHANGELOG entry for that release.

These documents are kept as **historical records only**: they describe a
device-half integration that no longer exists in this product. Nothing here
creates work for PacketBench. Per `dev/README.md`, status tokens inside
`archive/` are never live.

## What was removed from the product

The native controller commands and relay device-half
(`commands/syndicate.rs`, `syndicate_relay.rs`), the frontend
store/lib/component surface (machines settings card, remote terminal pane,
Workspace-creation target, settings toggle), the `kind: "syndicate"`
execution-target variant, the now-unused crypto/WebSocket dependencies, and the
two controller-protocol conformance fixtures shared with Syndicate's repo.

Persisted state written while the integration existed still loads: a
`syndicate` execution target degrades to `None`/local on both sides of the DTO
boundary rather than failing the state file. That tolerance is the only
Syndicate-shaped code left in the tree (`src/types/workspace.ts`,
`src-tauri/src/core/workspace.rs`).

## What is in this directory

| File | What it was |
| --- | --- |
| `syndicate-execution-target.md` | The umbrella program plan (ST0–ST8): pairing/scopes/revoke, Host Workspaces, durable panes/replay, pinned-SSH bootstrap, encrypted relay transport, isolation pass. |
| `syndicate-expiry-acceptance.md` | The 11-row day-30 grant-expiry acceptance matrix. Never run against a genuinely expired grant. |
| `controller-protocol-device-relay-half.md` | PacketBench's written contribution to Syndicate's `CONTROLLER_PROTOCOL_V1` — the device↔relay leg. Handed to Syndicate before the split. |
| `syndicate-device-refresh-proposal.md` | Client-side `device.refresh` method-shape proposal, delivered to Syndicate 2026-08-15. Theirs to adopt or drop. |
| `syndicate-proof/` | The executable proof harness built 2026-08-26 (bucketed matrices, WSL/Hyper-V runbooks, Method A sqlite helper, evidence template) plus `phase0-results-2026-08-16.md`, the one phase that actually ran. |

## Two things that are NOT dead

1. **The reference device-half implementation.** `syndicate_relay.rs` at
   commit `d87fb125` (the last commit before removal) remains the reference
   implementation of the controller relay protocol, and is explicitly cited as
   prior art for the future **Remote Agents** work, which uses the same
   PacketRelay service. See `dev/remoteagents/10-pause-record.md`.
2. **PacketRelay itself.** The relay at `D:\projects\packetrelay` is a separate,
   live service. Removing this integration did not touch it.

## Do not act on these documents

- **`syndicate-proof/method-b-request.md` must NOT be sent.** It asks Syndicate
  to add short-lifetime test grants so PacketBench could finish expiry rows
  5/5b/6b. There is no longer a PacketBench client to test, so the request is
  moot.
- The runbooks (`10-wsl-host-setup.sh`, `20-method-a.sh`, `30-vm-matrix.md`,
  `40-expiry-row-runbook.md`) exercise a removed integration. They are kept
  because the *method* — bucketing an acceptance matrix into run-now /
  cheap-local / environment-gated, and producing dated evidence — is a pattern
  worth reusing on other proof tracks, not because these particular rows should
  ever run again.
- Phase 0's one live finding (production PacketRelay `/healthz` returning 404
  because the deployed revision predates the alias) is a **Syndicate/PacketRelay**
  matter now, recorded here only so it is not lost.

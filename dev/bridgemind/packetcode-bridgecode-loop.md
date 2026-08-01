# PacketCode Integration & BridgeCode-Plus — Cross-Repo Loop

Created: 2026-07-27
Status: implementation complete through source-checkout gates; published
release, clean-machine, and PacketAgent compatibility gates remain
Product decision: **Option B — independent install channel plus explicit
executable and data-home overrides**

## Objective

Repair PacketADE's existing broken PacketCode Settings/launch path, give
PacketCode a real cross-platform install/update contract, and then verify and
harden PacketCode as the stronger terminal-native counterpart to BridgeCode.

PacketCode remains an independent Packet product. It is not bundled into the
PacketADE installer and its runtime is not replaced by PacketADE's sidecar.

## Path contract

Three paths have different meanings and must never share one ambiguous setting:

1. **Executable path** — the installed `packetcode` / `packetcode.exe` used by
   PacketADE. PATH discovery is normal; a persisted manual override supports
   development and custom installations.
2. **Data home** — the directory containing PacketCode configuration, sessions,
   jobs, worktrees, workflows, commands, themes, logs, and cost state. PacketCode
   will honor `PACKETCODE_HOME`; absent it, behavior remains `~/.packetcode`.
3. **Development repository** — an optional developer-only source checkout used
   to build/install a local binary. It is not required for normal users and is
   never treated as the data home.

PacketADE passes `PACKETCODE_HOME` only to PacketCode sessions whose selected
profile overrides the default. It does not change the OS `HOME` environment or
redirect unrelated CLI state.

## Install and detection contract

The desired flow is:

```text
Detect -> Install or Update -> Version + Doctor probe -> Configure paths -> Launch
```

- Detection order: valid manual executable override, PATH, then documented
  platform-specific install locations.
- A found binary must pass `--version`; a usable setup can additionally run the
  bounded machine-readable `doctor --json` probe.
- Missing installations show a platform-specific, reviewable install action.
- Updates are explicit and checksum/signature verified when the release channel
  supplies them; PacketADE does not silently replace binaries.
- PacketADE shows the resolved executable, version/commit, effective data home,
  doctor summary, and release channel.

## BridgeCode-plus bar

BridgeCode is an alpha workflow benchmark, not an implementation template.
PacketCode's claims count only when exercised by tests and release-like smoke
runs. The bar includes:

- subscription, API-key, and local-model provider paths;
- provider/model/reasoning changes during a session;
- durable foreground sessions and recoverable background work;
- explicit permission modes and denial floors;
- read-only and write-capable sub-agents with worktree isolation;
- workflows/commands that cover persona-like repeatable behavior;
- MCP lifecycle, policy, transport, and diagnostics;
- bounded context/cost behavior with observable usage;
- install, upgrade, doctor, migration, and release gates;
- handoff hooks for PacketADE and, where durable execution is requested,
  PacketAgent.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`.

| ID | Owner | Item | Acceptance condition | Gate | Depends on | Status |
|---|---|---|---|---|---|---|
| **PC1** | Both | Freeze integration truth | Reproduce the current broken detect/path/install/launch behavior and record exact failures, supported platforms, versions, and fixtures before changing code. | Signed-off truth matrix with commands/output | — | closed |
| **PC2** | PacketCode | Configurable data home | Every user-state path derives from one resolver honoring absolute `PACKETCODE_HOME`; unset behavior remains `~/.packetcode`. Doctor reports the effective home without exposing secrets. | Go unit/migration/permission tests on Windows/POSIX semantics | PC1 | closed |
| **PC3** | PacketCode | Machine integration probe | Stabilize `--version` and versioned `doctor --json` fields needed by PacketADE: version, commit, effective home, config/state health, provider readiness summary, and exit status. | Golden JSON/backward-compatibility tests | PC1, PC2 | closed |
| **PC4** | PacketADE | Separate Settings model | Replace the ambiguous PacketCode path handling with executable override, data-home override, optional developer-repo path, resolved version, doctor result, and release channel. Persist/migrate without affecting other CLIs. | Store/DTO/migration/component tests | PC2, PC3 | closed |
| **PC5** | PacketCode | Cross-platform release/install channel | Produce checksum-verifiable Windows, macOS, and Linux artifacts plus reviewable install/update commands. Existing source builds remain supported. | Clean-machine install, upgrade, rollback, checksum gates | PC1 | gated |
| **PC6** | PacketADE | Detect/install/update flow | Add platform-aware PacketCode install/update actions, then re-detect and run the integration probe. Failures preserve configured paths and show exact recovery instructions. | Detector/PTY/modal tests and manual platform matrix | PC3–PC5 | closed |
| **PC7** | PacketADE | Correct launch environment | PacketCode panes launch the resolved executable in the intended project with only the configured `PACKETCODE_HOME` override. Local, SSH, spaces, `.exe`/`.cmd`, restart, and invalid-path cases behave predictably. | PTY argument/env integration tests and smoke fixtures | PC4, PC6 | closed |
| **PC8** | PacketCode | BridgeCode feature-truth audit | Exercise every BridgeCode-comparable claim and PacketCode differentiator through code inspection, focused tests, and release-like smoke runs. Mark present/partial/missing/broken with evidence. | Versioned truth matrix; no README-only “shipped” claims | PC1 | closed |
| **PC9** | PacketCode | Hardening loops from audit | Convert every partial/broken high-value workflow into bounded dependency-ordered loops, then run them through provider, permissions, session, agent, MCP, TUI, and release gates. | Per-loop acceptance tests plus full Go/PTY gates | PC8 | in-progress — PCH1/PCH2/**PCH4** closed; PCH3 and PCH5 specified and queued; PCH6–PCH8 remain `external-gate` |
| **PC10** | Both | Suite handoff and end-to-end proof | PacketADE can install/detect/configure/launch PacketCode; PacketCode can receive scoped project/task context; durable continuation routes to PacketAgent rather than pretending a TUI survives closure. | Cross-repo smoke run and version-compatibility fixtures | PC7, PC9 | gated |

## Sequencing

```text
PC1 -> PC2 -> PC3 -> PC4 -> PC6 -> PC7 -> PC10
  \----------> PC5 -----/
  \-> PC8 -> PC9 -------/
```

PC8 may begin after the broken integration baseline is captured; it does not
need to wait for installer work. PC10 is the product gate, not the first time
the two repositories are tested together.

## Definition of done

- PacketADE reliably detects, installs or updates, configures, probes, and
  launches PacketCode.
- Executable, data-home, and developer-repository paths are unambiguous.
- The default PacketCode data location remains backward compatible.
- PacketCode's BridgeCode-comparable features are verified, not merely listed.
- Missing and weak workflows have completed implementation loops and regression
  tests.
- PacketCode remains independently installable and usable without PacketADE.

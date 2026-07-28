# Approved Loop Queue Before Remote Agents

Status: **prepared; waiting at the one-time execution confirmation gate**

Prepared: 2026-07-28

Release baseline: **v0.10.2**

## Purpose

This is the single run order for PacketADE product decisions made during the
BridgeMind/BridgeSpace review. It replaces repeated “which loop next?”
questions. After the user gives the one-time confirmation, execute the runnable
slices in order, keep each canonical ledger current, and continue automatically
from one completed slice to the next.

Do not start this queue merely because this file exists. The current stopping
point is the confirmation gate below.

## Execution rules

- The canonical acceptance conditions remain in each linked loop; this file
  orders them but does not weaken them.
- Close a slice only after its named tests and documentation reconciliation
  pass.
- A hardware, host, signing-credential, published-package, or sibling-product
  dependency becomes `gated` with exact evidence and pickup instructions. It
  does not make a different independent slice pass, and it does not prevent
  safe later source work.
- Preserve existing permission, Reviewer Gate, protected-branch, conflict, and
  bounded-autonomy hard stops. Loop execution is not authority to publish
  externally, change secrets, weaken security policy, or imitate PacketAgent.
- Update [`../../backlog.md`](../../backlog.md),
  [`../../ROADMAP.md`](../../ROADMAP.md), [`../README.md`](../README.md), and
  the active ledger after every completed lane.
- Run the relevant focused tests during each slice and the full frontend,
  sidecar, Rust compile, and packaged gates at convergence.

## Ordered queue

| Order | Lane | Work to run | Why it is here | Start state |
|---:|---|---|---|---|
| **0** | Release baseline | Version, validate, package, commit, tag, and push v0.10.2. | Gives every later loop a clean, recoverable baseline. | complete — `v0.10.2` |
| **1** | Implemented Flight supervision proof | Close the remaining RG8, CG9, CI9, and AP9 release-like local/SSH/manual matrices in the Reviewer Gate, cooperative graph, Coordination Inbox, and bounded YOLO ledgers. | Proves the already-implemented supervision foundation before adding more cross-cutting state. | source complete; smoke remains |
| **2** | Dictation follow-on hardening | Run DV11–DV17 in [`dictation-repair-hardening-loop.md`](./dictation-repair-hardening-loop.md), separating source-completable work from physical-device/platform gates. | Finishes the approved BridgeVoice response without reopening the repaired baseline. | baseline fixed; follow-ons queued/gated |
| **3** | Trust and Provenance | Run TP1–TP8 in [`trust-provenance-loop.md`](./trust-provenance-loop.md). | Establishes the shared origin/authority/lineage contract before Memory and MCP build on it. | queued |
| **4** | Project-local Memory Hub | Run MH1–MH9 in [`project-local-memory-hub-loop.md`](./project-local-memory-hub-loop.md). | Uses the trust contract for durable project notes, capture lineage, and scoped retrieval. | queued |
| **5** | Local-first MCP Hub | Run MCPH1–MCPH8 in [`local-first-mcp-hub-loop.md`](./local-first-mcp-hub-loop.md). | Runs after Trust and Memory because MCPH5/MCPH6 consume their provenance and Memory Hub contracts. This preserves the decision that MCP Hub is not the first focus. | approved later; queued last |
| **6** | Convergence | Run the combined migration, local/SSH, provider-parity, permission/YOLO, review, Memory, MCP, packaging, and documentation matrix. Remove shipped work from the backlog and archive completed ledgers only after evidence is recorded. | Proves the additions behave as one PacketADE system instead of overlapping features. | waits on lanes 1–5 |

## Dictation follow-on slices

The initial DV1–DV10 repair is complete. These IDs make the remaining backlog
executable without pretending that this machine currently has an active
microphone or that unavailable platforms were tested.

| ID | Item | Acceptance condition | Status |
|---|---|---|---|
| **DV11** | Microphone doctor and stable identity | A bounded three-second test reports device identity, native rate/channels/format, live level, and actionable failure; saved devices survive enumeration reordering with a documented fallback. | queued |
| **DV12** | Capture bounds and recovery | Enforce a configured maximum duration/bounded buffer, rebuild dead streams, handle disconnect, and use a safe physical-default fallback without orphaning state. | queued |
| **DV13** | Global-shortcut trust | Add an explicit enable switch, conflict/readiness test, serialized rebinding, and a safer default that does not claim `Ctrl+Shift+V` unconditionally. | queued |
| **DV14** | Native insertion coverage | Support contenteditable, editor, and PTY targets with original-target and secure-field checks; clipboard remains a visible fallback. | queued |
| **DV15** | Packaged platform prerequisites | Verify Windows microphone/paste behavior, macOS microphone/accessibility metadata, and Linux ALSA/PipeWire plus X11/Wayland fallback packaging. | environment-gated |
| **DV16** | Structured private telemetry | Return capture format, detected language, duration, model-load/inference timing, and warnings without logging transcript or dictionary contents. | queued |
| **DV17** | Engine/acceleration evidence | Benchmark Parakeet or Whisper acceleration only after packaged CPU Whisper latency/quality measurements exist; keep cloud transcription off by default. | evidence-gated |

## Cross-repository and external lanes

- **PacketCode:** its source integration is complete. PacketADE may run its
  compatibility smoke when a published PacketCode build exists, but remaining
  PacketCode implementation and signing work stays in
  `D:\projects\packetcode`; this queue does not mutate that sibling repository.
- **PacketAgent:** active in its own repository and Codex project. PacketADE
  PH1–PH10 remain blocked until PacketAgent publishes the frozen W9
  schema/runtime contract. This queue must not rebuild an always-on worker.
- **Signing and updater:** record unsigned local installers as local build
  evidence. Public trusted distribution remains gated on Windows/macOS signing
  credentials and updater configuration.

## Decisions that intentionally create no loop

- No BridgeBench / Flight Bakeoff or multi-model leaderboard.
- No BridgeShot / screenshot-OCR product.
- Production-signal monitoring is not now.
- The deleted autonomous Flight Planner v1 remains deleted.

## Confirmation boundary

**STOP HERE. Do not run lanes 1–6 until the user gives the one-time
confirmation.**

That confirmation authorizes the ordered, in-repository implementation and
verification work above without another product-choice prompt between slices.
It does not authorize external releases, secret changes, destructive cleanup,
protected-branch bypass, or work inside the PacketCode/PacketAgent repositories.
Stop only for a genuine blocking dependency or a new decision that would
materially change the approved product scope.

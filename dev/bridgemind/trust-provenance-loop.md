# Trust and Provenance Loop

Status: **TP1–TP7 source-complete; TP8 environment-gated**

Decision date: 2026-07-28

Canonical backlog: [`../../backlog.md`](../../backlog.md)

## Decision

Build trust and provenance as a cross-cutting PacketBench capability, not as a
separate app. External content must remain visibly attributable and must never
gain execution authority merely because an agent read it.

This is not a promise to detect every prompt injection. The reliable boundary
is structural: record where content came from, distinguish evidence from user
intent, preserve that distinction through agent and product records, and
require the appropriate policy decision before a risky follow-on action.

## Existing foundation to extend

- `web_fetch` already wraps fetched text in nonce-delimited
  `[UNTRUSTED WEB CONTENT]` markers and applies SSRF/redirect controls.
- API-agent conversations already correlate tool starts/results,
  permission requests, edits, and MCP source summaries by session/tool IDs.
- MCP-over-SSH records server name, transport, scope, and config-read errors.
- Conversations and Flights already retain worktree, attempt, review, and
  coordination provenance.
- Memory events already expose source links and some capture provenance.
- Permission modes and bounded Flight autonomy already provide enforcement
  points; the trust layer must integrate with them rather than create a second
  approval system.

## Contract

Every attributable content fragment or derived artifact uses one compact,
versioned provenance envelope:

- **Origin:** user, local workspace, remote workspace, web, MCP, imported file,
  memory, agent/sub-agent, or generated derivative.
- **Authority:** `user_intent`, `policy_authorized`, or `evidence_only`.
  Location is not authority: local repository text and user attachments may
  still be evidence rather than instructions.
- **Identity:** display label plus a safe locator such as file/repository,
  URL/origin, MCP server/tool, memory record, session, Flight, attempt, or
  tool-use ID. Never persist credentials or secret-bearing command strings.
- **Integrity:** content hash when practical, capture time, verified/unverified
  state, and transformations such as truncation, extraction, redaction, or
  summarization.
- **Lineage:** parent envelope IDs for summaries, memories, review packets, and
  other derived records.

Older persisted records remain valid with `unknown` provenance. Migration must
not silently label old evidence as trusted.

## Enforcement rules

1. Reading evidence is allowed within the session's existing read policy.
2. Evidence cannot grant itself more tools, approve a permission, weaken a
   trust profile, expose a secret, or change an autonomy policy.
3. After a turn consumes external/unknown evidence, a write, shell, network
   mutation, credential access, PR publish, or protected-branch action is
   evaluated at the existing permission boundary with the relevant source
   chain visible.
4. A bounded YOLO policy may pre-authorize only the action classes and targets
   it already names. Evidence never expands those bounds. Existing hard stops
   for reviewer override, conflict resolution, protected/base-branch landing,
   secrets, and external publication remain explicit.
5. Trust decisions are scoped and auditable. There is no global “trust all
   content from the internet/MCP” switch.
6. Logs and exported evidence carry useful origin and decision metadata but
   redact secrets and obey bounded retention.

## Implementation loop

| ID      | Slice                          | Acceptance condition                                                                                                                                                                                                                     | Gate                                                                                                                                                | Status |
| ------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **TP1** | Inventory and typed contract   | Map every ingestion, tool-result, persistence, and approval path; freeze a versioned Rust/TypeScript/sidecar envelope with backward-compatible `unknown` migration.                                                                      | Schema fixtures cover every origin, authority, transform, and legacy record.                                                                        | closed |
| **TP2** | Ingestion normalization        | Stamp web, MCP, local/remote file, repository, memory, attachment/import, and agent-derived content at entry without duplicating raw payloads or secrets. Keep the current nonce web envelope.                                           | Unit fixtures prove correct classification, safe locators, hashes, truncation/redaction, and no accidental authority promotion.                     | closed |
| **TP3** | Transport and persistence      | Carry envelope IDs through both in-process and sidecar `api-agent:*` paths, tool calls/results, resume/retry, and conversation persistence. Bump the sidecar protocol only if the wire shape changes.                                    | Provider-parity, reload, retry, late-event, and protocol-skew tests pass.                                                                           | closed |
| **TP4** | Quiet, inspectable UI          | Add compact source/trust chips and a lineage detail view to tool cards and relevant message evidence; extend the same component to review packets, Flight evidence, and Memory records. Avoid badge noise on ordinary conversation text. | Component/accessibility tests plus visual checks cover trusted, evidence-only, unknown, truncated, and broken-source states.                        | closed |
| **TP5** | Tainted-turn policy gate       | Track when the active turn consumed external/unknown evidence and evaluate subsequent risky calls at the existing permission/autonomy boundary. The prompt explains the action, target, source chain, and effective policy.              | Matrix tests cover read-only continuation, write/shell/network/credential/publish gates, denial, bounded YOLO, retry/resume, and hard-stop actions. | closed |
| **TP6** | Downstream lineage             | Preserve source links through summaries, “Add to memory,” Flight planning/evidence, coordination artifacts, reviewer findings, and Issue/PR handoffs without treating derivatives as new authority.                                      | Round-trip and lineage tests prove parent chains survive export/import and broken parents degrade to `unknown`.                                     | closed |
| **TP7** | Audit, redaction, and controls | Record trust-policy decisions and source-chain metadata in a bounded audit view/export; add scoped settings and clear recovery guidance for unavailable/tampered sources.                                                                | Secret canaries never appear in UI logs/exports; retention, tamper, and settings-migration tests pass.                                              | closed |
| **TP8** | Regression and packaged proof  | Exercise local/SSH, all API-agent transports, MCP local/remote, web, Memory, Flight review/coordination, YOLO, restart, and old-state migration.                                                                                         | Full frontend/Rust/sidecar gates plus packaged Windows and available macOS/Linux smoke.                                                             | gated  |

## 2026-07-28 implementation record

- The schema-v1 envelope is shared by TypeScript, Rust, and the sidecar. Tool
  results classify web/MCP/memory/agent/local/remote/unknown evidence; imported
  attachments retain hashes and type only, never the payload.
- Legacy conversations, memory records, and tools hydrate as `unknown`.
  Assistant text, memory, review packets, Flight coordination, and reviewer
  reports preserve parent IDs as evidence-only derivatives.
- Permission prompts display the effective source chain. External/unknown
  evidence forces the existing risky-action gate even when the selected
  permission/autonomy posture is otherwise broad.
- `Settings → Advanced → Trust & provenance` provides quiet source-chip
  controls plus a redacted, bounded 7/30-day audit and JSON export.
- Focused provenance/listener/tool-card suites and the combined frontend,
  sidecar, Rust compile, and unsigned Windows bundle gates pass. TP8 remains
  gated on a packaged Windows visual pass, a configured SSH host, and live
  provider credentials; macOS/Linux proof requires those hosts.

Run TP1 through TP8 in order. Each slice closes only with its named tests and
with `backlog.md`, `ROADMAP.md`, and this ledger reconciled.

## Definition of done

- A user can answer “where did this come from?” from every affected surface.
- Agent-consumed external content is visibly evidence, not invisible authority.
- Risk prompts show the relevant source chain and effective policy.
- In-process, sidecar, local, and SSH paths enforce the same contract.
- Provenance survives useful derivations without copying secrets or unlimited
  raw content.
- Existing conversations and records load safely as `unknown`.

## Explicit non-goals

- No standalone security/provenance product.
- No claim of perfect prompt-injection detection.
- No mandatory cloud service, hosted content scanner, or public telemetry.
- No blockchain/ledger dependency.
- No blanket prompt for every read or every agent action.
- No trust label that bypasses PacketBench's permission, review, or autonomy
  limits.

## 2026-08-01 proof refresh

Focused provenance envelope/policy/UI tests and the sidecar frozen-trust gates
pass. Live provider transport parity, configured SSH and remote MCP, restart,
YOLO, and current packaged visual/manual proof were unavailable and remain TP8.
See [`proof-audit-2026-08-01.md`](../proof-audit-2026-08-01.md).

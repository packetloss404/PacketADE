//! ACP's MCP posture — PacketADE's MCP trust decision, expressed on the wire.
//!
//! # Why this module exists
//!
//! ACP sessions used to start with a hardcoded `mcpServers: []`: MCP was off
//! because consent was never wired, not because anyone chose it. This module
//! makes the posture a **decision** carried in from the caller, and routes that
//! decision through the SAME trust model the Node sidecar already uses
//! (`McpTrustSnapshot`, frozen at session start, protocol v11) rather than
//! inventing a second consent dialog for a third transport.
//!
//! # ACP's three-way `mcpServers` contract
//!
//! `session/new` and `session/load` read the field three different ways
//! (packetcode `internal/acp/server.go`, `SessionConfig.MCPServersSet`):
//!
//! | wire                | meaning                                            |
//! |---------------------|----------------------------------------------------|
//! | field **omitted**   | "engine, run your own `[mcp.<name>]` fleet"        |
//! | `[]`                | "no MCP servers at all"                            |
//! | `[a, b, …]`         | "exactly these, nothing else"                      |
//!
//! [`AcpMcpPosture`] is that contract as a type, so a caller cannot express
//! "no opinion" — there is no such value on the wire, and the historical bug
//! was precisely that `[]` was being sent as if it were one.
//!
//! # How PacketADE's trust decision maps onto it
//!
//! PacketADE's existing model has two inputs, both already parameters of
//! `start_api_agent_session` and both frozen at session start:
//!
//! * `enabled_mcp_server_ids` — the per-conversation server allowlist (F9).
//! * `mcp_trust_snapshot` — the per-server frozen authority (MCPH4 / v11).
//!
//! The mapping:
//!
//! | PacketADE trust state                                   | ACP posture              |
//! |---------------------------------------------------------|--------------------------|
//! | no snapshot supplied                                     | [`AcpMcpPosture::None`]  |
//! | snapshot supplied, no server selected / granted          | [`AcpMcpPosture::None`]  |
//! | snapshot grants N stdio servers PacketADE can resolve    | [`AcpMcpPosture::Explicit`] with exactly those N |
//! | user separately consented to the ENGINE's own fleet      | [`AcpMcpPosture::InheritEngineDefaults`] |
//!
//! **`Explicit` is preferred over `InheritEngineDefaults` wherever PacketADE
//! has configs of its own.** Sending the exact list is the honest form of the
//! same consent: the user was shown these commands and approved these
//! commands, and PacketADE and packetcode cannot silently drift apart over
//! whatever happens to be in the engine's `config.toml` this week.
//! `InheritEngineDefaults` therefore is never *derived* from a trust snapshot;
//! it is only ever an explicit, separate opt-in against the separate
//! disclosure surface (`acp_list_mcp_servers` with no session id).
//!
//! # What does NOT cross the ACP boundary
//!
//! The sidecar enforces trust at **tool-call time** (`mcpToolDenial` in
//! `agent-sidecar/src/mcp-trust.ts`): per-tool allowlists, `readOnlyHint`
//! probes, workspace-root checks, and the credential / protected-publish
//! denial floors. None of that is available over ACP, because the packetcode
//! engine — not PacketADE — owns the MCP client and dispatches every tool
//! call. So only the SERVER-LEVEL half of a trust snapshot is enforceable
//! here: *may this server run at all*. The per-tool half is served instead by
//! the session's ACP permission mode (see `routing::to_acp_permission_mode`),
//! which is the engine's own gate.
//!
//! That asymmetry is also why a MISSING snapshot means [`AcpMcpPosture::None`]
//! here while the sidecar synthesizes a permissive default for it: the sidecar
//! can afford an optimistic default because it still filters every call; ACP
//! cannot filter anything, so "we were not told" has to mean "start nothing".
//!
//! # Never start a subprocess on a guess
//!
//! Every server in an [`AcpMcpPosture::Explicit`] list becomes a local child
//! process on the user's machine, spawned by the engine. A candidate that
//! cannot be shown to be both trusted AND expressible is dropped, never
//! guessed at — and if that leaves nothing, the posture is
//! [`AcpMcpPosture::None`], which is wire-identical to today's behaviour.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

use crate::commands::mcp::McpServerEntry;
use crate::core::mcp_bridge::McpTrustSnapshot;

/// One stdio MCP server PacketADE will ask the engine to run, already reduced
/// to the exact shape packetcode's `parseMCPServers` accepts.
///
/// The engine's validation is unforgiving and its failures are FATAL to the
/// whole `session/new`, so everything it checks is enforced before a value of
/// this type exists:
///
/// * transport must be `stdio` — any other `type` is `-32602`;
/// * `name` must be non-empty and unique — a duplicate is `-32602`;
/// * `command` must be an ABSOLUTE path — a bare `npx` is `-32602`;
/// * env names must be non-empty and unique — otherwise `-32602`.
///
/// And beyond parsing: a CLIENT-supplied server that fails to start is a hard
/// session-start error in packetcode's `startMCP` (an operator-configured one
/// merely degrades the session). Supplying a server we have not verified is
/// executable would therefore trade "no MCP" for "no session".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpMcpServer {
    pub name: String,
    /// Absolute path to the executable.
    pub command: String,
    pub args: Vec<String>,
    /// `BTreeMap` rather than `HashMap`: it dedupes by construction (the
    /// engine rejects a repeated variable) and it serializes in a stable
    /// order, so the wire frame is reproducible.
    pub env: BTreeMap<String, String>,
}

impl AcpMcpServer {
    fn to_wire(&self) -> Value {
        json!({
            "type": "stdio",
            "name": self.name,
            "command": self.command,
            "args": self.args,
            // ACP spec shape: an ARRAY of {name, value}, not an object.
            "env": self
                .env
                .iter()
                .map(|(name, value)| json!({ "name": name, "value": value }))
                .collect::<Vec<_>>(),
        })
    }
}

/// The `mcpServers` decision for one ACP session.
///
/// [`Default`] is [`AcpMcpPosture::None`] on purpose and must stay that way:
/// every caller that has not opted in keeps the pre-existing safe behaviour
/// (`mcpServers: []`, not one subprocess started), and adding a new call site
/// cannot accidentally turn MCP on.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum AcpMcpPosture {
    /// `mcpServers: []` — the session runs no MCP servers whatsoever.
    #[default]
    None,
    /// Omit `mcpServers` — the engine runs its own configured fleet.
    ///
    /// Legal ONLY against an engine that advertised `mcpDefaults`; every other
    /// engine answers `-32602` and the entire `session/new` fails. That guard
    /// lives in [`super::resolve_posture`] and is not bypassable.
    InheritEngineDefaults,
    /// `mcpServers: [..]` — exactly this list, nothing else.
    Explicit(Vec<AcpMcpServer>),
}

impl AcpMcpPosture {
    /// The `mcpServers` field value, or `None` to leave the field out.
    ///
    /// An empty `Explicit` list is deliberately allowed to fall through to
    /// `[]`: it is the same wire frame as [`AcpMcpPosture::None`] and means
    /// the same thing, so normalizing is unnecessary and a special case here
    /// would only be one more branch to get wrong.
    pub fn wire(&self) -> Option<Value> {
        match self {
            Self::InheritEngineDefaults => None,
            Self::None => Some(json!([])),
            Self::Explicit(servers) => {
                Some(Value::Array(servers.iter().map(AcpMcpServer::to_wire).collect()))
            }
        }
    }

    /// Whether this posture would have the engine spawn MCP subprocesses.
    pub fn starts_servers(&self) -> bool {
        match self {
            Self::None => false,
            Self::InheritEngineDefaults => true,
            Self::Explicit(servers) => !servers.is_empty(),
        }
    }

    /// Stable tag for logs and for the frontend's plan preview.
    pub fn kind(&self) -> AcpMcpPostureKind {
        match self {
            Self::None => AcpMcpPostureKind::None,
            Self::InheritEngineDefaults => AcpMcpPostureKind::InheritEngineDefaults,
            Self::Explicit(_) => AcpMcpPostureKind::Explicit,
        }
    }
}

/// [`AcpMcpPosture`] without its payload — what the UI needs to name the
/// outcome of a trust decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AcpMcpPostureKind {
    None,
    InheritEngineDefaults,
    Explicit,
}

/// Why one configured server did or did not make it into the posture.
///
/// Stable machine-readable tags, so the UI can phrase them; the `String`
/// spelling is the wire form because this list will grow.
mod reason {
    pub const TRUSTED: &str = "trusted";
    pub const DISABLED: &str = "disabled";
    pub const NO_TRUST_DECISION: &str = "noTrustDecision";
    pub const NOT_SELECTED: &str = "notSelected";
    pub const NO_SNAPSHOT: &str = "noSnapshotForServer";
    pub const TRUST_DENIED: &str = "trustDeniesServer";
    pub const UNSUPPORTED_TRANSPORT: &str = "unsupportedTransport";
    pub const UNRESOLVABLE_COMMAND: &str = "commandNotResolvable";
}

/// One configured MCP server, as the disclosure surface presents it: what it
/// is, whether this session will run it, and — when it will not — why.
///
/// `command` is the load-bearing field. It is the arbitrary local subprocess
/// the user is being asked to authorize, and it is shown RESOLVED (the
/// absolute path that would actually be spawned) whenever resolution
/// succeeded, so the disclosure names the real binary rather than a `npx` that
/// could be anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpMcpCandidate {
    pub name: String,
    /// "global" (`~/.claude/settings.json`) or "project" (`.mcp.json`).
    pub scope: String,
    /// "stdio", "http", or "sse" — as configured, before any filtering.
    pub transport: String,
    /// The resolved absolute command when `included`, otherwise the command
    /// exactly as configured (which may be empty for a non-stdio server).
    pub command: String,
    pub args: Vec<String>,
    /// Whether this server goes on the wire for this session.
    pub included: bool,
    /// One of the `reason::*` tags.
    pub reason: String,
}

/// The whole MCP decision for one prospective session, in the form a UI can
/// render before anything is spawned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpMcpPlan {
    pub posture: AcpMcpPostureKind,
    /// Every configured server PacketADE knows about, included or not.
    pub servers: Vec<AcpMcpCandidate>,
    /// Names that will actually be sent, in wire order.
    pub selected: Vec<String>,
    /// True when the caller asked to inherit the engine's fleet but the
    /// running engine never advertised `mcpDefaults`, so the request was
    /// downgraded to [`AcpMcpPostureKind::None`]. The UI should say so rather
    /// than show a consent that silently did nothing.
    pub inherit_refused: bool,
}

/// The transport a raw MCP config entry declares. Mirrors `transportOf` in
/// `agent-sidecar/src/mcp-trust.ts`: absent or unrecognized means stdio,
/// because that is what every Claude/Codex-shaped entry without a `type` is.
fn transport_of(entry: &McpServerEntry) -> &'static str {
    match entry.raw_config.get("type").and_then(Value::as_str) {
        Some("http") => "http",
        Some("sse") => "sse",
        _ => "stdio",
    }
}

/// Absolute, verified-executable form of a configured `command`, or `None`.
///
/// The engine demands an absolute path and hard-fails a client-supplied server
/// it cannot start, so this resolves the command exactly the way the OS would
/// and refuses to hand over anything it could not verify:
///
/// * already absolute — accepted if it is an executable file;
/// * contains a separator (`./bin/tool`) — resolved against the project
///   directory, which is the cwd MCP configs are written against;
/// * a bare name (`npx`) — resolved through `PATH` by [`super::path_search`],
///   which honours `PATHEXT` on Windows and the executable bit on Unix.
///
/// This is resolution, not guessing: every branch answers "which file would
/// actually run", and a failure to answer drops the server rather than sending
/// a relative command that would `-32602` the whole session.
fn resolve_command(command: &str, project_path: &str) -> Option<String> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let path = Path::new(command);
    if path.is_absolute() {
        return super::is_executable_file(path).then(|| command.to_string());
    }
    if path.components().count() > 1 {
        let joined = Path::new(project_path).join(path);
        return super::is_executable_file(&joined)
            .then(|| joined.to_string_lossy().to_string());
    }
    super::path_search(command).map(|hit| hit.to_string_lossy().to_string())
}

/// Server-level admission: the only half of a trust snapshot ACP can enforce.
///
/// Mirrors the sidecar's own gate (`applyMcpTrustSnapshot`: `allowReads`, then
/// stdio-or-`allowNetwork`) with one deliberate difference — a missing
/// snapshot set is a refusal here, not a permissive default. See the module
/// docs for why.
fn admit(
    entry: &McpServerEntry,
    selected: Option<&[String]>,
    trust: Option<&[McpTrustSnapshot]>,
) -> Result<(), &'static str> {
    if entry.disabled {
        return Err(reason::DISABLED);
    }
    // No trust input at all: the caller never made a decision, so there is no
    // consent to honour. Not a guess — a refusal.
    let Some(trust) = trust else {
        return Err(reason::NO_TRUST_DECISION);
    };
    match selected {
        None => return Err(reason::NO_TRUST_DECISION),
        Some(names) if !names.iter().any(|name| name == &entry.name) => {
            return Err(reason::NOT_SELECTED)
        }
        Some(_) => {}
    }
    let Some(snapshot) = trust
        .iter()
        .find(|snapshot| snapshot.server_name == entry.name)
    else {
        return Err(reason::NO_SNAPSHOT);
    };
    if !snapshot.allow_reads {
        return Err(reason::TRUST_DENIED);
    }
    // `allow_network` cannot rescue an http/sse server the way it does on the
    // sidecar: packetcode's ACP surface parses stdio only and answers -32602
    // for anything else, failing the entire session/new.
    if transport_of(entry) != "stdio" {
        return Err(reason::UNSUPPORTED_TRANSPORT);
    }
    Ok(())
}

/// Turns PacketADE's configured MCP servers plus a frozen trust decision into
/// the plan for one session. Pure over its inputs so every branch is testable
/// without touching `~/.claude/settings.json`.
///
/// `entries` arrives global-first then project (`read_mcp_servers`'s order), so
/// a project entry shadows a global one of the same name — the same merge rule
/// the sidecar path uses.
pub fn plan_from_entries(
    project_path: &str,
    entries: Vec<McpServerEntry>,
    selected: Option<&[String]>,
    trust: Option<&[McpTrustSnapshot]>,
) -> AcpMcpPlan {
    let mut merged: Vec<McpServerEntry> = Vec::new();
    for entry in entries {
        match merged.iter().position(|held| held.name == entry.name) {
            Some(index) => merged[index] = entry,
            None => merged.push(entry),
        }
    }

    let mut servers = Vec::with_capacity(merged.len());
    let mut wire = Vec::new();
    for entry in &merged {
        let transport = transport_of(entry).to_string();
        let configured_command = entry.config.command.clone();
        match admit(entry, selected, trust) {
            Err(why) => servers.push(AcpMcpCandidate {
                name: entry.name.clone(),
                scope: entry.scope.clone(),
                transport,
                command: configured_command,
                args: entry.config.args.clone(),
                included: false,
                reason: why.to_string(),
            }),
            Ok(()) => match resolve_command(&configured_command, project_path) {
                None => servers.push(AcpMcpCandidate {
                    name: entry.name.clone(),
                    scope: entry.scope.clone(),
                    transport,
                    command: configured_command,
                    args: entry.config.args.clone(),
                    included: false,
                    reason: reason::UNRESOLVABLE_COMMAND.to_string(),
                }),
                Some(command) => {
                    wire.push(AcpMcpServer {
                        name: entry.name.clone(),
                        command: command.clone(),
                        args: entry.config.args.clone(),
                        env: entry
                            .config
                            .env
                            .iter()
                            // The engine rejects an empty variable name and
                            // fails the session over it; drop rather than send.
                            .filter(|(name, _)| !name.trim().is_empty())
                            .map(|(name, value)| (name.clone(), value.clone()))
                            .collect(),
                    });
                    servers.push(AcpMcpCandidate {
                        name: entry.name.clone(),
                        scope: entry.scope.clone(),
                        transport,
                        command,
                        args: entry.config.args.clone(),
                        included: true,
                        reason: reason::TRUSTED.to_string(),
                    });
                }
            },
        }
    }

    let selected_names = wire.iter().map(|s| s.name.clone()).collect();
    let posture = if wire.is_empty() {
        AcpMcpPostureKind::None
    } else {
        AcpMcpPostureKind::Explicit
    };
    AcpMcpPlan {
        posture,
        servers,
        selected: selected_names,
        inherit_refused: false,
    }
}

/// The posture a plan describes, rebuilt from its own candidate list so the
/// preview a UI rendered and the frame that goes on the wire cannot diverge.
pub fn posture_from_plan(plan: &AcpMcpPlan, project_path: &str, entries: &[McpServerEntry]) -> AcpMcpPosture {
    if plan.posture != AcpMcpPostureKind::Explicit {
        return AcpMcpPosture::None;
    }
    let mut servers = Vec::new();
    for name in &plan.selected {
        let Some(entry) = entries.iter().rev().find(|entry| &entry.name == name) else {
            continue;
        };
        let Some(command) = resolve_command(&entry.config.command, project_path) else {
            continue;
        };
        servers.push(AcpMcpServer {
            name: entry.name.clone(),
            command,
            args: entry.config.args.clone(),
            env: entry
                .config
                .env
                .iter()
                .filter(|(name, _)| !name.trim().is_empty())
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        });
    }
    if servers.is_empty() {
        AcpMcpPosture::None
    } else {
        AcpMcpPosture::Explicit(servers)
    }
}

/// Reads PacketADE's own MCP configuration for `project_path` and applies the
/// session's frozen trust decision to it.
///
/// Never fails: a config that cannot be read yields an empty plan, which is
/// [`AcpMcpPosture::None`] — MCP problems must not fail a session start, and
/// "could not read the config" is not consent.
pub async fn plan_for_session(
    project_path: &str,
    selected: Option<&[String]>,
    trust: Option<&[McpTrustSnapshot]>,
) -> AcpMcpPlan {
    let entries = crate::commands::mcp::read_mcp_servers(project_path.to_string())
        .await
        .unwrap_or_default();
    plan_from_entries(project_path, entries, selected, trust)
}

/// The posture for one session, from PacketADE's config plus the frozen trust
/// decision. This is the function the api-agent start path calls.
pub async fn posture_for_session(
    project_path: &str,
    selected: Option<&[String]>,
    trust: Option<&[McpTrustSnapshot]>,
) -> AcpMcpPosture {
    let entries = crate::commands::mcp::read_mcp_servers(project_path.to_string())
        .await
        .unwrap_or_default();
    let plan = plan_from_entries(project_path, entries.clone(), selected, trust);
    posture_from_plan(&plan, project_path, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::McpServerConfig;
    use std::collections::HashMap;

    fn entry(name: &str, command: &str, scope: &str, raw: Value) -> McpServerEntry {
        let disabled = raw
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        McpServerEntry {
            name: name.to_string(),
            config: McpServerConfig {
                command: command.to_string(),
                args: vec!["--serve".to_string()],
                env: HashMap::new(),
            },
            raw_config: raw,
            scope: scope.to_string(),
            disabled,
        }
    }

    fn snapshot(name: &str, allow_reads: bool) -> McpTrustSnapshot {
        McpTrustSnapshot {
            schema_version: 1,
            server_id: format!("runtime:{name}"),
            server_name: name.to_string(),
            workspace_path: None,
            allow_reads,
            allow_writes: false,
            allow_network: true,
            allowed_roots: Vec::new(),
            allowed_tool_names: Vec::new(),
            denial_floors: Vec::new(),
            revision: 1,
            updated_at: 0,
            capability_checked_at: None,
        }
    }

    /// An executable this test process can prove exists, so `resolve_command`
    /// has something real to accept. The test binary itself always qualifies.
    fn real_executable() -> String {
        std::env::current_exe()
            .expect("test binary path")
            .to_string_lossy()
            .to_string()
    }

    fn reason_for<'a>(plan: &'a AcpMcpPlan, name: &str) -> &'a str {
        plan.servers
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.reason.as_str())
            .unwrap_or("<missing>")
    }

    #[test]
    fn the_default_posture_is_the_safe_one() {
        // The whole point of the type: a caller that does not opt in gets
        // exactly today's behaviour, an explicit empty list.
        assert_eq!(AcpMcpPosture::default(), AcpMcpPosture::None);
        assert_eq!(AcpMcpPosture::default().wire(), Some(json!([])));
        assert!(!AcpMcpPosture::default().starts_servers());
    }

    #[test]
    fn each_posture_produces_its_leg_of_the_three_way_contract() {
        // Omission is the ONLY way to ask for the engine's own fleet.
        assert_eq!(AcpMcpPosture::InheritEngineDefaults.wire(), None);
        assert_eq!(AcpMcpPosture::None.wire(), Some(json!([])));

        let explicit = AcpMcpPosture::Explicit(vec![AcpMcpServer {
            name: "github".into(),
            command: "/opt/gh-mcp".into(),
            args: vec!["serve".into()],
            env: [("TOKEN".to_string(), "t".to_string())].into_iter().collect(),
        }]);
        assert_eq!(
            explicit.wire(),
            Some(json!([{
                "type": "stdio",
                "name": "github",
                "command": "/opt/gh-mcp",
                "args": ["serve"],
                "env": [{ "name": "TOKEN", "value": "t" }],
            }]))
        );
        assert!(explicit.starts_servers());
    }

    /// The wire shape is dictated by packetcode's `parseMCPServers`, which
    /// answers -32602 (failing the WHOLE session/new) for a missing `type`, a
    /// relative command, or an object-shaped `env`. Pin all three.
    #[test]
    fn explicit_servers_match_what_the_engine_will_parse() {
        // A REAL absolute path, because "absolute" is platform-defined the
        // same way on both sides of the wire: Go's `filepath.IsAbs` refuses a
        // drive-less `/usr/local/bin/x` on Windows exactly as Rust's
        // `Path::is_absolute` does, so a hardcoded POSIX path would test a
        // different claim than the one the engine will check.
        let server = AcpMcpServer {
            name: "fs".into(),
            command: real_executable(),
            args: Vec::new(),
            env: BTreeMap::new(),
        };
        let wire = server.to_wire();
        assert_eq!(wire["type"], json!("stdio"));
        assert!(
            Path::new(wire["command"].as_str().unwrap()).is_absolute(),
            "the engine rejects a relative command"
        );
        assert!(wire["env"].is_array(), "env is an array of name/value pairs");
    }

    #[test]
    fn no_trust_decision_starts_nothing() {
        let entries = vec![entry("github", "gh-mcp", "global", json!({}))];
        // Neither half supplied — the historical caller.
        let plan = plan_from_entries("/w", entries.clone(), None, None);
        assert_eq!(plan.posture, AcpMcpPostureKind::None);
        assert!(plan.selected.is_empty());
        assert_eq!(reason_for(&plan, "github"), reason::NO_TRUST_DECISION);

        // A snapshot with no selection is still no selection.
        let trust = vec![snapshot("github", true)];
        let plan = plan_from_entries("/w", entries, None, Some(&trust));
        assert_eq!(plan.posture, AcpMcpPostureKind::None);
        assert_eq!(reason_for(&plan, "github"), reason::NO_TRUST_DECISION);
    }

    #[test]
    fn a_trusted_selected_stdio_server_becomes_an_explicit_posture() {
        let exe = real_executable();
        let entries = vec![entry("github", &exe, "global", json!({}))];
        let selected = vec!["github".to_string()];
        let trust = vec![snapshot("github", true)];

        let plan = plan_from_entries("/w", entries.clone(), Some(&selected), Some(&trust));
        assert_eq!(plan.posture, AcpMcpPostureKind::Explicit);
        assert_eq!(plan.selected, vec!["github".to_string()]);
        assert_eq!(reason_for(&plan, "github"), reason::TRUSTED);

        let posture = posture_from_plan(&plan, "/w", &entries);
        let AcpMcpPosture::Explicit(servers) = &posture else {
            panic!("expected an explicit posture, got {posture:?}");
        };
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "github");
        assert!(Path::new(&servers[0].command).is_absolute());
    }

    #[test]
    fn trust_denial_selection_and_disabled_each_drop_a_server() {
        let exe = real_executable();
        let entries = vec![
            entry("denied", &exe, "global", json!({})),
            entry("unselected", &exe, "global", json!({})),
            entry("off", &exe, "global", json!({ "disabled": true })),
            entry("unsnapshotted", &exe, "global", json!({})),
        ];
        let selected = vec![
            "denied".to_string(),
            "off".to_string(),
            "unsnapshotted".to_string(),
        ];
        let trust = vec![snapshot("denied", false), snapshot("off", true)];

        let plan = plan_from_entries("/w", entries, Some(&selected), Some(&trust));
        assert_eq!(plan.posture, AcpMcpPostureKind::None);
        assert!(plan.selected.is_empty());
        assert_eq!(reason_for(&plan, "denied"), reason::TRUST_DENIED);
        assert_eq!(reason_for(&plan, "unselected"), reason::NOT_SELECTED);
        assert_eq!(reason_for(&plan, "off"), reason::DISABLED);
        assert_eq!(reason_for(&plan, "unsnapshotted"), reason::NO_SNAPSHOT);
    }

    /// packetcode's ACP surface parses stdio only. An http/sse server must be
    /// dropped with a reason rather than sent — sending it is -32602 on the
    /// whole session/new, which loses the session, not just that server.
    #[test]
    fn non_stdio_transports_are_dropped_even_when_fully_trusted() {
        let entries = vec![entry(
            "remote",
            "",
            "project",
            json!({ "type": "sse", "url": "https://example.test/mcp" }),
        )];
        let selected = vec!["remote".to_string()];
        let mut allowed = snapshot("remote", true);
        allowed.allow_network = true;
        let plan = plan_from_entries("/w", entries, Some(&selected), Some(&[allowed]));
        assert_eq!(plan.posture, AcpMcpPostureKind::None);
        assert_eq!(reason_for(&plan, "remote"), reason::UNSUPPORTED_TRANSPORT);
        assert_eq!(plan.servers[0].transport, "sse");
    }

    /// A command that resolves to nothing is a server the engine could not
    /// start — and a client-supplied server that fails to start is a FATAL
    /// session/new error in packetcode's startMCP. Drop it here instead.
    #[test]
    fn an_unresolvable_command_is_dropped_rather_than_sent_relative() {
        let entries = vec![entry(
            "ghost",
            "packetade-definitely-not-a-real-binary",
            "global",
            json!({}),
        )];
        let selected = vec!["ghost".to_string()];
        let trust = vec![snapshot("ghost", true)];
        let plan = plan_from_entries("/w", entries, Some(&selected), Some(&trust));
        assert_eq!(plan.posture, AcpMcpPostureKind::None);
        assert_eq!(reason_for(&plan, "ghost"), reason::UNRESOLVABLE_COMMAND);
    }

    #[test]
    fn project_scope_shadows_global_on_the_same_name() {
        let exe = real_executable();
        let entries = vec![
            entry("shared", &exe, "global", json!({})),
            entry("shared", &exe, "project", json!({ "disabled": true })),
        ];
        let selected = vec!["shared".to_string()];
        let trust = vec![snapshot("shared", true)];
        let plan = plan_from_entries("/w", entries, Some(&selected), Some(&trust));
        assert_eq!(plan.servers.len(), 1, "one row per server name");
        assert_eq!(plan.servers[0].scope, "project");
        assert_eq!(plan.posture, AcpMcpPostureKind::None);
    }

    #[test]
    fn empty_env_names_never_reach_the_wire() {
        let exe = real_executable();
        let mut e = entry("github", &exe, "global", json!({}));
        e.config.env = [
            ("  ".to_string(), "orphan".to_string()),
            ("TOKEN".to_string(), "t".to_string()),
        ]
        .into_iter()
        .collect();
        let selected = vec!["github".to_string()];
        let trust = vec![snapshot("github", true)];
        let plan = plan_from_entries("/w", vec![e.clone()], Some(&selected), Some(&trust));
        let AcpMcpPosture::Explicit(servers) = posture_from_plan(&plan, "/w", &[e]) else {
            panic!("expected an explicit posture");
        };
        assert_eq!(
            servers[0].env.keys().collect::<Vec<_>>(),
            vec![&"TOKEN".to_string()],
            "the engine rejects an empty env name and fails the session over it"
        );
    }
}

//! Bridge between user-configured MCP servers and the API agent's tool list.
//!
//! Discovers tools by spawning each enabled MCP server (via `McpConnectionPool`)
//! and calling `tools/list`. Each discovered tool becomes a `ToolDefinition`
//! named with a sanitized `mcp__<server>__<tool>` prefix and a stable hash
//! suffix when needed so it conforms to provider tool-name regex
//! (`^[A-Za-z0-9_-]{1,64}$`) without losing the original server/tool mapping.
//!
//! Execution is dispatched in `tool_runtime::execute_tool` via the
//! `mcp__*` arm, which calls back into `execute_mcp_tool` here.

use crate::core::llm_types::ToolDefinition;
use crate::core::mcp_client::McpConnectionPool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tracing::warn;

const MAX_PROVIDER_TOOL_NAME_LEN: usize = 64;
const MCP_TOOL_PREFIX: &str = "mcp__";
const HASH_SUFFIX_LEN: usize = 12;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTrustSnapshot {
    pub schema_version: u8,
    pub server_id: String,
    pub server_name: String,
    pub workspace_path: Option<String>,
    pub allow_reads: bool,
    pub allow_writes: bool,
    pub allow_network: bool,
    #[serde(default)]
    pub allowed_roots: Vec<String>,
    #[serde(default)]
    pub allowed_tool_names: Vec<String>,
    #[serde(default)]
    pub denial_floors: Vec<String>,
    pub revision: u64,
    pub updated_at: u64,
    pub capability_checked_at: Option<u64>,
}

/// Word tokens that name a mutation. Matched against the tool name split into
/// words (`applyPatch` / `apply_patch` / `apply-patch` all tokenize the same),
/// so this catches names the substring pass below misses without the false
/// positives a bare `contains("put")` would produce.
///
/// Mirrors `MUTATING_TOKENS` in `agent-sidecar/src/mcp-trust.ts`. Keep the two
/// in lockstep: they are the same floor enforced on two transports.
const MUTATING_TOKENS: &[&str] = &[
    "write",
    "create",
    "update",
    "delete",
    "remove",
    "move",
    "rename",
    "post",
    "send",
    "merge",
    "push",
    "publish",
    "archive",
    "close",
    "reopen",
    "assign",
    "set",
    "execute",
    "run",
    "exec",
    "edit",
    "patch",
    "apply",
    "commit",
    "mkdir",
    "rmdir",
    "chmod",
    "chown",
    "append",
    "prepend",
    "put",
    "save",
    "store",
    "modify",
    "insert",
    "upsert",
    "drop",
    "truncate",
    "alter",
    "upload",
    "install",
    "uninstall",
    "mutate",
    "destroy",
    "purge",
    "wipe",
    "overwrite",
    "replace",
    "unlink",
    "mount",
    "unmount",
    "format",
    "kill",
    "terminate",
    "revoke",
    "grant",
    "restart",
    "reset",
];

/// Split a tool name into lowercase word tokens, breaking on non-alphanumerics
/// and on camelCase humps.
fn tool_name_tokens(name: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous_lower_or_digit = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if ch.is_ascii_uppercase() && previous_lower_or_digit && !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            current.push(ch.to_ascii_lowercase());
            previous_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
            previous_lower_or_digit = false;
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn suspected_mutation(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    // Legacy substring pass — catches glued-together names like `rewriteFile`
    // whose tokens ("rewrite") are not themselves in the token list.
    let substring_hit = [
        "write", "create", "update", "delete", "remove", "move", "rename", "post", "send", "merge",
        "push", "publish", "archive", "close", "reopen", "assign", "set", "execute", "run",
    ]
    .iter()
    .any(|needle| lowered.contains(needle));
    if substring_hit {
        return true;
    }
    let tokens = tool_name_tokens(name);
    tokens
        .iter()
        .any(|token| MUTATING_TOKENS.contains(&token.as_str()))
}

fn credential_tool(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "credential",
        "secret",
        "token",
        "password",
        "keyring",
        "private_key",
        "auth",
    ]
    .iter()
    .any(|needle| name.contains(needle))
}

fn protected_publish_tool(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "push",
        "publish",
        "merge",
        "release",
        "deploy",
        "tag",
        "pull_request",
    ]
    .iter()
    .any(|needle| name.contains(needle))
}

fn trust_for_server<'a>(
    snapshots: Option<&'a [McpTrustSnapshot]>,
    server: &str,
) -> Option<&'a McpTrustSnapshot> {
    snapshots?
        .iter()
        .find(|snapshot| snapshot.server_name == server)
}

/// F6 — read-only sessions run an ALLOWLIST, not a denylist.
///
/// `read_only_hint` is the tool's own `readOnlyHint` annotation as reported by
/// its MCP server (`None` when the caller has no listing to consult). When the
/// session is read-only a tool runs only if the server annotated it read-only
/// or the user explicitly granted it in `allowed_tool_names`; everything else,
/// including every tool we simply do not recognize, is refused. The verb floor
/// (`suspected_mutation`) then applies on top, so an obviously-mutating name
/// stays blocked even if it somehow reached the allowlist.
fn trust_allows_advertisement(
    snapshots: Option<&[McpTrustSnapshot]>,
    server: &str,
    tool: &str,
    read_only_hint: Option<bool>,
) -> bool {
    let Some(snapshot) = trust_for_server(snapshots, server) else {
        // No trust field is a legacy session. Treat it as read-only with no
        // user grants: only a server-annotated read-only tool that also clears
        // the floors may run.
        return read_only_hint == Some(true)
            && !suspected_mutation(tool)
            && !credential_tool(tool)
            && !protected_publish_tool(tool);
    };
    if !snapshot.allow_reads {
        return false;
    }
    if snapshot.capability_checked_at.is_some()
        && !snapshot
            .allowed_tool_names
            .iter()
            .any(|allowed| allowed == tool)
    {
        return false;
    }
    if snapshot
        .denial_floors
        .iter()
        .any(|floor| floor == "credentials")
        && credential_tool(tool)
    {
        return false;
    }
    if snapshot
        .denial_floors
        .iter()
        .any(|floor| floor == "protected_publish")
        && protected_publish_tool(tool)
    {
        return false;
    }
    if snapshot.allow_writes {
        return true;
    }
    if suspected_mutation(tool) {
        return false;
    }
    read_only_hint == Some(true)
        || snapshot
            .allowed_tool_names
            .iter()
            .any(|allowed| allowed == tool)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn path_inside_root(candidate: &str, root: &str) -> bool {
    let root = normalize_lexical(Path::new(root));
    let candidate_path = Path::new(candidate);
    let candidate = if candidate_path.is_absolute() {
        normalize_lexical(candidate_path)
    } else {
        normalize_lexical(&root.join(candidate_path))
    };
    candidate.starts_with(root)
}

fn path_arguments(value: &Value, key: &str, output: &mut Vec<String>) {
    match value {
        Value::String(value)
            if [
                "path",
                "file",
                "folder",
                "directory",
                "dir",
                "root",
                "cwd",
                "workspace",
            ]
            .iter()
            .any(|needle| key.to_ascii_lowercase().contains(needle)) =>
        {
            output.push(value.clone());
        }
        Value::Array(values) => {
            for value in values {
                path_arguments(value, key, output);
            }
        }
        Value::Object(values) => {
            for (child_key, value) in values {
                path_arguments(value, child_key, output);
            }
        }
        _ => {}
    }
}

fn enforce_tool_trust(
    snapshots: Option<&[McpTrustSnapshot]>,
    server: &str,
    tool: &str,
    args: &Value,
    read_only_hint: Option<bool>,
) -> Result<(), String> {
    if !trust_allows_advertisement(snapshots, server, tool, read_only_hint) {
        return Err(format!(
            "MCP tool '{server}/{tool}' is outside this session's frozen read-only authority. \
             Allow the tool or enable writes for '{server}' in Settings → MCP Hub."
        ));
    }
    let Some(snapshot) = trust_for_server(snapshots, server) else {
        return Ok(());
    };
    if snapshot
        .denial_floors
        .iter()
        .any(|floor| floor == "outside_workspace")
    {
        let mut paths = Vec::new();
        path_arguments(args, "", &mut paths);
        if paths.iter().any(|candidate| {
            snapshot.allowed_roots.is_empty()
                || !snapshot
                    .allowed_roots
                    .iter()
                    .any(|root| path_inside_root(candidate, root))
        }) {
            return Err(
                "MCP path access outside the frozen workspace roots is blocked".to_string(),
            );
        }
    }
    Ok(())
}

/// Resolve the user's home directory in a cross-platform way.
fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Path to the global Claude/PacketADE settings file that holds `mcpServers`.
fn global_settings_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("settings.json")
}

fn read_json_file(path: &PathBuf) -> Value {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(Value::Object(Default::default())),
        Err(_) => Value::Object(Default::default()),
    }
}

fn server_allowed(name: &str, filter: Option<&[String]>) -> bool {
    filter
        .map(|allowed| allowed.iter().any(|candidate| candidate == name))
        .unwrap_or(true)
}

/// Read the user's global MCP server config and return enabled server names.
fn discover_enabled_servers(filter: Option<&[String]>) -> Vec<String> {
    let json = read_json_file(&global_settings_path());
    let servers = match json.get("mcpServers") {
        Some(Value::Object(map)) => map,
        _ => return Vec::new(),
    };

    servers
        .iter()
        .filter_map(|(name, val)| {
            let disabled = val
                .get("disabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if disabled {
                return None;
            }
            if !server_allowed(name, filter) {
                return None;
            }
            Some(name.clone())
        })
        .collect()
}

/// Sanitize a name into a tool-name-safe slug.
/// Provider tool name regex is roughly `^[a-zA-Z0-9_-]{1,64}$`.
fn sanitize(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out.push('_');
    }
    out
}

fn stable_name_hash(server: &str, tool: &str) -> String {
    // FNV-1a 64-bit: tiny, deterministic, and plenty for provider-name suffixes.
    let mut hash = 0xcbf29ce484222325_u64;
    for b in server
        .as_bytes()
        .iter()
        .chain([0xff_u8].iter())
        .chain(tool.as_bytes().iter())
    {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

fn truncate_ascii(s: &str, max_len: usize) -> &str {
    &s[..s.len().min(max_len)]
}

/// Build the canonical agent-facing tool name for a (server, tool) pair.
fn make_tool_name(server: &str, tool: &str) -> String {
    let server_slug = sanitize(server);
    let tool_slug = sanitize(tool);
    let simple = format!("{MCP_TOOL_PREFIX}{server_slug}__{tool_slug}");
    if simple.len() <= MAX_PROVIDER_TOOL_NAME_LEN && server_slug == server && tool_slug == tool {
        return simple;
    }

    let hash = &stable_name_hash(server, tool)[..HASH_SUFFIX_LEN];
    let fixed_len = MCP_TOOL_PREFIX.len() + "__".len() + "_".len() + HASH_SUFFIX_LEN;
    let budget = MAX_PROVIDER_TOOL_NAME_LEN.saturating_sub(fixed_len);
    let mut server_budget = server_slug.len().min(budget / 2);
    let mut tool_budget = tool_slug.len().min(budget - server_budget);

    let unused_tool_budget = budget - server_budget - tool_budget;
    if unused_tool_budget > 0 && server_budget < server_slug.len() {
        let extra = (server_slug.len() - server_budget).min(unused_tool_budget);
        server_budget += extra;
    }

    let unused_server_budget = budget - server_budget - tool_budget;
    if unused_server_budget > 0 && tool_budget < tool_slug.len() {
        let extra = (tool_slug.len() - tool_budget).min(unused_server_budget);
        tool_budget += extra;
    }

    format!(
        "{MCP_TOOL_PREFIX}{}__{}_{}",
        truncate_ascii(&server_slug, server_budget),
        truncate_ascii(&tool_slug, tool_budget),
        hash
    )
}

/// Load tool definitions for every enabled MCP server by actually spawning
/// each server and calling `tools/list`. Servers that fail to start or
/// respond are logged and skipped — they do not block the agent from
/// starting.
pub async fn load_mcp_tool_definitions(
    enabled_server_ids: Option<&[String]>,
) -> Vec<ToolDefinition> {
    load_mcp_tool_definitions_with_trust(enabled_server_ids, None).await
}

pub async fn load_mcp_tool_definitions_with_trust(
    enabled_server_ids: Option<&[String]>,
    trust_snapshots: Option<&[McpTrustSnapshot]>,
) -> Vec<ToolDefinition> {
    let server_names = discover_enabled_servers(enabled_server_ids);
    let mut defs: Vec<ToolDefinition> = Vec::new();
    let mut advertised_names: HashMap<String, (String, String)> = HashMap::new();

    for server in server_names {
        match McpConnectionPool::list_tools_for_server(&server).await {
            Ok(tools) => {
                for t in tools {
                    if !trust_allows_advertisement(
                        trust_snapshots,
                        &server,
                        &t.name,
                        Some(t.is_read_only()),
                    ) {
                        continue;
                    }
                    let advertised_name = make_tool_name(&server, &t.name);
                    if let Some((other_server, other_tool)) = advertised_names.get(&advertised_name)
                    {
                        warn!(
                            server = %server,
                            tool = %t.name,
                            other_server = %other_server,
                            other_tool = %other_tool,
                            advertised_name = %advertised_name,
                            "Skipping MCP tool with colliding advertised name"
                        );
                        continue;
                    }
                    advertised_names
                        .insert(advertised_name.clone(), (server.clone(), t.name.clone()));
                    let description = if t.description.is_empty() {
                        format!("MCP tool '{}' on server '{}'.", t.name, server)
                    } else {
                        t.description.clone()
                    };
                    let parameters = if t.input_schema.is_null() {
                        serde_json::json!({
                            "type": "object",
                            "properties": {},
                            "required": []
                        })
                    } else {
                        t.input_schema.clone()
                    };
                    defs.push(ToolDefinition {
                        name: advertised_name,
                        description,
                        parameters,
                    });
                }
            }
            Err(e) => {
                warn!(server = %server, "Failed to list MCP tools: {}", e);
            }
        }
    }

    defs
}

/// Resolve an agent-facing MCP tool name back into the original server/tool
/// pair. This compares against generated advertisements instead of reversing
/// slugs, so long names and sanitized names round-trip correctly.
/// Returns `(server, tool, read_only_hint)`. The hint comes from the live
/// `tools/list` response, so execution-time trust decisions consult the same
/// annotation the advertisement pass did rather than re-guessing from the name.
async fn resolve_mcp_name(
    name: &str,
    enabled_server_ids: Option<&[String]>,
) -> Result<(String, String, bool), String> {
    if !name.starts_with(MCP_TOOL_PREFIX) {
        return Err(format!("Tool name '{}' does not start with 'mcp__'", name));
    }

    let mut matches = Vec::new();
    for server in discover_enabled_servers(enabled_server_ids) {
        let tools = McpConnectionPool::list_tools_for_server(&server).await?;
        for tool in tools {
            if make_tool_name(&server, &tool.name) == name {
                let read_only = tool.is_read_only();
                matches.push((server.clone(), tool.name, read_only));
            }
        }
    }

    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!(
            "No enabled MCP tool matches advertised name '{}'",
            name
        )),
        _ => Err(format!(
            "MCP tool name '{}' is ambiguous across enabled servers",
            name
        )),
    }
}

/// Executor for any tool whose name starts with `mcp__`.
pub async fn execute_mcp_tool(
    name: &str,
    args: &serde_json::Value,
    enabled_server_ids: Option<&[String]>,
) -> Result<String, String> {
    execute_mcp_tool_with_trust(name, args, enabled_server_ids, None).await
}

pub async fn execute_mcp_tool_with_trust(
    name: &str,
    args: &serde_json::Value,
    enabled_server_ids: Option<&[String]>,
    trust_snapshots: Option<&[McpTrustSnapshot]>,
) -> Result<String, String> {
    let (server, tool, read_only) = resolve_mcp_name(name, enabled_server_ids).await?;
    enforce_tool_trust(trust_snapshots, &server, &tool, args, Some(read_only))?;
    McpConnectionPool::call_tool_on_server(&server, &tool, args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_mcp_tool_names_fit_provider_limit_and_keep_hash() {
        let name = make_tool_name(
            "very-long-server-name-that-would-overflow-provider-tool-name-limits",
            "very-long-tool-name-that-also-would-overflow-provider-tool-name-limits",
        );
        assert!(name.len() <= MAX_PROVIDER_TOOL_NAME_LEN);
        assert!(name.starts_with("mcp__"));
        assert_eq!(name.rsplit('_').next().unwrap().len(), HASH_SUFFIX_LEN);
    }

    #[test]
    fn sanitized_names_get_hash_suffix_to_avoid_collisions() {
        let dotted = make_tool_name("server.name", "tool.name");
        let underscored = make_tool_name("server_name", "tool_name");
        assert_ne!(dotted, underscored);
        assert!(dotted.len() <= MAX_PROVIDER_TOOL_NAME_LEN);
    }

    #[test]
    fn simple_names_stay_readable() {
        assert_eq!(make_tool_name("github", "search"), "mcp__github__search");
    }

    fn snapshot() -> McpTrustSnapshot {
        McpTrustSnapshot {
            schema_version: 1,
            server_id: "global:test".to_string(),
            server_name: "test".to_string(),
            workspace_path: Some("/workspace".to_string()),
            allow_reads: true,
            allow_writes: false,
            allow_network: true,
            allowed_roots: vec!["/workspace".to_string()],
            allowed_tool_names: vec!["read_file".to_string(), "write_file".to_string()],
            denial_floors: vec![
                "credentials".to_string(),
                "outside_workspace".to_string(),
                "protected_publish".to_string(),
            ],
            revision: 1,
            updated_at: 1,
            capability_checked_at: Some(1),
        }
    }

    #[test]
    fn trust_snapshot_filters_mutations_and_denial_floors() {
        let snapshot = snapshot();
        assert!(trust_allows_advertisement(
            Some(std::slice::from_ref(&snapshot)),
            "test",
            "read_file",
            Some(true)
        ));
        assert!(!trust_allows_advertisement(
            Some(std::slice::from_ref(&snapshot)),
            "test",
            "write_file",
            Some(false)
        ));
        assert!(!trust_allows_advertisement(
            Some(std::slice::from_ref(&snapshot)),
            "test",
            "read_credentials",
            Some(true)
        ));
    }

    #[test]
    fn trust_snapshot_rejects_paths_outside_workspace() {
        let snapshot = snapshot();
        let snapshots = [snapshot];
        assert!(enforce_tool_trust(
            Some(&snapshots),
            "test",
            "read_file",
            &serde_json::json!({ "path": "src/main.rs" }),
            Some(true),
        )
        .is_ok());
        assert!(enforce_tool_trust(
            Some(&snapshots),
            "test",
            "read_file",
            &serde_json::json!({ "path": "../secret.txt" }),
            Some(true),
        )
        .is_err());
    }

    /// F6 — the exact names the 2026-08-05 review drove through the old
    /// 19-word substring denylist and out the other side as "non-mutating".
    /// Every one of them executed in a session the user had set read-only.
    const READ_ONLY_BYPASS_NAMES: &[&str] = &[
        "edit_file",
        "apply_patch",
        "commit",
        "mkdir",
        "chmod",
        "exec",
        "git_commit",
        "append_to_file",
        "put_object",
        "save",
        "store",
        "modify",
        "insert_row",
        "drop_table",
    ];

    #[test]
    fn read_only_session_denies_every_known_bypass_name() {
        let snapshot = snapshot();
        assert!(!snapshot.allow_writes);
        let snapshots = [snapshot];
        for name in READ_ONLY_BYPASS_NAMES {
            // Hostile case: the server claims the tool is read-only AND the
            // user's allowlist contains it. The verb floor still refuses.
            let mut permissive = snapshots[0].clone();
            permissive.allowed_tool_names.push((*name).to_string());
            assert!(
                !trust_allows_advertisement(
                    Some(std::slice::from_ref(&permissive)),
                    "test",
                    name,
                    Some(true)
                ),
                "read-only session advertised mutating tool '{name}'"
            );
            assert!(
                enforce_tool_trust(
                    std::slice::from_ref(&permissive).into(),
                    "test",
                    name,
                    &serde_json::json!({}),
                    Some(true),
                )
                .is_err(),
                "read-only session executed mutating tool '{name}'"
            );
        }
    }

    #[test]
    fn read_only_session_denies_unannotated_tools_it_was_never_granted() {
        // Neither obviously mutating nor known read-only: the old code let it
        // through because no denylist word matched. Unknown must fail closed.
        let mut snapshot = snapshot();
        snapshot.capability_checked_at = None;
        snapshot.allowed_tool_names = vec!["read_file".to_string()];
        let snapshots = [snapshot];
        assert!(!trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "query_ledger",
            None
        ));
        assert!(!trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "query_ledger",
            Some(false)
        ));
        // The two ways a tool earns its place: the server's annotation…
        assert!(trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "query_ledger",
            Some(true)
        ));
        // …or the user's explicit grant.
        assert!(trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "read_file",
            None
        ));
    }

    #[test]
    fn write_enabled_session_still_runs_mutating_tools() {
        // The allowlist inversion is scoped to read-only sessions. A user who
        // granted writes must not lose their write tools.
        let mut snapshot = snapshot();
        snapshot.allow_writes = true;
        snapshot.capability_checked_at = None;
        let snapshots = [snapshot];
        assert!(trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "write_file",
            Some(false)
        ));
        // Denial floors are not overridable by allow_writes.
        assert!(!trust_allows_advertisement(
            Some(&snapshots),
            "test",
            "push_release",
            Some(false)
        ));
    }

    #[test]
    fn legacy_sessions_without_a_snapshot_are_read_only_too() {
        // No trust field at all (a pre-v11 persisted session). Only a
        // server-annotated read-only tool may run.
        assert!(trust_allows_advertisement(
            None,
            "test",
            "read_file",
            Some(true)
        ));
        assert!(!trust_allows_advertisement(None, "test", "read_file", None));
        for name in READ_ONLY_BYPASS_NAMES {
            assert!(
                !trust_allows_advertisement(None, "test", name, Some(true)),
                "legacy session advertised mutating tool '{name}'"
            );
        }
    }

    #[test]
    fn tokenizer_splits_camel_case_and_separators() {
        assert_eq!(tool_name_tokens("applyPatch"), vec!["apply", "patch"]);
        assert_eq!(tool_name_tokens("apply_patch"), vec!["apply", "patch"]);
        assert_eq!(tool_name_tokens("apply-patch"), vec!["apply", "patch"]);
        assert!(suspected_mutation("applyPatch"));
        assert!(suspected_mutation("insertRow"));
        // `put` as a whole word is a mutation; `output` as a substring is not.
        assert!(suspected_mutation("put_object"));
        assert!(!suspected_mutation("get_output"));
    }
}

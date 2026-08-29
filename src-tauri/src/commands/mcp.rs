use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tracing::warn;

#[derive(Clone, Serialize)]
pub struct McpServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Clone, Serialize)]
pub struct McpServerEntry {
    pub name: String,
    pub config: McpServerConfig,
    #[serde(rename = "rawConfig")]
    pub raw_config: Value,
    pub scope: String, // "global" or "project"
    pub disabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiagnosticTool {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDiagnostic {
    pub state: String,
    pub transport: String,
    pub latency_ms: Option<u64>,
    pub tools: Vec<McpDiagnosticTool>,
    pub message: String,
    pub compatibility_version: String,
    pub checked_at: u64,
}

fn global_settings_path() -> PathBuf {
    let home = dirs_next().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("settings.json")
}

fn dirs_next() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

fn project_mcp_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".mcp.json")
}

fn empty_json_object() -> Value {
    Value::Object(Default::default())
}

fn read_json_file(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                // List/read remains best-effort, but mutation paths use the
                // strict parser below so malformed config is never overwritten.
                warn!(path = %path.display(), error = %e, "MCP config JSON parse failed; using empty config");
                empty_json_object()
            }
        },
        Err(_) => empty_json_object(),
    }
}

fn read_json_file_for_write(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse MCP config {}: {}", path.display(), e)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(empty_json_object()),
        Err(e) => Err(format!(
            "Failed to read MCP config {}: {}",
            path.display(),
            e
        )),
    }
}

fn mcp_servers_object(json: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let root = json
        .as_object_mut()
        .ok_or_else(|| "MCP config root must be a JSON object".to_string())?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(empty_json_object);
    servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())
}

fn upsert_mcp_server(
    servers: &mut Map<String, Value>,
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
) {
    let mut server = match servers.remove(&name) {
        Some(Value::Object(existing)) => existing,
        _ => Map::new(),
    };

    server.insert("command".to_string(), Value::String(command));
    server.insert(
        "args".to_string(),
        Value::Array(args.into_iter().map(Value::String).collect()),
    );
    server.insert("env".to_string(), serde_json::json!(env));

    servers.insert(name, Value::Object(server));
}

fn write_pretty_json(path: &Path, json: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let pretty = serde_json::to_string_pretty(json).map_err(|e| e.to_string())?;

    // F21: write atomically (temp file + fsync + atomic rename) so a crash,
    // disk-full, or partial write can't clobber/truncate the existing MCP
    // config. Mirrors `core::storage::write_with_backup`; `std::fs::rename`
    // replaces an existing destination on all platforms (Windows uses
    // MOVEFILE_REPLACE_EXISTING), so we must NOT pre-remove `path`.
    let tmp_path = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("json")
    ));
    {
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create {:?}: {}", tmp_path, e))?;
        file.write_all(pretty.as_bytes())
            .map_err(|e| format!("Failed to write {:?}: {}", tmp_path, e))?;
        file.flush()
            .map_err(|e| format!("Failed to flush {:?}: {}", tmp_path, e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync {:?}: {}", tmp_path, e))?;
    }
    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to replace {:?}: {}", path, e)
    })
}

fn extract_servers(json: &Value, scope: &str) -> Vec<McpServerEntry> {
    // Both scopes share the same key name; kept as a constant to make a future
    // per-scope key swap a single-line change.
    let servers_key = "mcpServers";
    let servers = match json.get(servers_key) {
        Some(Value::Object(map)) => map,
        _ => return Vec::new(),
    };

    servers
        .iter()
        .map(|(name, val)| {
            let command = val
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = val
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let env = val
                .get("env")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            let disabled = val
                .get("disabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            McpServerEntry {
                name: name.clone(),
                config: McpServerConfig { command, args, env },
                raw_config: val.clone(),
                scope: scope.to_string(),
                disabled,
            }
        })
        .collect()
}

fn config_for_scope(project_path: &str, scope: &str) -> Value {
    if scope == "global" {
        read_json_file(&global_settings_path())
    } else {
        read_json_file(&project_mcp_path(project_path))
    }
}

#[tauri::command]
pub async fn diagnose_mcp_server(
    project_path: String,
    name: String,
    scope: String,
) -> Result<McpServerDiagnostic, String> {
    if scope != "global" && scope != "project" {
        return Err("MCP scope must be global or project".to_string());
    }
    if scope == "project" {
        super::validate_project_path(&project_path)?;
    }
    let config = config_for_scope(&project_path, &scope);
    let entry = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(&name))
        .ok_or_else(|| "MCP server is not configured in the selected scope".to_string())?;
    let transport = entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .to_string();
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    // FAULT this fixes: every non-stdio server used to be reported as
    // `degraded` without a single byte being sent to it. `degraded` reads as
    // "we checked and it is unhealthy", so a perfectly healthy remote server
    // was shown as a problem — which teaches users that the indicator means
    // nothing and to ignore a real `degraded` when it appears.
    //
    // The doctor is a LOCAL stdio prober (`McpClient` is `Child` + stdin +
    // stdout by construction) and there is no HTTP MCP client in this build to
    // probe with. So report the truth — not probed — instead of inventing a
    // verdict. `notProbed` is a distinct state precisely so it cannot be
    // confused with a measured failure.
    if transport == "http" || transport == "sse" {
        return Ok(McpServerDiagnostic {
            state: "notProbed".to_string(),
            transport,
            // No latency: nothing was timed, and a number here would imply
            // something was.
            latency_ms: None,
            tools: Vec::new(),
            message: "Not probed — the local doctor speaks stdio only, so this server's health is unknown rather than bad."
                .to_string(),
            compatibility_version: "2024-11-05".to_string(),
            checked_at,
        });
    }
    // An unrecognised `type` is a malformed config, not a remote server. It
    // used to be swept into the same "remote, not probed" answer, which sent
    // the user looking for a network problem instead of a typo.
    if transport != "stdio" {
        return Ok(McpServerDiagnostic {
            state: "failed".to_string(),
            transport: transport.clone(),
            latency_ms: None,
            tools: Vec::new(),
            message: format!(
                "Unknown transport type {transport:?}. Expected \"stdio\", \"http\", or \"sse\"."
            ),
            compatibility_version: "2024-11-05".to_string(),
            checked_at,
        });
    }
    let command = entry
        .get("command")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "MCP stdio server is missing a command".to_string())?;
    let args = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let env = entry
        .get("env")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();
    let started = Instant::now();
    match crate::core::mcp_client::McpClient::spawn(&name, command, &args, &env).await {
        Ok(mut client) => {
            let result = client.list_tools().await;
            client.shutdown().await;
            match result {
                Ok(tools) => Ok(McpServerDiagnostic {
                    state: "connected".to_string(),
                    transport,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    tools: tools
                        .into_iter()
                        .map(|tool| McpDiagnosticTool {
                            name: tool.name,
                            description: tool.description,
                        })
                        .collect(),
                    message: "Handshake and tools/list succeeded.".to_string(),
                    compatibility_version: "2024-11-05".to_string(),
                    checked_at,
                }),
                Err(error) => Ok(McpServerDiagnostic {
                    state: "degraded".to_string(),
                    transport,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    tools: Vec::new(),
                    message: error.to_string(),
                    compatibility_version: "2024-11-05".to_string(),
                    checked_at,
                }),
            }
        }
        Err(error) => Ok(McpServerDiagnostic {
            state: "failed".to_string(),
            transport,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            tools: Vec::new(),
            message: error.to_string(),
            compatibility_version: "2024-11-05".to_string(),
            checked_at,
        }),
    }
}

#[tauri::command]
pub async fn read_mcp_servers(project_path: String) -> Result<Vec<McpServerEntry>, String> {
    let mut entries = Vec::new();

    // Global servers from ~/.claude/settings.json
    let global_path = global_settings_path();
    let global_json = read_json_file(&global_path);
    entries.extend(extract_servers(&global_json, "global"));

    // Project servers from .mcp.json
    let proj_path = project_mcp_path(&project_path);
    let proj_json = read_json_file(&proj_path);
    entries.extend(extract_servers(&proj_json, "project"));

    Ok(entries)
}

#[tauri::command]
pub async fn write_mcp_server(
    project_path: String,
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
    scope: String,
) -> Result<(), String> {
    let file_path = if scope == "global" {
        global_settings_path()
    } else {
        project_mcp_path(&project_path)
    };

    let mut json = read_json_file_for_write(&file_path)?;
    let servers = mcp_servers_object(&mut json)?;
    upsert_mcp_server(servers, name, command, args, env);
    write_pretty_json(&file_path, &json)?;

    Ok(())
}

#[tauri::command]
pub async fn delete_mcp_server(
    project_path: String,
    name: String,
    scope: String,
) -> Result<(), String> {
    let file_path = if scope == "global" {
        global_settings_path()
    } else {
        project_mcp_path(&project_path)
    };

    let mut json = read_json_file_for_write(&file_path)?;

    if let Some(servers) = json
        .as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|v| v.as_object_mut())
    {
        servers.remove(&name);
    }

    write_pretty_json(&file_path, &json)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project_dir(test_name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "packetbench-mcp-{}-{}-{}",
            test_name,
            std::process::id(),
            suffix
        ));
        fs::create_dir_all(&dir).expect("create temp project dir");
        dir
    }

    #[tokio::test]
    async fn write_mcp_server_returns_err_and_preserves_malformed_project_file() {
        let project_dir = temp_project_dir("parse-failure");
        let mcp_path = project_dir.join(".mcp.json");
        let malformed = r#"{"mcpServers":{"broken":"#;
        fs::write(&mcp_path, malformed).expect("write malformed json");

        let result = write_mcp_server(
            project_dir.to_string_lossy().into_owned(),
            "server".to_string(),
            "node".to_string(),
            vec!["server.js".to_string()],
            HashMap::new(),
            "project".to_string(),
        )
        .await;

        assert!(result
            .expect_err("malformed JSON must reject writes")
            .contains("Failed to parse MCP config"),);
        assert_eq!(
            fs::read_to_string(&mcp_path).expect("read mcp file"),
            malformed
        );

        let _ = fs::remove_dir_all(project_dir);
    }

    #[tokio::test]
    async fn delete_mcp_server_returns_err_and_preserves_malformed_project_file() {
        let project_dir = temp_project_dir("delete-parse-failure");
        let mcp_path = project_dir.join(".mcp.json");
        let malformed = r#"{"mcpServers":{"broken":"#;
        fs::write(&mcp_path, malformed).expect("write malformed json");

        let result = delete_mcp_server(
            project_dir.to_string_lossy().into_owned(),
            "server".to_string(),
            "project".to_string(),
        )
        .await;

        assert!(result
            .expect_err("malformed JSON must reject deletes")
            .contains("Failed to parse MCP config"),);
        assert_eq!(
            fs::read_to_string(&mcp_path).expect("read mcp file"),
            malformed
        );

        let _ = fs::remove_dir_all(project_dir);
    }

    #[tokio::test]
    async fn write_mcp_server_preserves_existing_server_fields() {
        let project_dir = temp_project_dir("round-trip");
        let mcp_path = project_dir.join(".mcp.json");
        fs::write(
            &mcp_path,
            serde_json::to_string_pretty(&json!({
                "uiSetting": "keep",
                "mcpServers": {
                    "remote": {
                        "type": "sse",
                        "url": "https://example.com/mcp",
                        "headers": {
                            "Authorization": "Bearer token"
                        },
                        "disabled": true,
                        "customField": {
                            "nested": true
                        },
                        "command": "old-command",
                        "args": ["old"],
                        "env": {
                            "OLD": "1"
                        }
                    },
                    "untouched": {
                        "command": "keep-command"
                    }
                }
            }))
            .expect("serialize fixture"),
        )
        .expect("write fixture");

        let mut env = HashMap::new();
        env.insert("NEW".to_string(), "2".to_string());

        write_mcp_server(
            project_dir.to_string_lossy().into_owned(),
            "remote".to_string(),
            "new-command".to_string(),
            vec!["--flag".to_string()],
            env,
            "project".to_string(),
        )
        .await
        .expect("write server");

        let saved: Value =
            serde_json::from_str(&fs::read_to_string(&mcp_path).expect("read saved mcp config"))
                .expect("parse saved mcp config");
        let remote = saved
            .get("mcpServers")
            .and_then(|servers| servers.get("remote"))
            .expect("remote server");

        assert_eq!(saved["uiSetting"], "keep");
        assert_eq!(remote["type"], "sse");
        assert_eq!(remote["url"], "https://example.com/mcp");
        assert_eq!(remote["headers"]["Authorization"], "Bearer token");
        assert_eq!(remote["disabled"], true);
        assert_eq!(remote["customField"]["nested"], true);
        assert_eq!(remote["command"], "new-command");
        assert_eq!(remote["args"], json!(["--flag"]));
        assert_eq!(remote["env"], json!({ "NEW": "2" }));
        assert_eq!(saved["mcpServers"]["untouched"]["command"], "keep-command");

        let _ = fs::remove_dir_all(project_dir);
    }

    /// Write a project-scope `.mcp.json` holding one server entry named
    /// `probe-me`, and return the project dir.
    fn project_with_server(test_name: &str, entry: serde_json::Value) -> std::path::PathBuf {
        let dir = temp_project_dir(test_name);
        let config = serde_json::json!({ "mcpServers": { "probe-me": entry } });
        fs::write(
            dir.join(".mcp.json"),
            serde_json::to_string_pretty(&config).expect("config serializes"),
        )
        .expect("config written");
        dir
    }

    /// Run the doctor against a project-scope server.
    async fn diagnose(dir: &std::path::Path) -> McpServerDiagnostic {
        diagnose_mcp_server(
            dir.to_string_lossy().into_owned(),
            "probe-me".to_string(),
            "project".to_string(),
        )
        .await
        .expect("diagnostic returns")
    }

    /// DENIAL OF A FALSE VERDICT: an `http` server must not be reported as
    /// `degraded`. Nothing was sent to it, so its health is unknown — and
    /// `degraded` reads as "measured and unhealthy", which trains users to
    /// ignore the indicator entirely.
    #[tokio::test]
    async fn http_servers_report_not_probed_rather_than_a_false_degraded() {
        let dir = project_with_server("http-not-probed", serde_json::json!({
            "type": "http",
            "url": "https://example.com/mcp",
        }));
        let result = diagnose(&dir).await;
        assert_eq!(result.state, "notProbed");
        assert_eq!(result.transport, "http");
        assert_ne!(result.state, "degraded", "must not claim a measured failure");
        // No latency: a number would imply something was actually timed.
        assert!(result.latency_ms.is_none());
        assert!(
            result.message.contains("Not probed"),
            "message must say what happened: {}",
            result.message
        );
    }

    /// Same for the deprecated `sse` transport.
    #[tokio::test]
    async fn sse_servers_report_not_probed_too() {
        let dir = project_with_server("sse-not-probed", serde_json::json!({
            "type": "sse",
            "url": "https://example.com/sse",
        }));
        let result = diagnose(&dir).await;
        assert_eq!(result.state, "notProbed");
        assert_eq!(result.transport, "sse");
    }

    /// A typo'd `type` is a malformed config, not a remote server. It used to
    /// be swept into the same "remote" answer, which sent the user hunting a
    /// network problem instead of a spelling mistake.
    #[tokio::test]
    async fn an_unknown_transport_is_a_config_failure_not_a_remote_server() {
        let dir = project_with_server("unknown-transport", serde_json::json!({
            "type": "stdioo",
            "command": "echo",
        }));
        let result = diagnose(&dir).await;
        assert_eq!(result.state, "failed");
        assert!(
            result.message.contains("Unknown transport"),
            "message must name the real problem: {}",
            result.message
        );
    }

    /// The stdio path is untouched: a server that cannot be spawned is still a
    /// real, measured `failed`.
    #[tokio::test]
    async fn stdio_servers_are_still_actually_probed() {
        let dir = project_with_server("stdio-still-probed", serde_json::json!({
            "command": "definitely-not-an-executable-packetbench-test",
        }));
        let result = diagnose(&dir).await;
        assert_eq!(result.transport, "stdio");
        assert_eq!(
            result.state, "failed",
            "an unspawnable stdio server is a measured failure"
        );
        assert_ne!(result.state, "notProbed", "stdio IS probed");
    }
}

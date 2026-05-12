//! Real MCP (Model Context Protocol) client implementation.
//!
//! This module replaces the placeholder MCP integration with an actual
//! client that speaks JSON-RPC 2.0 over stdio against MCP server child
//! processes. It implements the MCP `initialize` handshake, `tools/list`
//! discovery, and `tools/call` execution.
//!
//! Servers are spawned lazily on first request and cached in a process-wide
//! singleton (`McpConnectionPool`) to avoid re-spawning per call.
//!
//! Framing: each JSON-RPC message is a single line of JSON terminated by
//! `\n`. Notifications (no `id`) do not generate responses.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema", alias = "input_schema")]
    pub input_schema: Value,
}

/// One spawned MCP server connection. Owns the child process plus the
/// stdin writer and a buffered stdout reader. JSON-RPC request IDs
/// increment monotonically per client.
pub struct McpClient {
    server_name: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl McpClient {
    /// Spawn the MCP server child process and perform the JSON-RPC
    /// `initialize` handshake. Sends `notifications/initialized` after
    /// receiving the initialize response.
    pub async fn spawn(
        server_name: &str,
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        info!(server = %server_name, cmd = %command, "Spawning MCP server");

        // Resolve `.cmd` wrappers on Windows for npm-installed binaries.
        let resolved_command = resolve_command_for_platform(command);

        let mut cmd = Command::new(&resolved_command);
        cmd.args(args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server '{}': {}", server_name, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP server '{}' has no stdin", server_name))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP server '{}' has no stdout", server_name))?;

        // Drain stderr in the background so the child doesn't block on a
        // full pipe; surface it as warn-level traces for debugging.
        if let Some(stderr) = child.stderr.take() {
            let server = server_name.to_string();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    warn!(server = %server, "MCP stderr: {}", line);
                }
            });
        }

        let mut client = McpClient {
            server_name: server_name.to_string(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };

        // initialize handshake
        let init_params = json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": crate::core::brand::APP_NAME,
                "version": "0.2"
            }
        });

        let _resp = client.request("initialize", init_params).await?;

        // Per MCP spec the client must send `notifications/initialized` after
        // a successful initialize response.
        client
            .notify("notifications/initialized", json!({}))
            .await?;

        info!(server = %server_name, "MCP server initialized");
        Ok(client)
    }

    /// Discover the server's tools via `tools/list`.
    pub async fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, String> {
        let resp = self.request("tools/list", json!({})).await?;
        let tools_val = resp
            .get("tools")
            .ok_or_else(|| "tools/list response missing 'tools' array".to_string())?;
        let tools: Vec<McpToolInfo> = serde_json::from_value(tools_val.clone())
            .map_err(|e| format!("Invalid tools/list payload: {}", e))?;
        Ok(tools)
    }

    /// Invoke a tool via `tools/call`. Joins all text content blocks from
    /// the response into a single string.
    pub async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<String, String> {
        let params = json!({
            "name": name,
            "arguments": arguments,
        });
        let resp = self.request("tools/call", params).await?;

        // Surface server-reported errors explicitly.
        if let Some(is_error) = resp.get("isError").and_then(|v| v.as_bool()) {
            if is_error {
                let text = extract_text_content(&resp);
                return Err(if text.is_empty() {
                    format!("MCP tool '{}' reported an error", name)
                } else {
                    text
                });
            }
        }

        Ok(extract_text_content(&resp))
    }

    /// Best-effort graceful shutdown: send the `cancelled` notification,
    /// close stdin, then attempt to reap the child.
    pub async fn shutdown(mut self) {
        let _ = self
            .notify(
                "notifications/cancelled",
                json!({ "reason": "client shutdown" }),
            )
            .await;
        let _ = self.stdin.shutdown().await;
        // Don't block forever; if the child doesn't exit, kill it.
        match tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                let _ = self.child.start_kill();
            }
        }
    }

    /// Send a JSON-RPC request and wait for the matching response.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        self.write_message(&req).await?;

        // Loop reading lines until we find a response with the matching id.
        // Skip notifications and unrelated messages.
        let read_fut = async {
            loop {
                let mut line = String::new();
                let n = self
                    .stdout
                    .read_line(&mut line)
                    .await
                    .map_err(|e| format!("MCP read error: {}", e))?;
                if n == 0 {
                    return Err(format!(
                        "MCP server '{}' closed stdout unexpectedly",
                        self.server_name
                    ));
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        debug!(server = %self.server_name, "Skipping non-JSON line: {} ({})", trimmed, e);
                        continue;
                    }
                };
                let resp_id = val.get("id").and_then(|v| v.as_i64());
                if resp_id != Some(id) {
                    debug!(server = %self.server_name, "Skipping unrelated message id={:?}", resp_id);
                    continue;
                }
                if let Some(err) = val.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown JSON-RPC error");
                    return Err(format!("MCP error from '{}': {}", self.server_name, msg));
                }
                return Ok(val.get("result").cloned().unwrap_or(Value::Null));
            }
        };

        tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), read_fut)
            .await
            .map_err(|_| {
                format!(
                    "MCP server '{}' timed out responding to '{}'",
                    self.server_name, method
                )
            })?
    }

    /// Send a JSON-RPC notification (no id, no response expected).
    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_message(&msg).await
    }

    async fn write_message(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg)
            .map_err(|e| format!("Failed to serialize MCP message: {}", e))?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("MCP write error: {}", e))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("MCP flush error: {}", e))?;
        Ok(())
    }
}

/// Extract joined text from the `content` array of a tools/call response.
fn extract_text_content(resp: &Value) -> String {
    let content = match resp.get("content").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return String::new(),
    };
    let mut out = String::new();
    for block in content {
        let ty = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ty == "text" {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
    }
    out
}

/// On Windows, npm-installed binaries are typically `.cmd` shims. If the
/// caller passed a bare command name like `npx`, try the `.cmd` form first.
fn resolve_command_for_platform(command: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        // If the caller already supplied an extension or path separator,
        // trust them. Otherwise probe PATH for `<cmd>.cmd`.
        if command.contains('/')
            || command.contains('\\')
            || command.to_lowercase().ends_with(".exe")
            || command.to_lowercase().ends_with(".cmd")
            || command.to_lowercase().ends_with(".bat")
        {
            return command.to_string();
        }
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                for ext in ["cmd", "bat", "exe"] {
                    let candidate = dir.join(format!("{}.{}", command, ext));
                    if candidate.is_file() {
                        return candidate.to_string_lossy().to_string();
                    }
                }
            }
        }
    }
    command.to_string()
}

/// Per-server config used to spawn a client lazily.
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// Process-wide singleton pool of live MCP client connections.
///
/// Clients are spawned lazily on first reference and reused across calls.
/// Each client is wrapped in its own `Mutex` so concurrent `tools/list` and
/// `tools/call` requests against different servers don't serialize through
/// the pool itself.
pub struct McpConnectionPool {
    clients: HashMap<String, Arc<Mutex<McpClient>>>,
}

impl McpConnectionPool {
    fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    /// The global singleton.
    pub fn instance() -> &'static Arc<Mutex<McpConnectionPool>> {
        static POOL: OnceLock<Arc<Mutex<McpConnectionPool>>> = OnceLock::new();
        POOL.get_or_init(|| Arc::new(Mutex::new(McpConnectionPool::new())))
    }

    /// Look up the configuration for a single server from the user's
    /// global settings file. Returns `None` if the server is missing or
    /// disabled.
    fn load_server_config(name: &str) -> Option<McpServerConfig> {
        let path = global_settings_path();
        let content = std::fs::read_to_string(&path).ok()?;
        let json: Value = serde_json::from_str(&content).ok()?;
        let server = json.get("mcpServers")?.get(name)?;

        let disabled = server
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if disabled {
            return None;
        }

        let command = server.get("command").and_then(|v| v.as_str())?.to_string();
        let args: Vec<String> = server
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let env: HashMap<String, String> = server
            .get("env")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        Some(McpServerConfig { command, args, env })
    }

    /// Get or spawn the client for a given server. Returns an `Arc<Mutex<_>>`
    /// so callers can hold the inner lock for the duration of one JSON-RPC
    /// exchange without blocking other servers.
    async fn get_or_spawn(server_name: &str) -> Result<Arc<Mutex<McpClient>>, String> {
        // Fast path: existing client.
        {
            let pool = Self::instance().lock().await;
            if let Some(c) = pool.clients.get(server_name) {
                return Ok(c.clone());
            }
        }

        // Slow path: load config and spawn outside the pool lock so the
        // (potentially slow) spawn doesn't block other server lookups.
        let config = Self::load_server_config(server_name).ok_or_else(|| {
            format!(
                "MCP server '{}' is not configured or is disabled",
                server_name
            )
        })?;

        let client =
            McpClient::spawn(server_name, &config.command, &config.args, &config.env).await?;
        let arc = Arc::new(Mutex::new(client));

        // Insert (or, if a concurrent caller raced us, drop ours and reuse).
        let mut pool = Self::instance().lock().await;
        if let Some(existing) = pool.clients.get(server_name) {
            // Race: someone else inserted first. Spawn shutdown of ours.
            let losing = arc;
            tokio::spawn(async move {
                let inner = Arc::try_unwrap(losing).ok();
                if let Some(m) = inner {
                    m.into_inner().shutdown().await;
                }
            });
            return Ok(existing.clone());
        }
        pool.clients.insert(server_name.to_string(), arc.clone());
        Ok(arc)
    }

    /// Public convenience: list tools for a single named server.
    pub async fn list_tools_for_server(name: &str) -> Result<Vec<McpToolInfo>, String> {
        let client = Self::get_or_spawn(name).await?;
        let mut guard = client.lock().await;
        guard.list_tools().await
    }

    /// Public convenience: invoke a tool on a named server.
    pub async fn call_tool_on_server(
        server: &str,
        tool: &str,
        args: &Value,
    ) -> Result<String, String> {
        let client = Self::get_or_spawn(server).await?;
        let mut guard = client.lock().await;
        guard.call_tool(tool, args).await
    }
}

/// Resolve the user's home directory in a cross-platform way.
fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .ok()
            .map(std::path::PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(std::path::PathBuf::from)
    }
}

fn global_settings_path() -> std::path::PathBuf {
    home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".claude")
        .join("settings.json")
}

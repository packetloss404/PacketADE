//! Native Syndicate controller client.
//!
//! This is the single PacketBench boundary for controller protocol v1. The
//! frontend never receives a device private key and can only invoke the typed
//! operations below; there is deliberately no generic RPC, URL, command,
//! argv, path, or environment escape hatch.

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::info;
use uuid::Uuid;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519Secret};

use crate::core::brand::KEYRING_SERVICE;
use crate::core::execution::SshConfig;

const PROTOCOL_VERSION: u8 = 1;
const RPC_PATH: &str = "/api/v1/controller/rpc";
const CLAIM_PATH: &str = "/api/v1/controller/pairing/claim";
const DEFAULT_PORT: u16 = 4317;
const MAX_TERMINAL_INPUT_BYTES: usize = 32_768;

/// PacketBench-local error code for the Settings kill switch. Host codes are
/// defined by `CONTROLLER_PROTOCOL_V1`; this one never appears on the wire.
pub const CODE_INTEGRATION_DISABLED: &str = "INTEGRATION_DISABLED";
const INTEGRATION_DISABLED_MESSAGE: &str = "Syndicate integration is disabled in Settings.";

const DEFAULT_SCOPES: &[&str] = &[
    "machine.read",
    "workspace.read",
    "workspace.create",
    "session.start",
    "terminal.view",
    "terminal.input",
    "terminal.resize",
    "terminal.stop",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyndicateMachineConnection {
    pub machine_id: String,
    pub device_id: String,
    pub server_config_id: String,
    #[serde(default = "default_port")]
    pub local_port: u16,
    #[serde(default)]
    pub relay_endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairMachineRequest {
    pub pairing_payload: String,
    pub device_name: String,
    pub server_config_id: String,
    #[serde(default)]
    pub relay_endpoint: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingPayload {
    machine_id: String,
    #[serde(default)]
    display_name: Option<String>,
    invite_id: String,
    invite_token: String,
    machine_signing_public_key: String,
    machine_signing_fingerprint: String,
    machine_key_agreement_public_key: String,
    machine_key_agreement_fingerprint: String,
    requested_scopes: Vec<String>,
    expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingEnvelope {
    protocol_version: u8,
    #[serde(default)]
    relay_endpoint: Option<String>,
    invitation: PairingPayload,
}

#[derive(Debug, Clone)]
struct ParsedPairingPackage {
    invitation: PairingPayload,
    relay_endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairPublicKey {
    format: &'static str,
    algorithm: &'static str,
    data_base64_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairClaimRequest {
    protocol_version: u8,
    invite_id: String,
    invite_token: String,
    device_name: String,
    public_key: PairPublicKey,
    key_agreement_public_key: PairPublicKey,
    proof_nonce: String,
    proof_signature: String,
}

// Deliberately not `deny_unknown_fields`, unlike the invitation envelope above.
// `CONTROLLER_PROTOCOL_V1` pins the invitation field-by-field and backs it with
// a cross-repo fixture, so strictness there is a conformance check. It says
// nothing about the claim response, so rejecting unknown fields here would turn
// any additive Host change into a silent pairing failure on already-shipped
// PacketBench builds. Every field this client relies on is still required below.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairClaimResponse {
    protocol_version: u8,
    device: PairClaimDevice,
    approval_required: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairClaimDevice {
    device_id: String,
    device_name: String,
    status: String,
    scopes: Vec<String>,
    revocation_epoch: u64,
    grant_expires_at: Option<String>,
    paired_at: String,
    approved_at: Option<String>,
    revoked_at: Option<String>,
    public_key_fingerprint: String,
    key_agreement_fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairMachineResult {
    pub machine_id: String,
    pub machine_name: String,
    pub device_id: String,
    pub server_config_id: String,
    pub local_port: u16,
    pub relay_endpoint: Option<String>,
    pub host_fingerprint: Option<String>,
    pub machine_signing_fingerprint: String,
    pub machine_key_agreement_fingerprint: Option<String>,
    pub grant_status: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcEnvelope<'a> {
    protocol_version: u8,
    request_id: &'a str,
    device_id: &'a str,
    machine_id: &'a str,
    method: &'a str,
    expires_at: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcResponse {
    protocol_version: u8,
    request_id: String,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcError {
    code: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    retryable: bool,
    #[serde(default)]
    correlation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyndicateRpcResult {
    pub request_id: String,
    pub result: Value,
    /// PacketBench's carrier for this completed request. This is deliberately
    /// separate from machine.snapshot's Host-local controller transport.
    pub transport: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCreateRequest {
    pub connection: SyndicateMachineConnection,
    pub repository_id: String,
    pub name: String,
    pub client_operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStartRequest {
    pub connection: SyndicateMachineConnection,
    pub pane_id: String,
    pub terminal_session_id: String,
    pub profile_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaneCreateRequest {
    pub connection: SyndicateMachineConnection,
    pub workspace_id: String,
    pub title: String,
    pub profile_id: String,
    pub client_operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAttachRequest {
    pub connection: SyndicateMachineConnection,
    pub pane_id: String,
    pub terminal_session_id: String,
    pub session_id: String,
    pub after_sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventsReadRequest {
    pub connection: SyndicateMachineConnection,
    pub after_sequence: u64,
    #[serde(default)]
    pub limit: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionInputRequest {
    pub connection: SyndicateMachineConnection,
    pub session_id: String,
    pub frame_id: String,
    pub input_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionResizeRequest {
    pub connection: SyndicateMachineConnection,
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStopRequest {
    pub connection: SyndicateMachineConnection,
    pub session_id: String,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

/// Typed failure for every Syndicate command.
///
/// `CONTROLLER_PROTOCOL_V1` answers a rejected RPC with
/// `error: {code, retryable, correlationId}`. Flattening that into a sentence
/// forced the frontend to re-derive the verdict with message regexes, which is
/// how `DEVICE_UNAUTHORIZED` — the code a Host returns for an expired grant —
/// became an unbounded reconnect loop. The typed fields are carried through to
/// the frontend verbatim so retry and grant-state decisions branch on data.
///
/// `code` and `retryable` are `None` for failures that never reached a Host
/// (validation, tunnels, sockets). Absence therefore means "no Host verdict",
/// which callers must not read as "not retryable".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyndicateCommandError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

impl SyndicateCommandError {
    /// A failure PacketBench decided locally, with no Host verdict attached.
    pub fn local(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            retryable: None,
            correlation_id: None,
        }
    }

    /// A failure PacketBench decided locally but can classify as authoritatively
    /// as the Host would — an expired or revoked relay grant it holds itself.
    pub fn local_typed(code: &str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code.to_string()),
            retryable: Some(false),
            correlation_id: None,
        }
    }
}

impl From<String> for SyndicateCommandError {
    fn from(message: String) -> Self {
        Self::local(message)
    }
}

impl From<&str> for SyndicateCommandError {
    fn from(message: &str) -> Self {
        Self::local(message)
    }
}

impl std::fmt::Display for SyndicateCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn require_id(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(format!("{} is invalid.", label))
    }
}

fn validate_connection(connection: &SyndicateMachineConnection) -> Result<(), String> {
    require_id(&connection.machine_id, "Machine id")?;
    require_id(&connection.device_id, "Device id")?;
    require_id(&connection.server_config_id, "Server config id")?;
    if connection.local_port == 0 {
        return Err("Syndicate local-forward port is invalid.".into());
    }
    if let Some(endpoint) = connection.relay_endpoint.as_deref() {
        crate::commands::syndicate_relay::RelayTransport::new(
            crate::commands::syndicate_relay::RelayDeviceCredential {
                endpoint: endpoint.to_string(),
                machine_id: connection.machine_id.clone(),
                device_id: connection.device_id.clone(),
            },
        )?;
    }
    Ok(())
}

struct ManagedTunnel {
    local_port: u16,
    child: tokio::process::Child,
    #[cfg(unix)]
    _askpass_guard: Option<crate::core::ssh_askpass::AskpassGuard>,
}

static TUNNELS: OnceLock<Mutex<HashMap<String, ManagedTunnel>>> = OnceLock::new();
static TUNNEL_START_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SYNDICATE_OPERATION_GATE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
// Fail closed until the persisted frontend preference is mirrored during app
// bootstrap. This prevents a direct/racing invoke from opening controller
// authority before Settings has been applied.
static SYNDICATE_INTEGRATION_ENABLED: AtomicBool = AtomicBool::new(false);
static RELAY_CREDENTIAL_GATE: Mutex<()> = Mutex::new(());

fn require_integration_enabled() -> Result<(), SyndicateCommandError> {
    if SYNDICATE_INTEGRATION_ENABLED.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(SyndicateCommandError::local_typed(
            CODE_INTEGRATION_DISABLED,
            INTEGRATION_DISABLED_MESSAGE,
        ))
    }
}

fn tunnels() -> &'static Mutex<HashMap<String, ManagedTunnel>> {
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolve_server_config(
    server_config_id: &str,
) -> Result<crate::core::storage::ServerConfig, String> {
    require_id(server_config_id, "Server config id")?;
    let server = crate::core::storage::load_state()
        .servers
        .into_iter()
        .find(|server| server.id == server_config_id)
        .ok_or_else(|| "The selected SSH server no longer exists in Settings.".to_string())?;
    if server.host_fingerprint.is_none() {
        return Err(
            "Verify and pin this server's SSH host key in Settings before pairing Syndicate."
                .into(),
        );
    }
    if !crate::core::execution::app_known_hosts_path().is_file() {
        return Err(
            "PacketBench's pinned SSH known_hosts file is missing. Re-verify the server host key."
                .into(),
        );
    }
    Ok(server)
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        format!(
            "Failed to allocate a loopback port for Syndicate: {}",
            error
        )
    })?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Failed to inspect the Syndicate loopback port: {}", error))
}

fn tunnel_ssh_args(config: &SshConfig, local_port: u16, password_auth: bool) -> Vec<String> {
    let inherited = config.ssh_args(password_auth);
    let target = inherited
        .last()
        .cloned()
        .expect("SshConfig::ssh_args always has a target");
    let mut args = vec![
        "-o".into(),
        "ControlMaster=no".into(),
        "-o".into(),
        "ControlPath=none".into(),
        "-o".into(),
        "ControlPersist=no".into(),
    ];
    for argument in inherited
        .into_iter()
        .take_while(|argument| argument != &target)
    {
        // PacketBench's general SSH helper enables ControlMaster on Unix. A
        // controller tunnel owns its child lifecycle, so inherited Control*
        // options are removed; OpenSSH uses the first value, not the last.
        if argument.starts_with("ControlMaster=")
            || argument.starts_with("ControlPath=")
            || argument.starts_with("ControlPersist=")
        {
            let _ = args.pop(); // matching "-o"
            continue;
        }
        args.push(argument);
    }
    args.extend([
        "-N".into(),
        "-T".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ForwardAgent=no".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-L".into(),
        format!("127.0.0.1:{}:127.0.0.1:{}", local_port, DEFAULT_PORT),
        target,
    ]);
    args
}

async fn ensure_tunnel(server_config_id: &str, requested_port: u16) -> Result<u16, String> {
    let _start_guard = TUNNEL_START_GATE.lock().await;
    {
        let mut registry = tunnels()
            .lock()
            .map_err(|_| "Syndicate tunnel registry is unavailable.".to_string())?;
        if let Some(tunnel) = registry.get_mut(server_config_id) {
            match tunnel.child.try_wait() {
                Ok(None) => return Ok(tunnel.local_port),
                Ok(Some(_)) | Err(_) => {
                    registry.remove(server_config_id);
                }
            }
        }
    }

    let server = resolve_server_config(server_config_id)?;
    let local_port = if requested_port == 0 {
        allocate_loopback_port()?
    } else {
        requested_port
    };
    if TcpListener::bind(("127.0.0.1", local_port)).is_err() {
        return Err(format!(
            "Loopback port {} is already in use; remove and pair this Syndicate machine again.",
            local_port
        ));
    }
    let password = if server.auth_method == "password" {
        Some(
            crate::commands::ssh_keys::load_ssh_password(&server.id)?.ok_or_else(|| {
                "The selected SSH server has no saved password. Re-save it in Settings.".to_string()
            })?,
        )
    } else {
        None
    };
    let config = SshConfig {
        host: server.host,
        port: server.port,
        user: server.username,
        remote_path: String::new(),
        key_path: server.key_path,
        auth_method: Some(server.auth_method),
        target_id: Some(server.id.clone()),
        host_fingerprint: server.host_fingerprint,
    };
    let mut command = tokio::process::Command::new("ssh");
    command
        .args(tunnel_ssh_args(&config, local_port, password.is_some()))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::commands::shared::hide_window_async(&mut command);
    #[cfg(unix)]
    let askpass_guard = password
        .as_deref()
        .map(|password| crate::core::ssh_askpass::arm(&mut command, password))
        .transpose()?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to launch the Syndicate SSH tunnel: {}", error))?;
    #[cfg(windows)]
    if let Some(password) = password.as_ref() {
        use tokio::io::AsyncWriteExt;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(format!("{}\n", password).as_bytes())
                .await
                .map_err(|error| {
                    format!("Failed to authenticate the Syndicate SSH tunnel: {}", error)
                })?;
            let _ = stdin.flush().await;
        }
    }
    #[cfg(unix)]
    drop(child.stdin.take());

    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    loop {
        if TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], local_port)),
            Duration::from_millis(150),
        )
        .is_ok()
        {
            break;
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect the Syndicate SSH tunnel: {}", error))?
        {
            return Err(format!(
                "The Syndicate SSH tunnel exited before it became ready ({}).",
                status
            ));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.start_kill();
            return Err("Timed out waiting for the Syndicate SSH tunnel. Check the saved server credentials and pinned host key.".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let managed = ManagedTunnel {
        local_port,
        child,
        #[cfg(unix)]
        _askpass_guard: askpass_guard,
    };
    tunnels()
        .lock()
        .map_err(|_| "Syndicate tunnel registry is unavailable.".to_string())?
        .insert(server_config_id.to_string(), managed);
    Ok(local_port)
}

fn close_tunnels() -> Result<(), String> {
    if let Some(registry) = TUNNELS.get() {
        let mut registry = registry
            .lock()
            .map_err(|_| "Syndicate tunnel registry is unavailable.".to_string())?;
        for (_, mut tunnel) in registry.drain() {
            let _ = tunnel.child.start_kill();
        }
    }
    Ok(())
}

pub fn shutdown_tunnels() {
    let _ = close_tunnels();
}

fn validate_terminal_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=500).contains(&cols) || !(2..=300).contains(&rows) {
        return Err("Terminal dimensions are outside the supported bounds.".into());
    }
    Ok(())
}

fn base_url(port: u16) -> String {
    // Controller v1 is intentionally loopback-only. A managed/external SSH -L
    // or future relay transport can terminate here without widening the HTTP
    // client's authority to arbitrary endpoints.
    format!("http://127.0.0.1:{}", port)
}

fn epoch_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "System clock is before the Unix epoch.".to_string())
}

fn random_nonce() -> String {
    URL_SAFE_NO_PAD.encode(Uuid::new_v4().as_bytes())
}

fn sha256_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}

fn stable_request_id(operation: &str, identities: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"packetbench-syndicate-request-v1\0");
    digest.update(operation.as_bytes());
    for identity in identities {
        digest.update(b"\0");
        digest.update(identity.as_bytes());
    }
    format!("req_{}", URL_SAFE_NO_PAD.encode(digest.finalize()))
}

fn credential_entry(machine_id: &str) -> Result<keyring::Entry, String> {
    require_id(machine_id, "Machine id")?;
    keyring::Entry::new(
        KEYRING_SERVICE,
        &format!("syndicate-controller-{}", machine_id),
    )
    .map_err(|error| format!("OS credential store is unavailable: {}", error))
}

fn ensure_machine_not_already_paired(machine_id: &str) -> Result<(), String> {
    match credential_entry(machine_id)?.get_password() {
        Ok(_) => Err("This Syndicate machine is already paired. Revoke it, or explicitly forget the offline device, before pairing a replacement so the existing grant remains revocable.".into()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Failed to check the OS credential store before pairing Syndicate: {}",
            error
        )),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredControllerCredential {
    version: u8,
    pub(super) signing_private_key_base64_url: String,
    pub(super) key_agreement_private_key_base64_url: String,
    pub(super) host_signing_public_key_base64_url: String,
    pub(super) host_key_agreement_public_key_base64_url: String,
    pub(super) relay_grant_json: Option<String>,
    pub(super) relay_grant_signature_base64_url: Option<String>,
    /// PacketRelay counters are persisted before use by the relay transport.
    /// Direct SSH-forward RPC does not consume them.
    pub(super) relay_send_counter: u64,
    pub(super) relay_receive_counter: u64,
}

pub(super) fn reserve_relay_send_counter(
    machine_id: &str,
) -> Result<(StoredControllerCredential, u64), String> {
    let _guard = RELAY_CREDENTIAL_GATE
        .lock()
        .map_err(|_| "Syndicate relay credential lock is unavailable.".to_string())?;
    let (_, mut credential) = load_controller_credential(machine_id)?;
    credential.relay_send_counter = credential
        .relay_send_counter
        .checked_add(1)
        .ok_or_else(|| "Syndicate relay send counter is exhausted.".to_string())?;
    let counter = credential.relay_send_counter;
    persist_controller_credential(machine_id, &credential)?;
    Ok((credential, counter))
}

fn relay_grant_available(machine_id: &str) -> Result<bool, String> {
    let _guard = RELAY_CREDENTIAL_GATE
        .lock()
        .map_err(|_| "Syndicate relay credential lock is unavailable.".to_string())?;
    Ok(load_controller_credential(machine_id)?
        .1
        .relay_grant_json
        .is_some())
}

fn use_relay_transport(relay_endpoint: Option<&str>, relay_grant_available: bool) -> bool {
    relay_endpoint.is_some() && relay_grant_available
}

pub(super) fn commit_relay_receive_counter(machine_id: &str, counter: u64) -> Result<(), String> {
    let _guard = RELAY_CREDENTIAL_GATE
        .lock()
        .map_err(|_| "Syndicate relay credential lock is unavailable.".to_string())?;
    let (_, mut credential) = load_controller_credential(machine_id)?;
    if counter <= credential.relay_receive_counter {
        return Err("Syndicate relay frame was replayed or rolled back.".into());
    }
    credential.relay_receive_counter = counter;
    persist_controller_credential(machine_id, &credential)
}

fn save_controller_credential(
    machine_id: &str,
    signing_key: &SigningKey,
    key_agreement_secret: &X25519Secret,
    host_signing_public_key_base64_url: &str,
    host_key_agreement_public_key_base64_url: &str,
) -> Result<(), String> {
    let credential = StoredControllerCredential {
        version: PROTOCOL_VERSION,
        signing_private_key_base64_url: URL_SAFE_NO_PAD.encode(signing_key.to_bytes()),
        key_agreement_private_key_base64_url: URL_SAFE_NO_PAD
            .encode(key_agreement_secret.to_bytes()),
        host_signing_public_key_base64_url: host_signing_public_key_base64_url.to_string(),
        host_key_agreement_public_key_base64_url: host_key_agreement_public_key_base64_url
            .to_string(),
        relay_grant_json: None,
        relay_grant_signature_base64_url: None,
        relay_send_counter: 0,
        relay_receive_counter: 0,
    };
    let encoded = serde_json::to_string(&credential).map_err(|error| {
        format!(
            "Failed to encode the Syndicate controller credential: {}",
            error
        )
    })?;
    credential_entry(machine_id)?
        .set_password(&encoded)
        .map_err(|error| format!("Failed to save the Syndicate controller key: {}", error))
}

fn load_signing_key(machine_id: &str) -> Result<SigningKey, String> {
    Ok(SigningKey::from_bytes(
        &load_controller_credential(machine_id)?.0,
    ))
}

fn load_controller_credential(
    machine_id: &str,
) -> Result<([u8; 32], StoredControllerCredential), String> {
    let encoded = credential_entry(machine_id)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => {
                "This Syndicate machine has no controller key. Pair it again.".to_string()
            }
            other => format!("Failed to read the Syndicate controller key: {}", other),
        })?;
    let credential: StoredControllerCredential = serde_json::from_str(&encoded)
        .map_err(|_| "The stored Syndicate controller credential is corrupt.".to_string())?;
    if credential.version != PROTOCOL_VERSION {
        return Err(
            "The stored Syndicate controller credential has an unsupported version.".into(),
        );
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(&credential.signing_private_key_base64_url)
        .map_err(|_| "The stored Syndicate controller key is corrupt.".to_string())?;
    let secret: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "The stored Syndicate controller key has an invalid length.".to_string())?;
    Ok((secret, credential))
}

fn persist_controller_credential(
    machine_id: &str,
    credential: &StoredControllerCredential,
) -> Result<(), String> {
    credential_entry(machine_id)?
        .set_password(
            &serde_json::to_string(credential)
                .map_err(|error| format!("Failed to encode controller credential: {}", error))?,
        )
        .map_err(|error| format!("Failed to update the Syndicate controller key: {}", error))
}

fn delete_signing_key(machine_id: &str) -> Result<(), String> {
    match credential_entry(machine_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Failed to delete the Syndicate controller key: {}",
            error
        )),
    }
}

fn spki_public_key(key: &SigningKey) -> Vec<u8> {
    // RFC 8410 SubjectPublicKeyInfo prefix for Ed25519 followed by the raw
    // 32-byte public key. Keeping this tiny encoder local avoids accepting
    // alternative key/format surfaces in protocol v1.
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    let mut bytes = Vec::with_capacity(44);
    bytes.extend_from_slice(&PREFIX);
    bytes.extend_from_slice(key.verifying_key().as_bytes());
    bytes
}

fn spki_x25519_public_key(public_key: &X25519PublicKey) -> Vec<u8> {
    // RFC 8410 SubjectPublicKeyInfo prefix for X25519 (OID 1.3.101.110).
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
    ];
    let mut bytes = Vec::with_capacity(44);
    bytes.extend_from_slice(&PREFIX);
    bytes.extend_from_slice(public_key.as_bytes());
    bytes
}

pub(super) fn canonical_json(value: &Value) -> Result<String, String> {
    fn write(value: &Value, output: &mut String) -> Result<(), String> {
        match value {
            Value::Null => output.push_str("null"),
            Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Value::String(value) => output.push_str(
                &serde_json::to_string(value)
                    .map_err(|error| format!("Failed to encode string: {}", error))?,
            ),
            Value::Number(value) => {
                if !value.is_i64() && !value.is_u64() {
                    return Err(
                        "Floating-point numbers are not accepted by controller protocol v1.".into(),
                    );
                }
                output.push_str(&value.to_string());
            }
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write(value, output)?;
                }
                output.push(']');
            }
            Value::Object(values) => {
                output.push('{');
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output
                        .push_str(&serde_json::to_string(key).map_err(|error| error.to_string())?);
                    output.push(':');
                    write(&values[key], output)?;
                }
                output.push('}');
            }
        }
        Ok(())
    }
    let mut output = String::new();
    write(value, &mut output)?;
    Ok(output)
}

fn capture_relay_grant(
    connection: &SyndicateMachineConnection,
    snapshot: &Value,
) -> Result<(), String> {
    let Some(relay_grant) = snapshot.pointer("/controller/device/relayGrant") else {
        return Ok(());
    };
    let grant = relay_grant
        .get("grant")
        .ok_or_else(|| "Syndicate relay grant is missing its certificate.".to_string())?;
    let signature_encoded = relay_grant
        .get("grantSignatureBase64Url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Syndicate relay grant is missing its signature.".to_string())?;
    if grant.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || grant.get("type").and_then(Value::as_str) != Some("device_grant")
        || grant.get("machineId").and_then(Value::as_str) != Some(&connection.machine_id)
        || grant.get("deviceId").and_then(Value::as_str) != Some(&connection.device_id)
    {
        return Err("Syndicate relay grant identity does not match this paired target.".into());
    }
    let route_id = grant
        .get("routeId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Syndicate relay grant is missing a route id.".to_string())?;
    let _credential_guard = RELAY_CREDENTIAL_GATE
        .lock()
        .map_err(|_| "Syndicate relay credential lock is unavailable.".to_string())?;
    let (secret, mut credential) = load_controller_credential(&connection.machine_id)?;
    let host_der = URL_SAFE_NO_PAD
        .decode(&credential.host_signing_public_key_base64_url)
        .map_err(|_| "Stored Syndicate Host signing key is corrupt.".to_string())?;
    let expected_route = format!("route_{}", sha256_base64url(&host_der));
    if route_id != expected_route {
        return Err("Syndicate relay grant route does not match the paired Host key.".into());
    }
    if grant
        .get("hostSigningPublicKeyBase64Url")
        .and_then(Value::as_str)
        != Some(credential.host_signing_public_key_base64_url.as_str())
        || grant
            .get("hostKeyAgreementPublicKeyBase64Url")
            .and_then(Value::as_str)
            != Some(credential.host_key_agreement_public_key_base64_url.as_str())
    {
        return Err("Syndicate relay grant Host keys do not match the pairing invitation.".into());
    }
    let signing_key = SigningKey::from_bytes(&secret);
    let device_signing_spki = URL_SAFE_NO_PAD.encode(spki_public_key(&signing_key));
    if grant
        .get("deviceSigningPublicKeyBase64Url")
        .and_then(Value::as_str)
        != Some(device_signing_spki.as_str())
    {
        return Err("Syndicate relay grant signing key does not match this device.".into());
    }
    let agreement_secret_bytes = URL_SAFE_NO_PAD
        .decode(&credential.key_agreement_private_key_base64_url)
        .map_err(|_| "Stored Syndicate key-agreement key is corrupt.".to_string())?;
    let agreement_secret: [u8; 32] = agreement_secret_bytes
        .try_into()
        .map_err(|_| "Stored Syndicate key-agreement key has an invalid length.".to_string())?;
    let agreement_public = X25519PublicKey::from(&X25519Secret::from(agreement_secret));
    let device_agreement_spki = URL_SAFE_NO_PAD.encode(spki_x25519_public_key(&agreement_public));
    if grant
        .get("deviceKeyAgreementPublicKeyBase64Url")
        .and_then(Value::as_str)
        != Some(device_agreement_spki.as_str())
    {
        return Err("Syndicate relay grant key-agreement key does not match this device.".into());
    }
    let verifying_bytes: [u8; 32] = host_der[host_der.len() - 32..]
        .try_into()
        .map_err(|_| "Stored Syndicate Host signing key has an invalid length.".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&verifying_bytes)
        .map_err(|_| "Stored Syndicate Host signing key is invalid.".to_string())?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_encoded)
        .map_err(|_| "Syndicate relay grant signature is not valid base64url.".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Syndicate relay grant signature has an invalid length.".to_string())?;
    let canonical = canonical_json(grant)?;
    verifying_key
        .verify(
            format!("SYNDICATE-RELAY-GRANT-V1\n{}", canonical).as_bytes(),
            &signature,
        )
        .map_err(|_| "Syndicate relay grant signature verification failed.".to_string())?;

    credential.relay_grant_json = Some(canonical);
    credential.relay_grant_signature_base64_url = Some(signature_encoded.to_string());
    persist_controller_credential(&connection.machine_id, &credential)
}

fn parse_pairing_payload(input: &str) -> Result<ParsedPairingPackage, String> {
    let trimmed = input.trim();
    let json = if let Some(encoded) = trimmed.strip_prefix("syndicate-pair-v1:") {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "The Syndicate pairing code is not valid base64url.".to_string())?;
        String::from_utf8(bytes)
            .map_err(|_| "The Syndicate pairing code is not UTF-8.".to_string())?
    } else {
        trimmed.to_string()
    };
    let envelope: PairingEnvelope = serde_json::from_str(&json)
        .map_err(|_| "Paste the complete pairing payload printed by Syndicate.".to_string())?;
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "Unsupported Syndicate pairing protocol {} (PacketBench supports v1).",
            envelope.protocol_version
        ));
    }
    let payload = envelope.invitation;
    require_id(&payload.machine_id, "Machine id")?;
    require_id(&payload.invite_id, "Invite id")?;
    if payload.invite_token.len() < 32 || payload.invite_token.len() > 128 {
        return Err("The Syndicate invite token has an invalid length.".into());
    }
    if payload.requested_scopes.is_empty()
        || payload
            .requested_scopes
            .iter()
            .any(|scope| !DEFAULT_SCOPES.contains(&scope.as_str()))
    {
        return Err("The Syndicate invitation requests unsupported controller scopes.".into());
    }
    let expires_at = time::OffsetDateTime::parse(
        &payload.expires_at,
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| "The Syndicate invitation expiry is invalid.".to_string())?;
    if expires_at <= time::OffsetDateTime::now_utc() {
        return Err("The Syndicate pairing invitation has expired.".into());
    }
    validate_spki_fingerprint(
        &payload.machine_signing_public_key,
        &payload.machine_signing_fingerprint,
        &[0x2b, 0x65, 0x70],
        "Host signing key",
    )?;
    validate_spki_fingerprint(
        &payload.machine_key_agreement_public_key,
        &payload.machine_key_agreement_fingerprint,
        &[0x2b, 0x65, 0x6e],
        "Host key-agreement key",
    )?;
    let relay_endpoint = envelope
        .relay_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty())
        .map(str::to_string);
    if let Some(endpoint) = relay_endpoint.as_deref() {
        // Validate the package-selected transport before the one-use invite is
        // claimed. The final device id does not participate in URL policy.
        crate::commands::syndicate_relay::RelayTransport::new(
            crate::commands::syndicate_relay::RelayDeviceCredential {
                endpoint: endpoint.to_string(),
                machine_id: payload.machine_id.clone(),
                device_id: "pending-device".into(),
            },
        )?;
    }
    Ok(ParsedPairingPackage {
        invitation: payload,
        relay_endpoint,
    })
}

fn select_relay_endpoint(explicit: Option<&str>, packaged: Option<String>) -> Option<String> {
    explicit
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty())
        .map(str::to_string)
        .or(packaged)
}

fn validate_spki_fingerprint(
    public_key_base64_url: &str,
    fingerprint: &str,
    oid_tail: &[u8],
    label: &str,
) -> Result<(), String> {
    let der = URL_SAFE_NO_PAD
        .decode(public_key_base64_url)
        .map_err(|_| format!("{} is not valid base64url.", label))?;
    if der.len() != 44 || &der[6..9] != oid_tail {
        return Err(format!("{} is not a valid protocol v1 SPKI key.", label));
    }
    if sha256_base64url(&der) != fingerprint {
        return Err(format!(
            "{} fingerprint does not match its public key.",
            label
        ));
    }
    Ok(())
}

async fn send_rpc(
    connection: &SyndicateMachineConnection,
    method: &'static str,
    params: Value,
    request_id: Option<String>,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    send_rpc_with_authority(connection, method, params, request_id, false).await
}

/// `allow_while_disabled` exists for exactly one caller: `device.revoke_self`.
/// The kill switch must never block the remedy it exists to enable, and
/// revocation is the only controller operation that *reduces* this device's
/// authority. Every other method stays fail-closed.
async fn send_rpc_with_authority(
    connection: &SyndicateMachineConnection,
    method: &'static str,
    params: Value,
    request_id: Option<String>,
    allow_while_disabled: bool,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    if !allow_while_disabled {
        require_integration_enabled()?;
    }
    // Keep a shared operation lease through signing and transport. Disable
    // flips the flag before taking the exclusive lease, so new relay and SSH
    // work fails while it waits for already-started requests to settle.
    let _operation_guard = SYNDICATE_OPERATION_GATE.read().await;
    if !allow_while_disabled {
        require_integration_enabled()?;
    }
    validate_connection(connection)?;
    let request_id = request_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    require_id(&request_id, "Request id")?;
    let timestamp = epoch_ms()?;
    let nonce = random_nonce();
    let envelope = RpcEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: &request_id,
        device_id: &connection.device_id,
        machine_id: &connection.machine_id,
        method,
        expires_at: (time::OffsetDateTime::now_utc() + time::Duration::seconds(30))
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|error| format!("Failed to encode request expiry: {}", error))?,
        params,
    };
    let envelope_value = serde_json::to_value(&envelope)
        .map_err(|error| format!("Failed to encode Syndicate request: {}", error))?;
    let body = canonical_json(&envelope_value)?.into_bytes();
    let signing_payload = format!(
        "SYNDICATE-CONTROLLER-V1\nPOST\n{}\n{}\n{}\n{}\n{}",
        RPC_PATH,
        connection.device_id,
        timestamp,
        nonce,
        sha256_base64url(&body)
    );
    let signature = URL_SAFE_NO_PAD.encode(
        load_signing_key(&connection.machine_id)?
            .sign(signing_payload.as_bytes())
            .to_bytes(),
    );

    // Pairing approval is bootstrapped over the pinned SSH forward: the Host
    // grant is first exposed by machine.snapshot, so relay cannot be selected
    // until that verified certificate has been captured locally. This is a
    // proven pre-send condition, not a post-attempt transport fallback.
    let has_relay_grant = relay_grant_available(&connection.machine_id)?;
    let relay_response =
        if use_relay_transport(connection.relay_endpoint.as_deref(), has_relay_grant) {
            let endpoint = connection
                .relay_endpoint
                .as_deref()
                .expect("relay endpoint was selected");
            let relay = crate::commands::syndicate_relay::RelayTransport::new(
                crate::commands::syndicate_relay::RelayDeviceCredential {
                    endpoint: endpoint.to_string(),
                    machine_id: connection.machine_id.clone(),
                    device_id: connection.device_id.clone(),
                },
            )?;
            Some(
                serde_json::from_value::<RpcResponse>(
                    relay
                        .rpc(json!({
                            "request": envelope_value.clone(),
                            "auth": {
                                "timestamp": timestamp.to_string(),
                                "nonce": nonce.clone(),
                                "signature": signature.clone(),
                            },
                        }))
                        .await
                        .map_err(|error| {
                            // Classify before prefixing: the typed verdict is
                            // keyed on the relay's own exact message.
                            let mut classified =
                                crate::commands::syndicate_relay::classify_relay_error(error);
                            classified.message = format!(
                                "PacketRelay request failed without an automatic retry over SSH: {}",
                                classified.message
                            );
                            classified
                        })?,
                )
                .map_err(|_| {
                    "PacketRelay returned an invalid Syndicate controller response.".to_string()
                })?,
            )
        } else {
            None
        };

    let (response, transport) = if let Some(response) = relay_response {
        (response, "packet-relay")
    } else {
        let local_port = ensure_tunnel(&connection.server_config_id, connection.local_port).await?;
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            "x-syndicate-timestamp",
            HeaderValue::from_str(&timestamp.to_string())
                .map_err(|_| "Invalid request timestamp.")?,
        );
        headers.insert(
            "x-syndicate-nonce",
            HeaderValue::from_str(&nonce).map_err(|_| "Invalid request nonce.")?,
        );
        headers.insert(
            "x-syndicate-signature",
            HeaderValue::from_str(&signature).map_err(|_| "Invalid request signature.")?,
        );

        let response = reqwest::Client::new()
            .post(format!("{}{}", base_url(local_port), RPC_PATH))
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|error| {
                format!("Cannot reach Syndicate on the loopback forward: {}", error)
            })?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read Syndicate response: {}", error))?;
        let response = serde_json::from_slice::<RpcResponse>(&bytes).map_err(|_| {
            format!(
                "Syndicate returned an invalid controller response (HTTP {}).",
                status.as_u16()
            )
        })?;
        (response, "ssh-forward")
    };
    if response.protocol_version != PROTOCOL_VERSION || response.request_id != request_id {
        return Err("Syndicate returned a response for a different protocol request.".into());
    }
    if !response.ok {
        let error = response.error.unwrap_or(RpcError {
            code: "CONTROLLER_REJECTED".into(),
            message: Some("Syndicate rejected the controller request.".into()),
            retryable: false,
            correlation_id: None,
        });
        // The Host sends no `message`, so the readable half stays PacketBench's.
        // `code` and `retryable` are forwarded untouched: they are the
        // frontend's only sound basis for retrying or marking a grant dead.
        return Err(SyndicateCommandError {
            message: format!(
                "{}: {}{}",
                error.code,
                error
                    .message
                    .as_deref()
                    .unwrap_or("Syndicate rejected the controller request"),
                error
                    .correlation_id
                    .as_deref()
                    .map(|id| format!(" · correlation {}", id))
                    .unwrap_or_default()
            ),
            code: Some(error.code),
            retryable: Some(error.retryable),
            correlation_id: error.correlation_id,
        });
    }
    let result = response.result.unwrap_or(Value::Null);
    if method == "machine.snapshot" {
        capture_relay_grant(connection, &result)?;
    }
    Ok(SyndicateRpcResult {
        request_id,
        result,
        transport,
    })
}

#[tauri::command]
pub async fn syndicate_disable_integration() -> Result<(), SyndicateCommandError> {
    syndicate_set_integration_enabled(false).await
}

#[tauri::command]
pub async fn syndicate_set_integration_enabled(enabled: bool) -> Result<(), SyndicateCommandError> {
    if !enabled {
        SYNDICATE_INTEGRATION_ENABLED.store(false, Ordering::Release);
    }
    let _operation_guard = SYNDICATE_OPERATION_GATE.write().await;
    if enabled {
        SYNDICATE_INTEGRATION_ENABLED.store(true, Ordering::Release);
        return Ok(());
    }
    // Serialize with tunnel creation so disabling cannot race a new managed
    // forward into the registry after the drain completes.
    let _start_guard = TUNNEL_START_GATE.lock().await;
    close_tunnels().map_err(SyndicateCommandError::local)
}

#[tauri::command]
pub async fn syndicate_pair_machine(
    request: PairMachineRequest,
) -> Result<PairMachineResult, SyndicateCommandError> {
    require_integration_enabled()?;
    let _operation_guard = SYNDICATE_OPERATION_GATE.read().await;
    require_integration_enabled()?;
    let pairing = parse_pairing_payload(&request.pairing_payload)?;
    let payload = pairing.invitation;
    require_id(&request.server_config_id, "Server config id")?;
    // Credentials are keyed by Host machine in v1. Never consume another
    // invite and overwrite the only private key that can revoke its grant.
    ensure_machine_not_already_paired(&payload.machine_id)?;
    let relay_endpoint =
        select_relay_endpoint(request.relay_endpoint.as_deref(), pairing.relay_endpoint);
    if let Some(endpoint) = relay_endpoint.as_deref() {
        // Validate before consuming the single-use invitation.
        crate::commands::syndicate_relay::RelayTransport::new(
            crate::commands::syndicate_relay::RelayDeviceCredential {
                endpoint: endpoint.to_string(),
                machine_id: payload.machine_id.clone(),
                device_id: "pending-device".into(),
            },
        )?;
    }
    let ssh_server = resolve_server_config(&request.server_config_id)?;
    let local_port = ensure_tunnel(&request.server_config_id, 0).await?;
    let device_name = request.device_name.trim();
    if device_name.is_empty() || device_name.len() > 80 {
        return Err("Device name must be between 1 and 80 characters.".into());
    }
    let signing_key = SigningKey::generate(&mut OsRng);
    let signing_spki = spki_public_key(&signing_key);
    let key_agreement_secret = X25519Secret::random_from_rng(OsRng);
    let key_agreement_public = X25519PublicKey::from(&key_agreement_secret);
    let key_agreement_spki = spki_x25519_public_key(&key_agreement_public);
    let proof_nonce = random_nonce();
    let proof_payload = format!(
        "SYNDICATE-PAIR-V1\n{}\n{}\n{}\n{}\n{}\n{}",
        payload.machine_id,
        payload.invite_id,
        sha256_base64url(payload.invite_token.as_bytes()),
        proof_nonce,
        device_name,
        sha256_base64url(&key_agreement_spki)
    );
    let claim = PairClaimRequest {
        protocol_version: PROTOCOL_VERSION,
        invite_id: payload.invite_id.clone(),
        invite_token: payload.invite_token.clone(),
        device_name: device_name.to_string(),
        public_key: PairPublicKey {
            format: "spki",
            algorithm: "Ed25519",
            data_base64_url: URL_SAFE_NO_PAD.encode(&signing_spki),
        },
        key_agreement_public_key: PairPublicKey {
            format: "spki",
            algorithm: "X25519",
            data_base64_url: URL_SAFE_NO_PAD.encode(&key_agreement_spki),
        },
        proof_nonce,
        proof_signature: URL_SAFE_NO_PAD
            .encode(signing_key.sign(proof_payload.as_bytes()).to_bytes()),
    };
    let response = reqwest::Client::new()
        .post(format!("{}{}", base_url(local_port), CLAIM_PATH))
        .json(&claim)
        .send()
        .await
        .map_err(|error| format!("Cannot reach Syndicate on the loopback forward: {}", error))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|_| {
        format!(
            "Failed to read the Syndicate pairing response (HTTP {}).",
            status
        )
    })?;
    if !status.is_success() {
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("Syndicate rejected the pairing claim.");
        return Err(SyndicateCommandError::local(message));
    }
    let result: PairClaimResponse = serde_json::from_slice(&bytes).map_err(|_| {
        format!(
            "Syndicate returned an incompatible pairing response (HTTP {}).",
            status
        )
    })?;
    if result.protocol_version != PROTOCOL_VERSION || !result.approval_required {
        return Err("Syndicate returned an incompatible pairing protocol response.".into());
    }
    let device_id = result.device.device_id;
    require_id(&device_id, "Device id")?;
    if result.device.status != "pending"
        || result.device.device_name != device_name
        || !result.device.scopes.is_empty()
        || result.device.revocation_epoch != 0
        || result.device.grant_expires_at.is_some()
        || result.device.approved_at.is_some()
        || result.device.revoked_at.is_some()
        || result.device.paired_at.is_empty()
        || result.device.public_key_fingerprint != sha256_base64url(&signing_spki)
        || result.device.key_agreement_fingerprint != sha256_base64url(&key_agreement_spki)
    {
        return Err("Syndicate returned an invalid pending-device pairing result.".into());
    }

    // Persist only after the Host has consumed and accepted the invite. If the
    // keyring write fails, the claim remains pending but PacketBench cannot use
    // it; surface that explicitly so the user can revoke it in Syndicate.
    save_controller_credential(
        &payload.machine_id,
        &signing_key,
        &key_agreement_secret,
        &payload.machine_signing_public_key,
        &payload.machine_key_agreement_public_key,
    )?;
    info!(machine = %payload.machine_id, device = %device_id, "Syndicate device paired");
    Ok(PairMachineResult {
        machine_id: payload.machine_id.clone(),
        machine_name: payload.display_name.unwrap_or_else(|| {
            format!(
                "Syndicate {}",
                &payload.machine_id[..payload.machine_id.len().min(8)]
            )
        }),
        device_id,
        server_config_id: request.server_config_id,
        local_port,
        relay_endpoint,
        host_fingerprint: ssh_server.host_fingerprint,
        machine_signing_fingerprint: payload.machine_signing_fingerprint,
        machine_key_agreement_fingerprint: Some(payload.machine_key_agreement_fingerprint),
        grant_status: result.device.status,
        scopes: result.device.scopes,
    })
}

#[tauri::command]
pub async fn syndicate_machine_snapshot(
    connection: SyndicateMachineConnection,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    send_rpc(&connection, "machine.snapshot", json!({}), None).await
}

#[tauri::command]
pub async fn syndicate_workspace_list(
    connection: SyndicateMachineConnection,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    send_rpc(&connection, "workspace.list", json!({}), None).await
}

#[tauri::command]
pub async fn syndicate_workspace_create(
    request: WorkspaceCreateRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    require_id(&request.repository_id, "Repository id")?;
    let name = request.name.trim();
    if name.is_empty() || name.len() > 120 {
        return Err("Workspace display name must be between 1 and 120 characters.".into());
    }
    require_id(&request.client_operation_id, "Client operation id")?;
    send_rpc(
        &request.connection,
        "workspace.create",
        json!({ "repositoryId": request.repository_id, "name": name }),
        Some(stable_request_id(
            "workspace-create",
            &[&request.connection.machine_id, &request.client_operation_id],
        )),
    )
    .await
}

#[tauri::command]
pub async fn syndicate_pane_create(
    request: PaneCreateRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    require_id(&request.workspace_id, "Workspace id")?;
    if !matches!(
        request.profile_id.as_str(),
        "codex" | "claude" | "packetcode"
    ) {
        return Err("Profile id is not an allowed Syndicate CLI profile.".into());
    }
    let title = request.title.trim();
    if title.is_empty() || title.len() > 120 {
        return Err("Pane title must be between 1 and 120 characters.".into());
    }
    require_id(&request.client_operation_id, "Client operation id")?;
    send_rpc(
        &request.connection,
        "pane.create",
        json!({
            "workspaceId": request.workspace_id,
            "title": title,
            "profileId": request.profile_id
        }),
        Some(stable_request_id(
            "pane-create",
            &[&request.connection.machine_id, &request.client_operation_id],
        )),
    )
    .await
}

#[tauri::command]
pub async fn syndicate_session_start(
    request: SessionStartRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    require_id(&request.pane_id, "Pane id")?;
    require_id(&request.terminal_session_id, "Terminal session id")?;
    require_id(&request.profile_id, "Profile id")?;
    if !matches!(
        request.profile_id.as_str(),
        "codex" | "claude" | "packetcode"
    ) {
        return Err("Profile id is not an allowed Syndicate CLI profile.".into());
    }
    validate_terminal_size(request.cols, request.rows)?;
    send_rpc(
        &request.connection,
        "session.start",
        json!({
            "paneId": request.pane_id,
            "terminalSessionId": request.terminal_session_id,
            "profileId": request.profile_id,
            "cols": request.cols,
            "rows": request.rows
        }),
        Some(stable_request_id(
            "session-start",
            &[
                &request.connection.machine_id,
                &request.pane_id,
                &request.terminal_session_id,
            ],
        )),
    )
    .await
}

#[tauri::command]
pub async fn syndicate_session_attach(
    request: SessionAttachRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    require_id(&request.pane_id, "Pane id")?;
    require_id(&request.terminal_session_id, "Terminal session id")?;
    require_id(&request.session_id, "Session id")?;
    send_rpc(
        &request.connection,
        "session.attach",
        json!({
            "paneId": request.pane_id,
            "terminalSessionId": request.terminal_session_id,
            "sessionId": request.session_id,
            "afterSequence": request.after_sequence
        }),
        None,
    )
    .await
}

#[tauri::command]
pub async fn syndicate_events_read(
    request: EventsReadRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    let limit = request.limit.unwrap_or(500);
    if limit == 0 || limit > 1000 {
        return Err("Event read limit must be between 1 and 1000.".into());
    }
    send_rpc(
        &request.connection,
        "events.read",
        json!({ "afterSequence": request.after_sequence, "limit": limit }),
        None,
    )
    .await
}

#[tauri::command]
pub async fn syndicate_session_input(
    request: SessionInputRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    require_id(&request.session_id, "Session id")?;
    require_id(&request.frame_id, "Frame id")?;
    let decoded = URL_SAFE_NO_PAD
        .decode(&request.input_base64)
        .map_err(|_| "Terminal input is not valid base64url.".to_string())?;
    if decoded.is_empty() || decoded.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(SyndicateCommandError::local(format!(
            "Terminal input must be between 1 and {} bytes.",
            MAX_TERMINAL_INPUT_BYTES
        )));
    }
    send_rpc(
        &request.connection,
        "session.input",
        json!({
            "sessionId": request.session_id,
            "frameId": request.frame_id,
            "dataBase64": request.input_base64
        }),
        Some(request.frame_id.clone()),
    )
    .await
}

#[tauri::command]
pub async fn syndicate_session_resize(
    request: SessionResizeRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    require_id(&request.session_id, "Session id")?;
    validate_terminal_size(request.cols, request.rows)?;
    send_rpc(
        &request.connection,
        "session.resize",
        json!({ "sessionId": request.session_id, "cols": request.cols, "rows": request.rows }),
        None,
    )
    .await
}

#[tauri::command]
pub async fn syndicate_session_stop(
    request: SessionStopRequest,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    require_id(&request.session_id, "Session id")?;
    send_rpc(
        &request.connection,
        "session.stop",
        json!({ "sessionId": request.session_id }),
        Some(stable_request_id(
            "session-stop",
            &[&request.connection.machine_id, &request.session_id],
        )),
    )
    .await
}

#[tauri::command]
pub async fn syndicate_forget_machine(machine_id: String) -> Result<(), SyndicateCommandError> {
    // Deliberately ungated. This deletes a local OS-keychain record and opens
    // no transport, so gating it on the Settings switch only ever prevented a
    // user from destroying a credential they had already decided to abandon.
    let _operation_guard = SYNDICATE_OPERATION_GATE.read().await;
    delete_signing_key(&machine_id).map_err(SyndicateCommandError::local)
}

#[tauri::command]
pub async fn syndicate_revoke_self(
    connection: SyndicateMachineConnection,
) -> Result<SyndicateRpcResult, SyndicateCommandError> {
    // The Host commits revocation before replying. Callers delete the local
    // key only after this signed request succeeds (or explicitly choose local
    // forget while offline).
    //
    // This runs even while the integration is disabled: a user who flips the
    // switch on suspicion of compromise must still be able to kill the grant
    // on the Host, which is otherwise left live until it expires.
    let disabled = !SYNDICATE_INTEGRATION_ENABLED.load(Ordering::Acquire);
    let result = send_rpc_with_authority(
        &connection,
        "device.revoke_self",
        json!({}),
        Some(stable_request_id(
            "device-revoke",
            &[&connection.machine_id, &connection.device_id],
        )),
        true,
    )
    .await;
    if disabled {
        // Revoking may have had to raise a managed forward. Put the disabled
        // state back the way the user left it, whatever the outcome was.
        let _start_guard = TUNNEL_START_GATE.lock().await;
        let _ = close_tunnels();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_boundary_starts_fail_closed_before_parsing_or_key_access() {
        SYNDICATE_INTEGRATION_ENABLED.store(false, Ordering::Release);
        let pair_error = syndicate_pair_machine(PairMachineRequest {
            pairing_payload: "not-a-pairing-package".into(),
            device_name: "controller".into(),
            server_config_id: "server-1".into(),
            relay_endpoint: None,
        })
        .await
        .err()
        .expect("disabled pair should fail");
        assert_eq!(
            pair_error.message,
            "Syndicate integration is disabled in Settings."
        );
        // The kill switch is a typed verdict, not a sentence to be re-parsed.
        assert_eq!(pair_error.code.as_deref(), Some(CODE_INTEGRATION_DISABLED));
        assert_eq!(pair_error.retryable, Some(false));

        // Forgetting is local-only cleanup and must survive the kill switch:
        // it deletes an OS-keychain record and opens no transport. Blocking it
        // stranded the local half of a credential the user had already decided
        // to abandon. It now reaches the keyring, whatever that reports.
        let forget = syndicate_forget_machine("machine-1".into()).await;
        assert_ne!(
            forget.as_ref().err().and_then(|error| error.code.as_deref()),
            Some(CODE_INTEGRATION_DISABLED),
            "local forget must not be blocked by the Settings switch"
        );
    }

    #[test]
    fn host_rejections_keep_their_typed_code_and_retryability() {
        // The day-30 chain starts here: a Host answers an expired grant with
        // DEVICE_UNAUTHORIZED and retryable:false. Both must survive the trip
        // to the frontend, or it can only guess from prose.
        let response: RpcResponse = serde_json::from_value(json!({
            "protocolVersion": 1,
            "requestId": "request-1",
            "ok": false,
            "error": {
                "code": "DEVICE_UNAUTHORIZED",
                "retryable": false,
                "correlationId": "correlation-1"
            }
        }))
        .expect("typed error response parses");
        let error = response.error.expect("error is present");
        assert_eq!(error.code, "DEVICE_UNAUTHORIZED");
        assert!(!error.retryable);

        let serialized = serde_json::to_value(SyndicateCommandError {
            message: "DEVICE_UNAUTHORIZED: Syndicate rejected the controller request".into(),
            code: Some(error.code),
            retryable: Some(error.retryable),
            correlation_id: error.correlation_id,
        })
        .expect("command error serializes");
        assert_eq!(serialized["code"], json!("DEVICE_UNAUTHORIZED"));
        assert_eq!(serialized["retryable"], json!(false));
        assert_eq!(serialized["correlationId"], json!("correlation-1"));
    }

    #[test]
    fn local_failures_carry_no_host_verdict() {
        // Absence must read as "no verdict", never as "not retryable": a
        // socket fault has to stay reconnectable.
        let error = SyndicateCommandError::local("Cannot reach Syndicate on the loopback forward.");
        assert!(error.code.is_none());
        assert!(error.retryable.is_none());
        let serialized = serde_json::to_value(&error).expect("local error serializes");
        assert!(serialized.get("code").is_none());
        assert!(serialized.get("retryable").is_none());
    }

    #[test]
    fn claim_response_tolerates_fields_the_spec_does_not_pin() {
        // CONTROLLER_PROTOCOL_V1 does not freeze the claim response, so an
        // additive Host change must not break pairing on shipped builds.
        let claim: PairClaimResponse = serde_json::from_value(json!({
            "protocolVersion": 1,
            "approvalRequired": true,
            "device": {
                "deviceId": "device-1",
                "deviceName": "PacketBench controller",
                "status": "pending",
                "scopes": [],
                "revocationEpoch": 0,
                "pairedAt": "2026-08-14T00:00:00.000Z",
                "publicKeyFingerprint": "fingerprint-1",
                "keyAgreementFingerprint": "fingerprint-2",
                "someFieldAddedLater": "ignored"
            },
            "somethingElseAddedLater": {"nested": true}
        }))
        .expect("unknown claim fields are ignored");
        assert_eq!(claim.device.device_id, "device-1");
        assert!(claim.approval_required);
    }

    #[test]
    fn pairing_payload_accepts_only_v1_and_known_fields() {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let signing_der = spki_public_key(&signing);
        let agreement = X25519PublicKey::from(&X25519Secret::from([8_u8; 32]));
        let agreement_der = spki_x25519_public_key(&agreement);
        let invitation = json!({
            "protocolVersion": 1,
            "invitation": {
                "machineId": "machine-1",
                "inviteId": "invite-1",
                "inviteToken": "abcdefghijklmnopqrstuvwxyz123456",
                "machineSigningPublicKey": URL_SAFE_NO_PAD.encode(&signing_der),
                "machineSigningFingerprint": sha256_base64url(&signing_der),
                "machineKeyAgreementPublicKey": URL_SAFE_NO_PAD.encode(&agreement_der),
                "machineKeyAgreementFingerprint": sha256_base64url(&agreement_der),
                "displayName": "Test host",
                "requestedScopes": ["machine.read"],
                "expiresAt": "2099-01-01T00:00:00Z"
            }
        });
        let parsed = parse_pairing_payload(&invitation.to_string()).unwrap();
        assert_eq!(parsed.invitation.machine_id, "machine-1");
        assert_eq!(parsed.relay_endpoint, None);
        let mut wrong_version = invitation.clone();
        wrong_version["protocolVersion"] = json!(2);
        assert!(parse_pairing_payload(&wrong_version.to_string()).is_err());
        let mut arbitrary_endpoint = invitation;
        arbitrary_endpoint["invitation"]["endpoint"] = json!("https://evil.test");
        assert!(parse_pairing_payload(&arbitrary_endpoint.to_string()).is_err());
    }

    // FROZEN FIXTURE — DO NOT EDIT, DO NOT RENAME-SWEEP.
    //
    // `tests/fixtures/controller-pairing-invitation-v1.json` and
    // `tests/fixtures/controller-relay-crypto-v1.json` are byte-identical to
    // Syndicate's `docs/fixtures/` copies by design, and both repos load them
    // as cross-language conformance vectors. Their value is the byte-identity,
    // not the accuracy of the strings inside: the literal
    // `"displayName": "PacketBench controller"` must survive the PacketBench
    // rename, and the `relayEndpoint` must survive the relay moving hosts.
    // Exclude both files from any rename or find-and-replace tooling.
    #[test]
    fn shared_pairing_fixture_matches_the_nested_v1_envelope() {
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/controller-pairing-invitation-v1.json"
        ))
        .unwrap();
        fixture["invitation"]["expiresAt"] = json!((time::OffsetDateTime::now_utc()
            + time::Duration::hours(1))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap());
        let parsed = parse_pairing_payload(&fixture.to_string()).unwrap();
        assert_eq!(
            parsed.invitation.machine_id,
            "syn_mVg8QGZJ3X9oz6KGy5Qa6nNa6gqQ3AFvGomgrIExJ2Y"
        );
        assert_eq!(
            parsed.relay_endpoint.as_deref(),
            Some("wss://packet-relay-1038865114903.us-central1.run.app/v1/product-route")
        );
    }

    #[test]
    fn pairing_package_rejects_an_unsafe_relay_before_claim() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/controller-pairing-invitation-v1.json"
        ))
        .unwrap();
        let mut unsafe_endpoint = fixture.clone();
        unsafe_endpoint["relayEndpoint"] = json!("ws://relay.example.test/v1/product-route");
        assert!(parse_pairing_payload(&unsafe_endpoint.to_string()).is_err());
        let mut query = fixture;
        query["relayEndpoint"] = json!("wss://relay.example.test/v1/product-route?token=secret");
        assert!(parse_pairing_payload(&query.to_string()).is_err());
    }

    #[test]
    fn explicit_relay_endpoint_wins_over_the_pairing_package() {
        assert_eq!(
            select_relay_endpoint(
                Some("  wss://override.example/v1/product-route  "),
                Some("wss://package.example/v1/product-route".into()),
            )
            .as_deref(),
            Some("wss://override.example/v1/product-route")
        );
        assert_eq!(
            select_relay_endpoint(
                Some("  "),
                Some("wss://package.example/v1/product-route".into()),
            )
            .as_deref(),
            Some("wss://package.example/v1/product-route")
        );
    }

    #[test]
    fn spki_encoding_has_rfc8410_prefix_and_key() {
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let spki = spki_public_key(&key);
        assert_eq!(spki.len(), 44);
        assert_eq!(&spki[12..], key.verifying_key().as_bytes());
    }

    #[test]
    fn canonical_json_sorts_recursively_and_rejects_floats() {
        let value = json!({ "z": 1, "a": { "y": true, "b": [3, 2] } });
        assert_eq!(
            canonical_json(&value).unwrap(),
            r#"{"a":{"b":[3,2],"y":true},"z":1}"#
        );
        assert!(canonical_json(&json!({ "float": 1.5 })).is_err());
    }

    #[test]
    fn rejects_ids_and_terminal_bounds_before_network() {
        assert!(require_id("../../secret", "id").is_err());
        assert!(require_id("machine_OK-1.2", "id").is_ok());
        assert!(validate_terminal_size(1, 24).is_err());
        assert!(validate_terminal_size(80, 24).is_ok());
    }

    #[test]
    fn relay_selection_bootstraps_over_ssh_then_stays_on_relay() {
        assert!(!use_relay_transport(
            Some("wss://relay.example/v1/product-route"),
            false,
        ));
        assert!(use_relay_transport(
            Some("wss://relay.example/v1/product-route"),
            true,
        ));
        assert!(!use_relay_transport(None, true));
    }

    #[test]
    fn rpc_result_serializes_packetbench_carrier_separately() {
        let relay = serde_json::to_value(SyndicateRpcResult {
            request_id: "request-1".into(),
            result: json!({"ok": true}),
            transport: "packet-relay",
        })
        .unwrap();
        assert_eq!(relay["transport"], "packet-relay");
        assert_eq!(relay["requestId"], "request-1");

        let ssh = serde_json::to_value(SyndicateRpcResult {
            request_id: "request-2".into(),
            result: Value::Null,
            transport: "ssh-forward",
        })
        .unwrap();
        assert_eq!(ssh["transport"], "ssh-forward");
    }

    #[test]
    fn tunnel_args_pin_loopback_and_disable_forwarded_authority() {
        let config = SshConfig {
            host: "server.example".into(),
            port: 22,
            user: "operator".into(),
            remote_path: String::new(),
            key_path: Some("id_ed25519".into()),
            auth_method: Some("key".into()),
            target_id: Some("server-1".into()),
            host_fingerprint: Some("SHA256:fixture".into()),
        };
        let args = tunnel_ssh_args(&config, 54321, false);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "StrictHostKeyChecking=yes"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ForwardAgent=no"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ControlMaster=no"]));
        assert_eq!(
            &args[..6],
            [
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-o",
                "ControlPersist=no"
            ]
        );
        assert!(!args.iter().any(|argument| argument == "ControlMaster=auto"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-L", "127.0.0.1:54321:127.0.0.1:4317"]));
        assert_eq!(
            args.last().map(String::as_str),
            Some("operator@server.example")
        );
    }

    #[test]
    fn operation_ids_distinguish_equal_panes_and_stabilize_retries() {
        let retry_a = stable_request_id("pane-create", &["machine-1", "local-pane-a"]);
        let retry_b = stable_request_id("pane-create", &["machine-1", "local-pane-a"]);
        let separate = stable_request_id("pane-create", &["machine-1", "local-pane-b"]);
        assert_eq!(retry_a, retry_b);
        assert_ne!(retry_a, separate);
    }
}

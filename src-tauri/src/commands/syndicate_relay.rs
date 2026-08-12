//! PacketRelay transport for the native Syndicate controller protocol.
//!
//! This module owns only the versioned WSS/device-crypto boundary. Typed
//! controller operations remain in `syndicate.rs`; callers pass the exact
//! already-signed `{request,auth}` envelope and receive the typed Host response.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures::{SinkExt, StreamExt};
use hkdf::Hkdf;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519Secret};

use super::syndicate::{
    canonical_json, commit_relay_receive_counter, reserve_relay_send_counter,
    StoredControllerCredential,
};

const PROTOCOL_VERSION: u8 = 1;
const ROUTE_PATH: &str = "/v1/product-route";
const MAX_FRAME_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
// PacketRelay admits one socket per device. Holding a per-device gate for the
// complete exchange also preserves durable receive-counter ordering.
fn relay_rpc_gate(machine_id: &str, device_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let gates = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut gates = gates
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if gates.len() > 128 {
        gates.retain(|_, gate| gate.strong_count() > 0);
    }
    let key = format!("{}\0{}", machine_id, device_id);
    if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    gates.insert(key, Arc::downgrade(&gate));
    gate
}
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const X25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
];
const CONTROLLER_SCOPES: &[&str] = &[
    "machine.read",
    "session.start",
    "terminal.input",
    "terminal.resize",
    "terminal.stop",
    "terminal.view",
    "workspace.create",
    "workspace.read",
];

#[derive(Debug, Clone)]
pub struct RelayDeviceCredential {
    pub endpoint: String,
    pub machine_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone)]
pub struct RelayTransport {
    credential: RelayDeviceCredential,
}

impl RelayTransport {
    pub fn new(credential: RelayDeviceCredential) -> Result<Self, String> {
        validate_endpoint(&credential.endpoint)?;
        valid_id(&credential.machine_id, "Machine id")?;
        valid_id(&credential.device_id, "Device id")?;
        Ok(Self { credential })
    }

    /// Send one canonical signed controller envelope. Delivery failures are not
    /// automatically retried: its auth nonce cannot be reused, and the Host may
    /// already have executed a request whose response was lost.
    pub async fn rpc(&self, envelope: Value) -> Result<Value, String> {
        let gate = relay_rpc_gate(&self.credential.machine_id, &self.credential.device_id);
        let _gate = gate.lock().await;
        let request_id = envelope
            .pointer("/request/requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "Syndicate relay RPC envelope is missing request.requestId.".to_string()
            })?
            .to_owned();
        self.rpc_once(&envelope, &request_id).await
    }

    async fn rpc_once(&self, envelope: &Value, request_id: &str) -> Result<Value, String> {
        let (stored, counter) = reserve_relay_send_counter(&self.credential.machine_id)?;
        let material = validate_material(&self.credential, &stored)?;
        let (response, receive_counter) = self
            .exchange(envelope, request_id, &material, counter)
            .await?;
        // Persist before the authenticated plaintext is accepted by the typed
        // controller layer.
        commit_relay_receive_counter(&self.credential.machine_id, receive_counter)?;
        Ok(response)
    }

    async fn exchange(
        &self,
        envelope: &Value,
        request_id: &str,
        material: &ValidatedMaterial,
        counter: u64,
    ) -> Result<(Value, u64), String> {
        let timestamp_ms = epoch_ms()?;
        let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>());
        let grant_hash =
            URL_SAFE_NO_PAD.encode(Sha256::digest(material.canonical_grant.as_bytes()));
        let proof = format!(
            "SYNDICATE-RELAY-DEVICE-HELLO-V1\n{}\n{}\n{}\n{}\n{}",
            material.grant.route_id, material.grant.device_id, timestamp_ms, nonce, grant_hash
        );
        let hello = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "type": "device_hello",
            "grant": material.grant_value,
            "grantSignatureBase64Url": material.grant_signature,
            "timestampMs": timestamp_ms,
            "nonceBase64Url": nonce,
            "proofSignatureBase64Url": URL_SAFE_NO_PAD.encode(material.device_signing.sign(proof.as_bytes()).to_bytes()),
        });
        let frame = encrypt_controller_frame(&material, &self.credential, counter, envelope)?;

        let ws_config = WebSocketConfig::default()
            .read_buffer_size(8 * 1024)
            .write_buffer_size(8 * 1024)
            .max_write_buffer_size(MAX_FRAME_BYTES + 8 * 1024)
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));
        let (stream, _) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            connect_async_with_config(&self.credential.endpoint, Some(ws_config), false),
        )
        .await
        .map_err(|_| "PacketRelay connection timed out.".to_string())?
        .map_err(|error| format!("Cannot connect to PacketRelay: {}", error))?;
        let (mut sink, mut source) = stream.split();
        send_bounded(&mut sink, &hello).await?;
        let ready = next_text(&mut source, CONNECT_TIMEOUT).await?;
        if ready.get("protocolVersion") != Some(&json!(1))
            || ready.get("type").and_then(Value::as_str) != Some("routeReady")
            || ready.get("routeId").and_then(Value::as_str) != Some(&material.grant.route_id)
        {
            return Err("PacketRelay rejected or mismatched the device route.".into());
        }
        send_bounded(
            &mut sink,
            &serde_json::to_value(&frame).map_err(|error| error.to_string())?,
        )
        .await?;

        let deadline = tokio::time::Instant::now() + RESPONSE_TIMEOUT;
        let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
        keepalive.tick().await;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return Err("PacketRelay response timed out.".into()),
                _ = keepalive.tick() => {
                    send_bounded(&mut sink, &json!({"protocolVersion":1,"type":"ping"})).await?;
                }
                incoming = source.next() => {
                    let message = incoming.ok_or_else(|| "PacketRelay closed before the response arrived.".to_string())?
                        .map_err(|error| format!("PacketRelay response failed: {}", error))?;
                    let Message::Text(text) = message else {
                        if matches!(message, Message::Close(_)) {
                            return Err("PacketRelay closed before the response arrived.".into());
                        }
                        continue;
                    };
                    if text.len() > MAX_FRAME_BYTES {
                        return Err("PacketRelay response exceeded 64 KiB.".into());
                    }
                    let routed: Value = serde_json::from_str(&text)
                        .map_err(|_| "PacketRelay returned malformed JSON.".to_string())?;
                    if routed.get("type").and_then(Value::as_str) == Some("pong") {
                        continue;
                    }
                    if routed.get("type").and_then(Value::as_str) == Some("routeRevoked") {
                        return Err("This PacketADE device was revoked by Syndicate.".into());
                    }
                    if time::OffsetDateTime::now_utc() >= material.expires_at {
                        return Err("The Syndicate relay grant expired while awaiting the Host response.".into());
                    }
                    let response = decrypt_host_frame(&material, &self.credential, &routed)?;
                    let response_id = response.get("requestId").and_then(Value::as_str)
                        .ok_or_else(|| "Syndicate relay response omitted requestId.".to_string())?;
                    if response_id != request_id {
                        return Err("Syndicate relay response correlation did not match the request.".into());
                    }
                    let receive_counter = routed.pointer("/frame/counter").and_then(Value::as_u64)
                        .ok_or_else(|| "Syndicate relay response counter is invalid.".to_string())?;
                    let _ = sink.send(Message::Close(None)).await;
                    return Ok((response, receive_counter));
                }
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceGrant {
    protocol_version: u8,
    #[serde(rename = "type")]
    kind: String,
    route_id: String,
    machine_id: String,
    device_id: String,
    host_signing_public_key_base64_url: String,
    host_key_agreement_public_key_base64_url: String,
    device_signing_public_key_base64_url: String,
    device_key_agreement_public_key_base64_url: String,
    scopes: Vec<String>,
    issued_at: String,
    expires_at: String,
    revocation_epoch: u64,
}

struct ValidatedMaterial {
    grant: DeviceGrant,
    grant_value: Value,
    canonical_grant: String,
    grant_signature: String,
    device_signing: SigningKey,
    host_signing: VerifyingKey,
    directional_controller_key: [u8; 32],
    directional_host_key: [u8; 32],
    expires_at: time::OffsetDateTime,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptedFrame {
    protocol_version: u8,
    #[serde(rename = "type")]
    kind: String,
    route_id: String,
    machine_id: String,
    device_id: String,
    direction: String,
    counter: u64,
    nonce_base64_url: String,
    ciphertext_base64_url: String,
    signature_base64_url: String,
}

fn validate_material(
    expected: &RelayDeviceCredential,
    stored: &StoredControllerCredential,
) -> Result<ValidatedMaterial, String> {
    let grant_json = stored
        .relay_grant_json
        .as_deref()
        .ok_or_else(|| "Syndicate has not issued this device a relay grant yet.".to_string())?;
    let grant_signature = stored
        .relay_grant_signature_base64_url
        .clone()
        .ok_or_else(|| "The stored Syndicate relay grant has no signature.".to_string())?;
    let grant_value: Value = serde_json::from_str(grant_json)
        .map_err(|_| "The stored Syndicate relay grant is corrupt.".to_string())?;
    let grant: DeviceGrant = serde_json::from_value(grant_value.clone())
        .map_err(|_| "The stored Syndicate relay grant has an incompatible shape.".to_string())?;
    let canonical_grant = canonical_json(&grant_value)?;
    if canonical_grant != grant_json {
        return Err("The stored Syndicate relay grant is not canonical.".into());
    }
    if grant.protocol_version != PROTOCOL_VERSION
        || grant.kind != "device_grant"
        || grant.machine_id != expected.machine_id
        || grant.device_id != expected.device_id
        || grant.revocation_epoch > i64::MAX as u64
    {
        return Err("The Syndicate relay grant does not match this machine/device.".into());
    }
    let issued = parse_time(&grant.issued_at)?;
    let expires = parse_time(&grant.expires_at)?;
    let now = time::OffsetDateTime::now_utc();
    if issued > now + time::Duration::minutes(1)
        || expires <= now
        || expires <= issued
        || expires - issued > time::Duration::days(31)
    {
        return Err("The Syndicate relay grant is expired or has an invalid lifetime.".into());
    }
    if grant.scopes.is_empty()
        || grant.scopes.len() > CONTROLLER_SCOPES.len()
        || grant.scopes.windows(2).any(|pair| pair[0] >= pair[1])
        || grant
            .scopes
            .iter()
            .any(|scope| !CONTROLLER_SCOPES.contains(&scope.as_str()))
    {
        return Err("The Syndicate relay grant contains invalid scopes.".into());
    }
    if grant.host_signing_public_key_base64_url != stored.host_signing_public_key_base64_url
        || grant.host_key_agreement_public_key_base64_url
            != stored.host_key_agreement_public_key_base64_url
    {
        return Err("The Syndicate relay grant does not match the pinned Host keys.".into());
    }
    let host_signing_raw = decode_spki(
        &grant.host_signing_public_key_base64_url,
        &ED25519_SPKI_PREFIX,
        "Host signing key",
    )?;
    let expected_route = format!(
        "route_{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(
            URL_SAFE_NO_PAD
                .decode(&grant.host_signing_public_key_base64_url)
                .map_err(|_| "The Host signing key is invalid.".to_string())?
        ))
    );
    if grant.route_id != expected_route {
        return Err("The Syndicate relay route is not self-certifying.".into());
    }
    let host_signing = VerifyingKey::from_bytes(&host_signing_raw)
        .map_err(|_| "The Host signing key is invalid.".to_string())?;
    verify_signature(
        &host_signing,
        format!("SYNDICATE-RELAY-GRANT-V1\n{}", canonical_grant).as_bytes(),
        &grant_signature,
        "relay grant",
    )?;
    let device_signing_bytes = decode_32(
        &stored.signing_private_key_base64_url,
        "PacketADE signing private key",
    )?;
    let device_signing = SigningKey::from_bytes(&device_signing_bytes);
    if URL_SAFE_NO_PAD.encode(ed25519_spki(device_signing.verifying_key().as_bytes()))
        != grant.device_signing_public_key_base64_url
    {
        return Err("The relay grant does not match the PacketADE signing key.".into());
    }
    let device_agreement_bytes = decode_32(
        &stored.key_agreement_private_key_base64_url,
        "PacketADE key agreement private key",
    )?;
    let device_secret = X25519Secret::from(device_agreement_bytes);
    let device_public = X25519PublicKey::from(&device_secret);
    if URL_SAFE_NO_PAD.encode(x25519_spki(device_public.as_bytes()))
        != grant.device_key_agreement_public_key_base64_url
    {
        return Err("The relay grant does not match the PacketADE agreement key.".into());
    }
    let host_agreement = X25519PublicKey::from(decode_spki(
        &grant.host_key_agreement_public_key_base64_url,
        &X25519_SPKI_PREFIX,
        "Host key agreement key",
    )?);
    let shared = device_secret.diffie_hellman(&host_agreement);
    Ok(ValidatedMaterial {
        directional_controller_key: derive_key(
            shared.as_bytes(),
            &grant.machine_id,
            &grant.device_id,
            "controller-to-host",
        )?,
        directional_host_key: derive_key(
            shared.as_bytes(),
            &grant.machine_id,
            &grant.device_id,
            "host-to-controller",
        )?,
        grant,
        grant_value,
        canonical_grant,
        grant_signature,
        device_signing,
        host_signing,
        expires_at: expires,
    })
}

fn encrypt_controller_frame(
    material: &ValidatedMaterial,
    credential: &RelayDeviceCredential,
    counter: u64,
    envelope: &Value,
) -> Result<EncryptedFrame, String> {
    let nonce = relay_nonce("controller-to-host", counter)?;
    let metadata = json!({
        "protocolVersion": 1, "type": "encrypted", "routeId": material.grant.route_id,
        "machineId": credential.machine_id, "deviceId": credential.device_id,
        "direction": "controller-to-host", "counter": counter,
        "nonceBase64Url": URL_SAFE_NO_PAD.encode(nonce),
    });
    let cipher = Aes256Gcm::new_from_slice(&material.directional_controller_key)
        .map_err(|_| "Failed to initialize Syndicate relay encryption.".to_string())?;
    let plaintext = canonical_json(envelope)?;
    let aad = canonical_json(&metadata)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "Failed to encrypt the Syndicate relay request.".to_string())?;
    let mut signed = metadata;
    signed["ciphertextBase64Url"] = json!(URL_SAFE_NO_PAD.encode(ciphertext));
    let signature = material
        .device_signing
        .sign(format!("SYNDICATE-RELAY-FRAME-V1\n{}", canonical_json(&signed)?).as_bytes());
    signed["signatureBase64Url"] = json!(URL_SAFE_NO_PAD.encode(signature.to_bytes()));
    serde_json::from_value(signed)
        .map_err(|_| "Failed to encode the Syndicate relay request frame.".to_string())
}

fn decrypt_host_frame(
    material: &ValidatedMaterial,
    expected: &RelayDeviceCredential,
    routed: &Value,
) -> Result<Value, String> {
    if routed.get("protocolVersion") != Some(&json!(1))
        || routed.get("type").and_then(Value::as_str) != Some("routedEncrypted")
        || routed.get("routeId").and_then(Value::as_str) != Some(&material.grant.route_id)
        || routed.pointer("/sender/role").and_then(Value::as_str) != Some("host")
        || routed.pointer("/sender/machineId").and_then(Value::as_str)
            != Some(expected.machine_id.as_str())
        || routed.pointer("/sender/deviceId").and_then(Value::as_str) != Some("host")
    {
        return Err("PacketRelay response sender stamp is invalid.".into());
    }
    let frame_value = routed
        .get("frame")
        .cloned()
        .ok_or_else(|| "PacketRelay response has no encrypted frame.".to_string())?;
    let frame: EncryptedFrame = serde_json::from_value(frame_value.clone())
        .map_err(|_| "PacketRelay response frame has an incompatible shape.".to_string())?;
    if frame.protocol_version != 1
        || frame.kind != "encrypted"
        || frame.route_id != material.grant.route_id
        || frame.machine_id != expected.machine_id
        || frame.device_id != expected.device_id
        || frame.direction != "host-to-controller"
        || frame.counter == 0
    {
        return Err("PacketRelay response frame identity is invalid.".into());
    }
    let mut signed = frame_value;
    let signature_encoded = signed
        .as_object_mut()
        .and_then(|object| object.remove("signatureBase64Url"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| "PacketRelay response signature is missing.".to_string())?;
    verify_signature(
        &material.host_signing,
        format!("SYNDICATE-RELAY-FRAME-V1\n{}", canonical_json(&signed)?).as_bytes(),
        &signature_encoded,
        "Host response frame",
    )?;
    let nonce = relay_nonce(&frame.direction, frame.counter)?;
    if URL_SAFE_NO_PAD.encode(nonce) != frame.nonce_base64_url {
        return Err("PacketRelay response nonce does not match its counter.".into());
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&frame.ciphertext_base64_url)
        .map_err(|_| "PacketRelay response ciphertext is not base64url.".to_string())?;
    if ciphertext.len() < 17 || ciphertext.len() > MAX_FRAME_BYTES {
        return Err("PacketRelay response ciphertext is outside its bounds.".into());
    }
    let mut metadata = signed;
    metadata
        .as_object_mut()
        .ok_or_else(|| "PacketRelay response metadata is invalid.".to_string())?
        .remove("ciphertextBase64Url");
    let cipher = Aes256Gcm::new_from_slice(&material.directional_host_key)
        .map_err(|_| "Failed to initialize Syndicate relay decryption.".to_string())?;
    let aad = canonical_json(&metadata)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "PacketRelay Host response authentication failed.".to_string())?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| "PacketRelay Host response plaintext is not valid JSON.".to_string())
}

async fn send_bounded<S>(sink: &mut S, value: &Value) -> Result<(), String>
where
    S: futures::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let text = canonical_json(value)?;
    if text.len() > MAX_FRAME_BYTES {
        return Err("PacketRelay request exceeded 64 KiB.".into());
    }
    sink.send(Message::Text(text.into()))
        .await
        .map_err(|error| format!("PacketRelay send failed: {}", error))
}

async fn next_text<S>(source: &mut S, timeout: Duration) -> Result<Value, String>
where
    S: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let message = tokio::time::timeout(timeout, source.next())
        .await
        .map_err(|_| "PacketRelay response timed out.".to_string())?
        .ok_or_else(|| "PacketRelay closed the route.".to_string())?
        .map_err(|error| format!("PacketRelay response failed: {}", error))?;
    let Message::Text(text) = message else {
        return Err("PacketRelay returned a non-text protocol frame.".into());
    };
    if text.len() > MAX_FRAME_BYTES {
        return Err("PacketRelay response exceeded 64 KiB.".into());
    }
    serde_json::from_str(&text).map_err(|_| "PacketRelay returned malformed JSON.".to_string())
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let url = Url::parse(endpoint).map_err(|_| "PacketRelay endpoint is invalid.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("PacketRelay endpoint must not contain user credentials.".into());
    }
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "wss" && !(url.scheme() == "ws" && loopback) {
        return Err("PacketRelay requires WSS (plain WS is loopback-only).".into());
    }
    if url.path() != ROUTE_PATH || url.query().is_some() || url.fragment().is_some() {
        return Err("PacketRelay endpoint must be the exact /v1/product-route URL.".into());
    }
    Ok(())
}

fn valid_id(value: &str, label: &str) -> Result<(), String> {
    if !(8..=200).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("{} is invalid.", label));
    }
    Ok(())
}

fn epoch_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "System clock is before the Unix epoch.".to_string())
}

fn parse_time(value: &str) -> Result<time::OffsetDateTime, String> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map_err(|_| "The Syndicate relay grant timestamp is invalid.".to_string())
}

fn decode_32(value: &str, label: &str) -> Result<[u8; 32], String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("{} is not base64url.", label))?
        .try_into()
        .map_err(|_| format!("{} has an invalid length.", label))
}

fn decode_spki(value: &str, prefix: &[u8; 12], label: &str) -> Result<[u8; 32], String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("{} is not base64url.", label))?;
    if bytes.len() != 44 || bytes[..12] != *prefix {
        return Err(format!("{} is not the required RFC 8410 SPKI key.", label));
    }
    bytes[12..]
        .try_into()
        .map_err(|_| format!("{} has an invalid length.", label))
}

fn verify_signature(
    key: &VerifyingKey,
    payload: &[u8],
    signature: &str,
    label: &str,
) -> Result<(), String> {
    let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| format!("The {} signature is not base64url.", label))?
        .try_into()
        .map_err(|_| format!("The {} signature has an invalid length.", label))?;
    key.verify(payload, &Signature::from_bytes(&signature_bytes))
        .map_err(|_| format!("The {} signature is invalid.", label))
}

fn derive_key(
    shared: &[u8; 32],
    machine_id: &str,
    device_id: &str,
    direction: &str,
) -> Result<[u8; 32], String> {
    let salt = Sha256::digest(format!("SYNDICATE-RELAY-V1\n{}\n{}", machine_id, device_id));
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut key = [0_u8; 32];
    hkdf.expand(
        format!("syndicate-relay-aead-v1\0{}", direction).as_bytes(),
        &mut key,
    )
    .map_err(|_| "Syndicate relay key derivation failed.".to_string())?;
    Ok(key)
}

fn relay_nonce(direction: &str, counter: u64) -> Result<[u8; 12], String> {
    if counter == 0 {
        return Err("Syndicate relay counter must be positive.".into());
    }
    let mut nonce = [0_u8; 12];
    nonce[..4].copy_from_slice(match direction {
        "controller-to-host" => b"CTH1",
        "host-to-controller" => b"HTC1",
        _ => return Err("Syndicate relay direction is invalid.".into()),
    });
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    Ok(nonce)
}

fn ed25519_spki(raw: &[u8; 32]) -> Vec<u8> {
    [ED25519_SPKI_PREFIX.as_slice(), raw].concat()
}

fn x25519_spki(raw: &[u8; 32]) -> Vec<u8> {
    [X25519_SPKI_PREFIX.as_slice(), raw].concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    #[test]
    fn endpoint_policy_requires_versioned_wss_or_loopback() {
        assert!(validate_endpoint("wss://relay.example.test/v1/product-route").is_ok());
        assert!(validate_endpoint("ws://127.0.0.1:8080/v1/product-route").is_ok());
        assert!(validate_endpoint("ws://relay.example.test/v1/product-route").is_err());
        assert!(validate_endpoint("wss://relay.example.test/legacy").is_err());
        assert!(
            validate_endpoint("wss://relay.example.test/v1/product-route?token=secret").is_err()
        );
        assert!(
            validate_endpoint("wss://user:secret@relay.example.test/v1/product-route").is_err()
        );
    }

    #[tokio::test]
    async fn relay_exchange_gate_serializes_each_device_without_blocking_others() {
        let first = relay_rpc_gate("machine-one", "device-one");
        let held = first.lock().await;
        let same = relay_rpc_gate("machine-one", "device-one");
        assert!(tokio::time::timeout(Duration::from_millis(20), same.lock())
            .await
            .is_err());
        let other = relay_rpc_gate("machine-two", "device-two");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), other.lock())
                .await
                .is_ok()
        );
        drop(held);
        assert!(tokio::time::timeout(Duration::from_millis(20), same.lock())
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn ephemeral_relay_exchanges_authenticated_ciphertext() {
        let machine_id = "machine-e2e";
        let device_id = "device-e2e";
        let host_signing = SigningKey::from_bytes(&[41_u8; 32]);
        let device_signing = SigningKey::from_bytes(&[42_u8; 32]);
        let host_secret = X25519Secret::from([43_u8; 32]);
        let device_secret = X25519Secret::from([44_u8; 32]);
        let host_agreement = X25519PublicKey::from(&host_secret);
        let device_agreement = X25519PublicKey::from(&device_secret);
        let host_signing_spki =
            URL_SAFE_NO_PAD.encode(ed25519_spki(host_signing.verifying_key().as_bytes()));
        let host_agreement_spki = URL_SAFE_NO_PAD.encode(x25519_spki(host_agreement.as_bytes()));
        let device_signing_spki =
            URL_SAFE_NO_PAD.encode(ed25519_spki(device_signing.verifying_key().as_bytes()));
        let device_agreement_spki =
            URL_SAFE_NO_PAD.encode(x25519_spki(device_agreement.as_bytes()));
        let route_id = format!(
            "route_{}",
            URL_SAFE_NO_PAD.encode(Sha256::digest(
                URL_SAFE_NO_PAD.decode(&host_signing_spki).unwrap()
            ))
        );
        let now = time::OffsetDateTime::now_utc();
        let grant_value = json!({
            "protocolVersion": 1,
            "type": "device_grant",
            "routeId": route_id,
            "machineId": machine_id,
            "deviceId": device_id,
            "hostSigningPublicKeyBase64Url": host_signing_spki,
            "hostKeyAgreementPublicKeyBase64Url": host_agreement_spki,
            "deviceSigningPublicKeyBase64Url": device_signing_spki,
            "deviceKeyAgreementPublicKeyBase64Url": device_agreement_spki,
            "scopes": ["machine.read"],
            "issuedAt": (now - time::Duration::minutes(1)).format(&time::format_description::well_known::Rfc3339).unwrap(),
            "expiresAt": (now + time::Duration::hours(1)).format(&time::format_description::well_known::Rfc3339).unwrap(),
            "revocationEpoch": 0,
        });
        let grant_json = canonical_json(&grant_value).unwrap();
        let grant_signature = URL_SAFE_NO_PAD.encode(
            host_signing
                .sign(format!("SYNDICATE-RELAY-GRANT-V1\n{}", grant_json).as_bytes())
                .to_bytes(),
        );
        let stored: StoredControllerCredential = serde_json::from_value(json!({
            "version": 1,
            "signingPrivateKeyBase64Url": URL_SAFE_NO_PAD.encode(device_signing.to_bytes()),
            "keyAgreementPrivateKeyBase64Url": URL_SAFE_NO_PAD.encode(device_secret.to_bytes()),
            "hostSigningPublicKeyBase64Url": grant_value["hostSigningPublicKeyBase64Url"],
            "hostKeyAgreementPublicKeyBase64Url": grant_value["hostKeyAgreementPublicKeyBase64Url"],
            "relayGrantJson": grant_json,
            "relayGrantSignatureBase64Url": grant_signature,
            "relaySendCounter": 0,
            "relayReceiveCounter": 0,
        }))
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/v1/product-route", listener.local_addr().unwrap());
        let credential = RelayDeviceCredential {
            endpoint,
            machine_id: machine_id.into(),
            device_id: device_id.into(),
        };
        let material = validate_material(&credential, &stored).unwrap();
        let host_key = derive_key(
            host_secret.diffie_hellman(&device_agreement).as_bytes(),
            machine_id,
            device_id,
            "host-to-controller",
        )
        .unwrap();
        let route_for_server = material.grant.route_id.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            let hello: Value = serde_json::from_str(
                socket
                    .next()
                    .await
                    .unwrap()
                    .unwrap()
                    .into_text()
                    .unwrap()
                    .as_str(),
            )
            .unwrap();
            assert_eq!(hello["type"], "device_hello");
            socket
                .send(Message::Text(
                    canonical_json(&json!({
                        "protocolVersion": 1,
                        "type": "routeReady",
                        "routeId": route_for_server,
                    }))
                    .unwrap()
                    .into(),
                ))
                .await
                .unwrap();
            let request: Value = serde_json::from_str(
                socket
                    .next()
                    .await
                    .unwrap()
                    .unwrap()
                    .into_text()
                    .unwrap()
                    .as_str(),
            )
            .unwrap();
            assert_eq!(request["direction"], "controller-to-host");
            assert_eq!(request["counter"], 1);

            let response = json!({
                "protocolVersion": 1,
                "requestId": "request-e2e",
                "ok": true,
                "result": {"machineId": machine_id},
            });
            let nonce = relay_nonce("host-to-controller", 1).unwrap();
            let metadata = json!({
                "protocolVersion": 1,
                "type": "encrypted",
                "routeId": route_for_server,
                "machineId": machine_id,
                "deviceId": device_id,
                "direction": "host-to-controller",
                "counter": 1,
                "nonceBase64Url": URL_SAFE_NO_PAD.encode(nonce),
            });
            let plaintext = canonical_json(&response).unwrap();
            let aad = canonical_json(&metadata).unwrap();
            let ciphertext = Aes256Gcm::new_from_slice(&host_key)
                .unwrap()
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: plaintext.as_bytes(),
                        aad: aad.as_bytes(),
                    },
                )
                .unwrap();
            let mut frame = metadata;
            frame["ciphertextBase64Url"] = json!(URL_SAFE_NO_PAD.encode(ciphertext));
            frame["signatureBase64Url"] = json!(URL_SAFE_NO_PAD.encode(
                host_signing
                    .sign(
                        format!(
                            "SYNDICATE-RELAY-FRAME-V1\n{}",
                            canonical_json(&frame).unwrap()
                        )
                        .as_bytes()
                    )
                    .to_bytes()
            ));
            let routed = json!({
                "protocolVersion": 1,
                "type": "routedEncrypted",
                "routeId": route_for_server,
                "sender": {"role": "host", "machineId": machine_id, "deviceId": "host"},
                "frame": frame,
            });
            socket
                .send(Message::Text(canonical_json(&routed).unwrap().into()))
                .await
                .unwrap();
        });
        let transport = RelayTransport::new(credential).unwrap();
        let envelope = json!({
            "request": {"requestId": "request-e2e"},
            "auth": {"timestamp": "1", "nonce": "fixture", "signature": "fixture"},
        });
        let (response, receive_counter) = transport
            .exchange(&envelope, "request-e2e", &material, 1)
            .await
            .unwrap();
        assert_eq!(receive_counter, 1);
        assert_eq!(response["result"]["machineId"], machine_id);
        server.await.unwrap();
    }

    #[test]
    fn cross_language_key_nonce_and_frame_fixture_match() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/controller-relay-crypto-v1.json"
        ))
        .expect("shared fixture");
        let host_private = decode_32(
            fixture["hostX25519PrivateKeyBase64Url"].as_str().unwrap(),
            "host private",
        )
        .unwrap();
        let device_private = decode_32(
            fixture["deviceX25519PrivateKeyBase64Url"].as_str().unwrap(),
            "device private",
        )
        .unwrap();
        let host = X25519Secret::from(host_private);
        let device = X25519Secret::from(device_private);
        let host_public = X25519PublicKey::from(&host);
        let device_public = X25519PublicKey::from(&device);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(host_public.as_bytes()),
            fixture["hostX25519PublicKeyBase64Url"].as_str().unwrap()
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(device_public.as_bytes()),
            fixture["deviceX25519PublicKeyBase64Url"].as_str().unwrap()
        );
        let frame = &fixture["frame"];
        let key = derive_key(
            device.diffie_hellman(&host_public).as_bytes(),
            frame["machineId"].as_str().unwrap(),
            frame["deviceId"].as_str().unwrap(),
            frame["direction"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(key),
            fixture["derivedKeyBase64Url"].as_str().unwrap()
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(relay_nonce("controller-to-host", 7).unwrap()),
            frame["nonceBase64Url"].as_str().unwrap()
        );
        let signing = SigningKey::from_bytes(
            &decode_32(
                fixture["deviceEd25519PrivateKeyBase64Url"]
                    .as_str()
                    .unwrap(),
                "device signing",
            )
            .unwrap(),
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes()),
            fixture["deviceEd25519PublicKeyBase64Url"].as_str().unwrap()
        );

        let mut metadata = frame.clone();
        metadata
            .as_object_mut()
            .unwrap()
            .remove("ciphertextBase64Url");
        metadata
            .as_object_mut()
            .unwrap()
            .remove("signatureBase64Url");
        let plaintext = canonical_json(&fixture["plaintext"]).unwrap();
        let aad = canonical_json(&metadata).unwrap();
        let ciphertext = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(
                Nonce::from_slice(&relay_nonce("controller-to-host", 7).unwrap()),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&ciphertext),
            frame["ciphertextBase64Url"].as_str().unwrap()
        );
        metadata["ciphertextBase64Url"] = json!(URL_SAFE_NO_PAD.encode(ciphertext));
        let signature = signing.sign(
            format!(
                "SYNDICATE-RELAY-FRAME-V1\n{}",
                canonical_json(&metadata).unwrap()
            )
            .as_bytes(),
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            frame["signatureBase64Url"].as_str().unwrap()
        );
    }
}

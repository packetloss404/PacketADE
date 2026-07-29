//! Narrow PacketAgent W9 client.
//!
//! PacketAgent remains a separate product and runtime. PacketADE stores only
//! its connection profile and durable deployment references; the bearer token
//! stays in the OS credential store and is never returned to the webview.

use crate::core::brand::{KEYRING_SERVICE, USER_AGENT};
use futures::StreamExt;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const TOKEN_ACCOUNT: &str = "packet-agent-token";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketAgentRequest {
    pub endpoint: String,
    pub workspace_id: Option<String>,
    pub operation: String,
    pub deployment_id: Option<String>,
    pub event_id: Option<String>,
    pub cursor: Option<String>,
    pub payload: Option<Value>,
    pub idempotency_key: Option<String>,
    pub if_match: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketAgentResponse {
    pub status: u16,
    pub body: Value,
    pub etag: Option<String>,
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, TOKEN_ACCOUNT)
        .map_err(|error| format!("Credential store unavailable: {error}"))
}

fn load_token() -> Result<String, String> {
    token_entry()?.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => {
            "PacketAgent token is not configured. Open Settings > PacketAgent.".to_string()
        }
        other => format!("Failed to read PacketAgent token: {other}"),
    })
}

fn normalized_endpoint(endpoint: &str) -> Result<Url, String> {
    let mut url = Url::parse(endpoint.trim())
        .map_err(|_| "PacketAgent endpoint must be an absolute HTTP(S) URL.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("PacketAgent endpoint must not contain credentials.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("PacketAgent endpoint must not contain a query or fragment.".to_string());
    }
    let loopback = match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .parse::<std::net::IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false),
        None => false,
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(
            "PacketAgent requires HTTPS; HTTP is allowed only for a loopback endpoint.".to_string(),
        );
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn push_path(url: &mut Url, segments: &[&str]) -> Result<(), String> {
    let mut path = url
        .path_segments_mut()
        .map_err(|_| "PacketAgent endpoint cannot be used as a base URL.".to_string())?;
    path.pop_if_empty();
    for segment in segments {
        if segment.trim().is_empty() {
            return Err("PacketAgent request identifier cannot be empty.".to_string());
        }
        path.push(segment);
    }
    Ok(())
}

fn request_target(input: &PacketAgentRequest) -> Result<(Method, Url, bool), String> {
    let mut url = normalized_endpoint(&input.endpoint)?;
    let deployment = input.deployment_id.as_deref();
    let event = input.event_id.as_deref();
    let (method, segments, requires_auth): (Method, Vec<&str>, bool) =
        match input.operation.as_str() {
            "health" => (Method::GET, vec!["api", "health"], false),
            "validate" => (
                Method::POST,
                vec!["api", "worker-packages", "validate"],
                true,
            ),
            "deploy" => (Method::POST, vec!["api", "worker-deployments"], true),
            "inspect" => (
                Method::GET,
                vec![
                    "api",
                    "worker-deployments",
                    deployment.ok_or("PacketAgent deployment ID is required.")?,
                ],
                true,
            ),
            "activate" | "pause" | "resume" | "rollback" | "revoke" => (
                Method::POST,
                vec![
                    "api",
                    "worker-deployments",
                    deployment.ok_or("PacketAgent deployment ID is required.")?,
                    input.operation.as_str(),
                ],
                true,
            ),
            "runs" => (
                Method::GET,
                vec![
                    "api",
                    "worker-deployments",
                    deployment.ok_or("PacketAgent deployment ID is required.")?,
                    "runs",
                ],
                true,
            ),
            "events" => (
                Method::GET,
                vec![
                    "api",
                    "worker-deployments",
                    deployment.ok_or("PacketAgent deployment ID is required.")?,
                    "events",
                ],
                true,
            ),
            "ack_events" => (
                Method::PUT,
                vec![
                    "api",
                    "worker-deployments",
                    deployment.ok_or("PacketAgent deployment ID is required.")?,
                    "events",
                    "cursor",
                ],
                true,
            ),
            "evidence" => (
                Method::GET,
                vec![
                    "api",
                    "worker-events",
                    event.ok_or("PacketAgent event ID is required.")?,
                    "evidence",
                ],
                true,
            ),
            _ => return Err("Unsupported PacketAgent operation.".to_string()),
        };
    push_path(&mut url, &segments)?;
    if matches!(input.operation.as_str(), "events" | "runs") {
        let mut query = url.query_pairs_mut();
        if let Some(cursor) = input
            .cursor
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            query.append_pair("cursor", cursor);
        }
        query.append_pair("limit", "100");
    }
    Ok((method, url, requires_auth))
}

fn required_header(value: &Option<String>, name: &str) -> Result<String, String> {
    let value = value.as_deref().unwrap_or_default().trim();
    if value.is_empty() || value.len() > 4096 || value.contains(['\r', '\n', '\0']) {
        return Err(format!(
            "{name} is required and must be a valid header value."
        ));
    }
    Ok(value.to_string())
}

#[tauri::command]
pub async fn set_packet_agent_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("PacketAgent token cannot be empty.".to_string());
    }
    token_entry()?
        .set_password(token)
        .map_err(|error| format!("Failed to store PacketAgent token: {error}"))
}

#[tauri::command]
pub async fn get_packet_agent_token_exists() -> Result<bool, String> {
    match token_entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("Failed to check PacketAgent token: {error}")),
    }
}

#[tauri::command]
pub async fn delete_packet_agent_token() -> Result<(), String> {
    match token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Failed to delete PacketAgent token: {error}")),
    }
}

#[tauri::command]
pub async fn packet_agent_request(
    request: PacketAgentRequest,
) -> Result<PacketAgentResponse, String> {
    let (method, url, requires_auth) = request_target(&request)?;
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|error| format!("Could not create PacketAgent client: {error}"))?;
    let mut outgoing = client.request(method.clone(), url);

    if requires_auth {
        outgoing = outgoing.bearer_auth(load_token()?).header(
            "PacketAgent-Workspace-Id",
            required_header(&request.workspace_id, "PacketAgent workspace ID")?,
        );
    }
    if matches!(method, Method::POST | Method::PUT) {
        outgoing = outgoing.header(
            "Idempotency-Key",
            required_header(&request.idempotency_key, "PacketAgent idempotency key")?,
        );
    }
    if request.operation == "ack_events" {
        outgoing = outgoing.header(
            "If-Match",
            required_header(&request.if_match, "PacketAgent cursor ETag")?,
        );
    }
    if let Some(payload) = request.payload {
        outgoing = outgoing.json(&payload);
    }

    let response = outgoing
        .send()
        .await
        .map_err(|error| format!("PacketAgent request failed: {error}"))?;
    let status = response.status();
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Could not read PacketAgent response: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("PacketAgent response exceeded the 4 MiB safety limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("PacketAgent rejected the request.");
        return Err(format!("PacketAgent {}: {message}", status.as_u16()));
    }
    Ok(PacketAgentResponse {
        status: status.as_u16(),
        body,
        etag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_requires_https_except_loopback() {
        assert!(normalized_endpoint("https://agent.example.test").is_ok());
        assert!(normalized_endpoint("http://localhost:8787").is_ok());
        assert!(normalized_endpoint("http://127.0.0.1:8787").is_ok());
        assert!(normalized_endpoint("http://agent.example.test").is_err());
        assert!(normalized_endpoint("https://token@agent.example.test").is_err());
    }

    #[test]
    fn operation_is_a_closed_allowlist() {
        let request = PacketAgentRequest {
            endpoint: "https://agent.example.test".to_string(),
            workspace_id: Some("workspace".to_string()),
            operation: "arbitrary".to_string(),
            deployment_id: None,
            event_id: None,
            cursor: None,
            payload: None,
            idempotency_key: None,
            if_match: None,
        };
        assert!(request_target(&request).is_err());
    }
}

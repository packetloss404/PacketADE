//! PH6: PacketAgent SSE consumer.
//!
//! Rust owns the live connection so the bearer token never reaches the
//! webview. One background task per worker deployment consumes
//! `GET /api/worker-deployments/{id}/events/stream` (bounded ~25s server-side
//! connections — reconnecting with the carried cursor is the steady state,
//! not an error path) and forwards frames to the frontend as Tauri events:
//!
//! - `packet-agent:event:{deploymentId}` — one payload per SSE data frame
//!   (raw event JSON + eventId + type). Purely observational.
//! - `packet-agent:stream-status:{deploymentId}` — connection state
//!   transitions ({ state, cursor?, message?, consecutiveFailures }).
//!
//! The stream NEVER advances durable state: acknowledgements stay explicit
//! via the existing `ack_events` PUT (with If-Match) issued by the frontend.

use crate::commands::packet_agent::{load_token, normalized_endpoint, push_path};
use crate::core::brand::USER_AGENT;
use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

/// Managed registry of running stream tasks, keyed by deployment id.
#[derive(Default)]
pub struct PacketAgentStreamState {
    tasks: Mutex<HashMap<String, StreamTask>>,
}

struct StreamTask {
    cancel: CancellationToken,
    handle: tauri::async_runtime::JoinHandle<()>,
}

/// Abort every running stream task. Called from the app-exit handler so the
/// tokio tasks (and their sockets) never outlive the window.
pub fn shutdown_streams(state: &PacketAgentStreamState) {
    let mut tasks = state.tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for (_, task) in tasks.drain() {
        task.cancel.cancel();
        task.handle.abort();
    }
}

// === SSE frame parsing ======================================================

/// One parsed server-sent event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

/// Incremental SSE parser over arbitrary byte chunks. Frames are delimited by
/// a blank line; `id:` / `event:` / `data:` fields accumulate per frame
/// (multiple `data:` lines join with `\n`). CRLF and bare-LF line endings are
/// both accepted; comment lines (`:`) and unknown fields (`retry:`) are
/// ignored. Bytes for a not-yet-complete frame stay buffered across `push`
/// calls, so a frame split across TCP chunks parses exactly once.
#[derive(Default)]
pub struct SseParser {
    buffer: String,
    current_id: Option<String>,
    current_event: Option<String>,
    current_data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseFrame> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut frames = Vec::new();
        // Consume complete lines; keep the trailing partial line buffered.
        while let Some(newline) = self.buffer.find('\n') {
            let mut line: String = self.buffer.drain(..=newline).collect();
            if line.ends_with('\n') {
                line.pop();
            }
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                if let Some(frame) = self.take_frame() {
                    frames.push(frame);
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.find(':') {
                Some(colon) => {
                    let value = &line[colon + 1..];
                    (&line[..colon], value.strip_prefix(' ').unwrap_or(value))
                }
                None => (line.as_str(), ""),
            };
            match field {
                "id" => self.current_id = Some(value.to_string()),
                "event" => self.current_event = Some(value.to_string()),
                "data" => self.current_data.push(value.to_string()),
                _ => {}
            }
        }
        frames
    }

    fn take_frame(&mut self) -> Option<SseFrame> {
        if self.current_id.is_none() && self.current_event.is_none() && self.current_data.is_empty()
        {
            return None;
        }
        let frame = SseFrame {
            id: self.current_id.take(),
            event: self.current_event.take(),
            data: std::mem::take(&mut self.current_data).join("\n"),
        };
        Some(frame)
    }
}

// === Emitted payloads =======================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEventPayload {
    event_id: Option<String>,
    event_type: Option<String>,
    data: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamStatusPayload {
    /// connected | reconnecting | stopped | error
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    consecutive_failures: u32,
}

fn emit_status(
    app: &AppHandle,
    deployment_id: &str,
    state: &'static str,
    cursor: Option<String>,
    message: Option<String>,
    consecutive_failures: u32,
) {
    let _ = app.emit(
        &format!("packet-agent:stream-status:{deployment_id}"),
        StreamStatusPayload {
            state,
            cursor,
            message,
            consecutive_failures,
        },
    );
}

// === Commands ===============================================================

const CONTROL_HEARTBEAT: &str = "packetagent.heartbeat";
const CONTROL_CLOSED: &str = "packetagent.stream.closed";
const CONTROL_ERROR: &str = "packetagent.stream.error";
const BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

#[tauri::command]
pub async fn start_packet_agent_stream(
    app: AppHandle,
    state: State<'_, PacketAgentStreamState>,
    endpoint: String,
    workspace_id: String,
    deployment_id: String,
    cursor: Option<String>,
) -> Result<(), String> {
    if deployment_id.trim().is_empty() {
        return Err("PacketAgent deployment ID is required.".to_string());
    }
    let workspace_id = workspace_id.trim().to_string();
    if workspace_id.is_empty() {
        return Err("PacketAgent workspace ID is required.".to_string());
    }
    // Validate up-front so a bad endpooint fails the command, not the task.
    let mut url = normalized_endpoint(&endpoint)?;
    push_path(
        &mut url,
        &["api", "worker-deployments", &deployment_id, "events", "stream"],
    )?;
    let token = load_token()?;

    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task_app = app.clone();
    let task_deployment = deployment_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_stream_loop(task_app, task_cancel, url, token, workspace_id, task_deployment, cursor)
            .await;
    });

    let mut tasks = state
        .tasks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(previous) = tasks.insert(deployment_id, StreamTask { cancel, handle }) {
        previous.cancel.cancel();
        previous.handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_packet_agent_stream(
    app: AppHandle,
    state: State<'_, PacketAgentStreamState>,
    deployment_id: String,
) -> Result<(), String> {
    let removed = {
        let mut tasks = state
            .tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tasks.remove(&deployment_id)
    };
    if let Some(task) = removed {
        task.cancel.cancel();
        task.handle.abort();
        emit_status(&app, &deployment_id, "stopped", None, None, 0);
    }
    Ok(())
}

async fn run_stream_loop(
    app: AppHandle,
    cancel: CancellationToken,
    url: reqwest::Url,
    token: String,
    workspace_id: String,
    deployment_id: String,
    mut cursor: Option<String>,
) {
    let client = match reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        // No overall timeout: the server bounds each connection (~25s) itself.
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            emit_status(
                &app,
                &deployment_id,
                "error",
                cursor.clone(),
                Some(format!("Could not create the stream client: {error}")),
                1,
            );
            return;
        }
    };

    let mut consecutive_failures: u32 = 0;
    let mut backoff = BACKOFF_INITIAL;

    loop {
        if cancel.is_cancelled() {
            return;
        }
        let mut request = client
            .get(url.clone())
            .header("Accept", "text/event-stream")
            .header("PacketAgent-Workspace-Id", &workspace_id)
            .bearer_auth(&token);
        if let Some(cursor_value) = cursor.as_deref().filter(|value| !value.trim().is_empty()) {
            request = request.header("Last-Event-ID", cursor_value);
        }

        let response = tokio::select! {
            _ = cancel.cancelled() => return,
            outcome = request.send() => outcome,
        };
        let response = match response.and_then(|response| response.error_for_status()) {
            Ok(response) => response,
            Err(error) => {
                consecutive_failures += 1;
                emit_status(
                    &app,
                    &deployment_id,
                    "reconnecting",
                    cursor.clone(),
                    Some(format!("PacketAgent stream connect failed: {error}")),
                    consecutive_failures,
                );
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };

        consecutive_failures = 0;
        backoff = BACKOFF_INITIAL;
        emit_status(&app, &deployment_id, "connected", cursor.clone(), None, 0);

        let mut parser = SseParser::default();
        let mut stream = response.bytes_stream();
        // The server closes each connection with an explicit control event
        // carrying the resume cursor; treat both that and EOF as "reconnect
        // now with the latest cursor".
        'connection: loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return,
                chunk = stream.next() => chunk,
            };
            let chunk = match chunk {
                Some(Ok(chunk)) => chunk,
                Some(Err(error)) => {
                    consecutive_failures += 1;
                    emit_status(
                        &app,
                        &deployment_id,
                        "reconnecting",
                        cursor.clone(),
                        Some(format!("PacketAgent stream read failed: {error}")),
                        consecutive_failures,
                    );
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = tokio::time::sleep(backoff) => {}
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    break 'connection;
                }
                // Clean EOF — bounded connection expired; reconnect at once.
                None => break 'connection,
            };
            for frame in parser.push(&chunk) {
                if let Some(id) = frame.id.as_deref().filter(|id| !id.is_empty()) {
                    cursor = Some(id.to_string());
                }
                let event_type = frame.event.as_deref().unwrap_or("message");
                match event_type {
                    CONTROL_HEARTBEAT => {}
                    CONTROL_CLOSED => {
                        // Carries { cursor, reason }; adopt the server cursor
                        // and reconnect immediately (steady state, no backoff).
                        if let Ok(data) = serde_json::from_str::<Value>(&frame.data) {
                            if let Some(server_cursor) =
                                data.get("cursor").and_then(Value::as_str)
                            {
                                if !server_cursor.is_empty() {
                                    cursor = Some(server_cursor.to_string());
                                }
                            }
                        }
                        break 'connection;
                    }
                    CONTROL_ERROR => {
                        emit_status(
                            &app,
                            &deployment_id,
                            "error",
                            cursor.clone(),
                            Some(if frame.data.is_empty() {
                                "PacketAgent reported a stream error.".to_string()
                            } else {
                                frame.data.clone()
                            }),
                            consecutive_failures,
                        );
                        break 'connection;
                    }
                    _ => {
                        let data = serde_json::from_str::<Value>(&frame.data)
                            .unwrap_or(Value::String(frame.data.clone()));
                        let _ = app.emit(
                            &format!("packet-agent:event:{deployment_id}"),
                            StreamEventPayload {
                                event_id: frame.id.clone(),
                                event_type: frame.event.clone(),
                                data,
                            },
                        );
                    }
                }
            }
        }
    }
}

/// App-exit teardown hook used from `lib.rs`.
pub fn shutdown_on_exit(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<PacketAgentStreamState>() {
        shutdown_streams(&state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(parser: &mut SseParser, chunks: &[&str]) -> Vec<SseFrame> {
        let mut all = Vec::new();
        for chunk in chunks {
            all.extend(parser.push(chunk.as_bytes()));
        }
        all
    }

    #[test]
    fn parses_a_complete_frame() {
        let mut parser = SseParser::default();
        let parsed = frames(
            &mut parser,
            &["id: evt_1\nevent: worker.run.completed\ndata: {\"ok\":true}\n\n"],
        );
        assert_eq!(
            parsed,
            vec![SseFrame {
                id: Some("evt_1".to_string()),
                event: Some("worker.run.completed".to_string()),
                data: "{\"ok\":true}".to_string(),
            }]
        );
    }

    #[test]
    fn reassembles_frames_split_across_chunks() {
        let mut parser = SseParser::default();
        let parsed = frames(
            &mut parser,
            &[
                "id: evt",
                "_2\neve",
                "nt: worker.deployed\nda",
                "ta: {\"a\":1}\ndata: {\"b\":2}\n",
                "\nid: evt_3\ndata: x\n\n",
            ],
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id.as_deref(), Some("evt_2"));
        assert_eq!(parsed[0].event.as_deref(), Some("worker.deployed"));
        assert_eq!(parsed[0].data, "{\"a\":1}\n{\"b\":2}");
        assert_eq!(parsed[1].id.as_deref(), Some("evt_3"));
        assert_eq!(parsed[1].event, None);
        assert_eq!(parsed[1].data, "x");
    }

    #[test]
    fn accepts_crlf_line_endings_and_comments() {
        let mut parser = SseParser::default();
        let parsed = frames(
            &mut parser,
            &[": keepalive\r\nid: evt_4\r\nevent: packetagent.heartbeat\r\ndata: {}\r\n\r\n"],
        );
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id.as_deref(), Some("evt_4"));
        assert_eq!(parsed[0].event.as_deref(), Some(CONTROL_HEARTBEAT));
    }

    #[test]
    fn parses_control_close_and_error_frames() {
        let mut parser = SseParser::default();
        let parsed = frames(
            &mut parser,
            &[
                "event: packetagent.stream.closed\ndata: {\"cursor\":\"evt_9\",\"reason\":\"window\"}\n\n",
                "event: packetagent.stream.error\ndata: boom\n\n",
            ],
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].event.as_deref(), Some(CONTROL_CLOSED));
        let data: Value = serde_json::from_str(&parsed[0].data).unwrap();
        assert_eq!(data.get("cursor").and_then(Value::as_str), Some("evt_9"));
        assert_eq!(parsed[1].event.as_deref(), Some(CONTROL_ERROR));
        assert_eq!(parsed[1].data, "boom");
    }

    #[test]
    fn blank_lines_without_fields_emit_nothing_and_partials_stay_buffered() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"\n\n\n").is_empty());
        assert!(parser.push(b"data: partial").is_empty());
        // Still no newline — nothing parsed yet.
        assert!(parser.push(b" tail\n").is_empty());
        let parsed = parser.push(b"\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].data, "partial tail");
    }
}

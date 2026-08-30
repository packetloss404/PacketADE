//! Conversation-level routing for the ACP transport.
//!
//! `commands::api_agent` owns the api-agent command surface and dispatches
//! each post-start command to whichever backend owns the session — the Node
//! sidecar (`SidecarManager::owns_session`), the ACP engine ([`owns_session`]
//! here), or the in-process `LlmProvider` runtime. This module is the ACP
//! half: it turns PacketBench's conversation-shaped requests into ACP calls and
//! keeps the conversation-id ↔ ACP-session-id map in step.
//!
//! **Session identity.** PacketBench mints the conversation id and it is the
//! session id everywhere in the app (`sessionId === conversationId`). The
//! engine mints its OWN id on `session/new`; that id never leaves this module
//! except on the wire. Every `api-agent:*` event is keyed on PacketBench's id.

use super::events;
use super::AcpMcpPosture;
use super::AcpState;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

/// The provider id the frontend sends for an ACP-backed conversation.
pub const PROVIDER_ID: &str = "packetcode-acp";

/// Whether a provider id routes to the ACP engine.
pub fn is_acp_provider(provider: &str) -> bool {
    provider == PROVIDER_ID
}

/// Whether the ACP transport owns this conversation — the ACP counterpart of
/// `SidecarManager::owns_session`.
pub fn owns_session(state: &AcpState, conversation_id: &str) -> bool {
    state.sessions.owns(conversation_id)
}

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

/// Translates a PacketBench permission posture onto the ACP vocabulary.
///
/// PacketBench's five postures live in
/// `src/components/agents/agentModeChipUtils.ts` and reach Rust as a
/// `(plan_mode: bool, permission_mode: String)` pair, not as the posture name.
/// ACP has one escalation ladder instead
/// ([`PERMISSION_MODES`](super::PERMISSION_MODES), from packetcode's
/// `internal/acp/server.go`). The mapping:
///
/// | PacketBench posture | what Rust receives            | ACP mode      |
/// |-------------------|-------------------------------|---------------|
/// | default           | `permission_mode = "auto"`    | `auto`        |
/// | plan              | `set_plan_mode(true)`         | `read-only`   |
/// | manual            | `permission_mode = "ask_for_risky"` | `ask`   |
/// | deny              | `permission_mode = "deny_all"`| `read-only`   |
/// | yolo              | `permission_mode = "allow_all"` | `bypass`    |
/// | (approve-writes on) | `set_approve_writes(true)`  | `accept-edits` |
///
/// `deny` collapses onto `read-only` because ACP has no "refuse everything"
/// rung: read-only is the nearest posture that cannot mutate the workspace,
/// and it is the conservative direction to round in. The sidecar's own
/// vocabulary (`"plan"`, `"acceptEdits"`, `"default"`) is accepted too, since
/// `set_plan_mode` / `set_approve_writes` already speak it — that keeps every
/// caller working without the frontend having to learn a third dialect.
///
/// Anything unrecognized becomes `auto`, which is exactly what PacketBench's own
/// `PermissionMode::default()` means.
pub fn to_acp_permission_mode(mode: &str) -> &'static str {
    match mode.trim() {
        "ask_for_risky" | "manual" | "ask" => "ask",
        "deny_all" | "deny" | "plan" | "read-only" | "readonly" => "read-only",
        "allow_all" | "yolo" | "bypass" => "bypass",
        "acceptEdits" | "accept-edits" | "accept_edits" => "accept-edits",
        _ => "auto",
    }
}

/// Intersects a desired ACP mode with what the running engine advertised.
///
/// The engine trims its `permissionModes` list to the operator's configured
/// ceiling and answers `-32602` for anything above it, so a mode outside the
/// advertised set must be dropped rather than sent. `None` means "omit the
/// override", which asks the engine for its own default — strictly better than
/// failing the whole `session/new` over a posture the operator disallowed.
async fn resolve_permission_mode(state: &AcpState, desired: Option<&str>) -> Option<String> {
    let desired = desired?;
    let caps = super::capabilities_of(state).await;
    if caps.packetcode.permission_modes.iter().any(|m| m == desired) {
        return Some(desired.to_string());
    }
    warn!(
        mode = %desired,
        advertised = ?caps.packetcode.permission_modes,
        "ACP engine does not offer this permission mode; falling back to its default"
    );
    None
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/// Ensures the engine is up, mapping a spawn failure onto an actionable
/// message rather than a bare transport error.
async fn ensure_engine(app: &AppHandle, state: &AcpState) -> Result<(), String> {
    if super::is_running(state).await {
        return Ok(());
    }
    super::start_default_engine(app, state).await.map_err(|e| {
        format!(
            "Could not start the packetcode ACP engine: {e}. Install it and make sure it is \
             on PATH, or point {} at its full path.",
            super::ENGINE_PATH_ENV
        )
    })
}

/// `session/load` with the conversation's replay window held open around it.
///
/// The engine streams the stored transcript as `session/update` notifications
/// *before* the request resolves, and those updates are keyed on the engine's
/// session id — so the id mapping must already be registered (otherwise the
/// sink drops them for a different reason and the honesty guarantee would rest
/// on an accident of ordering). The window is closed on BOTH exits: an
/// interrupted replay must not leave a live conversation permanently muted.
///
/// See [`super::events::translate_update`]'s docs for what the window does and
/// why it emits nothing at all.
async fn load_with_replay_window(
    state: &AcpState,
    conversation_id: &str,
    engine_session: &str,
    cwd: &str,
    mcp: AcpMcpPosture,
) -> Result<(), String> {
    state.sessions.set_replaying(conversation_id, true);
    let result = super::load_session_on(state, engine_session, cwd, mcp).await;
    state.sessions.set_replaying(conversation_id, false);
    result
}

/// Starts an ACP-backed conversation: brings the engine up if it is not
/// already, obtains an engine session for `project_path`, registers the id
/// mapping, and runs the first turn.
///
/// **Resume.** `engine_session_id` is an id from the engine's OWN session
/// directory (`acp_list_sessions`). When present the session is resumed with
/// `session/load` instead of created with `session/new`, and the mapping is
/// registered against that id — which is what makes a conversation adopted
/// from the sidebar's "On the engine" list a real, promptable conversation
/// with the engine's history as its context. When absent this is a fresh
/// `session/new`, exactly as before.
///
/// A resume deliberately does NOT carry `model` / `permission_mode` onto the
/// wire: ACP binds both at session creation and `session/load` takes neither,
/// so they are recorded as pending config (the same slot `set_model` writes)
/// and apply to the next session this conversation creates.
///
/// **MCP posture.** `mcp` is PacketBench's trust decision for this conversation,
/// already resolved from the caller's frozen `mcp_trust_snapshot` (see
/// [`super::mcp`]). It defaults to [`AcpMcpPosture::None`] — an explicit empty
/// `mcpServers` list, not one subprocess started — and it is FROZEN here for
/// the life of the conversation: it is recorded on the session record and
/// there is deliberately no `set_mcp_posture` counterpart to [`set_model`] or
/// [`set_permission_mode`], because a mid-session Settings edit must not be
/// able to broaden what a running session already spawned. The resume path
/// freezes it the same way and hands the SAME posture to `session/load`, so a
/// resumed session runs the fleet that was consented to rather than whatever
/// Settings happens to say now.
#[allow(clippy::too_many_arguments)]
pub async fn start_session(
    app: &AppHandle,
    state: &AcpState,
    conversation_id: String,
    project_path: String,
    model: Option<String>,
    permission_mode: Option<String>,
    plan_mode: bool,
    mcp: AcpMcpPosture,
    engine_session_id: Option<String>,
    initial_message: String,
) -> Result<(), String> {
    ensure_engine(app, state).await?;

    // Plan mode is the strongest signal the user gave; it outranks a stale
    // permission-mode string on the conversation.
    let desired = if plan_mode {
        Some("read-only".to_string())
    } else {
        permission_mode
            .as_deref()
            .map(|m| to_acp_permission_mode(m).to_string())
    };
    let resolved = resolve_permission_mode(state, desired.as_deref()).await;
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let resume = engine_session_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());

    // Config and posture are recorded BEFORE the session exists on the resume
    // path, because `register` has to happen before `session/load` (the replay
    // arrives during the request) and `mcp_posture` is read back by the load.
    state
        .sessions
        .set_pending_config(&conversation_id, &project_path, model.clone(), resolved.clone());
    // Freeze the posture alongside the session. A later `session/load` for
    // this conversation replays THIS decision rather than re-reading Settings.
    state.sessions.freeze_mcp_posture(&conversation_id, mcp.clone());

    let engine_session = match resume {
        Some(engine_session) => {
            state
                .sessions
                .register(&conversation_id, &engine_session, &project_path);
            if let Err(e) =
                load_with_replay_window(state, &conversation_id, &engine_session, &project_path, mcp)
                    .await
            {
                // A failed load leaves no usable session, so ACP must not go on
                // claiming this conversation — otherwise every later command
                // routes here and dies on a session the engine never made
                // resident.
                state.sessions.forget(&conversation_id);
                return Err(e);
            }
            engine_session
        }
        None => {
            let created = super::new_session_on(
                state,
                &project_path,
                // Provider selection is the engine's own concern: PacketBench picks
                // a model, and packetcode resolves the provider that serves it.
                None,
                model,
                resolved,
                mcp,
            )
            .await;
            match created {
                Ok(engine_session) => {
                    state
                        .sessions
                        .register(&conversation_id, &engine_session, &project_path);
                    engine_session
                }
                // The pending config above already put this conversation in the
                // map. A failed `session/new` must not leave ACP claiming
                // ownership of a conversation that has no engine session, or
                // every later command routes here to die on it.
                Err(e) => {
                    state.sessions.forget(&conversation_id);
                    return Err(e);
                }
            }
        }
    };

    info!(
        conversation_id = %conversation_id,
        engine_session = %engine_session,
        mcp = ?state.sessions.mcp_posture(&conversation_id).kind(),
        "Started ACP session"
    );

    spawn_turn(app.clone(), conversation_id, initial_message);
    Ok(())
}

/// Makes a persisted engine session resident without starting a conversation.
///
/// Backs the `acp_load_session` command. `id` may be either a PacketBench
/// conversation id (whose engine session and frozen posture are then used) or
/// a raw engine session id from `acp_list_sessions` — the same either/or every
/// other read-only `acp_*` command accepts, so a disclosure surface does not
/// need a second command to talk about a session it can see.
///
/// The posture is READ, never derived: a conversation resumes with the fleet
/// it froze, and a raw engine id — which PacketBench has no consent record for —
/// resumes with [`AcpMcpPosture::None`].
pub async fn load_session(
    app: &AppHandle,
    state: &AcpState,
    id: &str,
    cwd: &str,
) -> Result<(), String> {
    ensure_engine(app, state).await?;
    let engine_session = state.sessions.engine_id_or_raw(id);
    let mcp = state.sessions.mcp_posture(id);
    load_with_replay_window(state, id, &engine_session, cwd, mcp).await
}

/// Sends a follow-up turn on an existing ACP conversation.
pub fn send_message(
    app: &AppHandle,
    state: &AcpState,
    conversation_id: String,
    message: String,
) -> Result<(), String> {
    if state.sessions.engine_id(&conversation_id).is_none() {
        return Err(format!("No active ACP session: {conversation_id}"));
    }
    spawn_turn(app.clone(), conversation_id, message);
    Ok(())
}

/// Runs one `session/prompt` turn in the background and emits the terminal
/// `api-agent:*` events for it.
///
/// Streaming events (`chunk`, `thinking`, `tool-*`, `plan-block`,
/// `permission-request`) come from the bridge's reader task via
/// [`events::ApiAgentSink`]; only the turn's ENDING is emitted here, because
/// only here is the prompt result known.
fn spawn_turn(app: AppHandle, conversation_id: String, text: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AcpState>();
        let Some(engine_session) = state.sessions.engine_id(&conversation_id) else {
            events::emit_error(
                &app,
                &conversation_id,
                format!("No active ACP session: {conversation_id}"),
            );
            return;
        };

        let result = super::prompt_on(&state, &engine_session, &text).await;
        // A turn that ends mid-thought or mid-tool must not leave the frontend
        // spinning, whatever route it ended by.
        events::finish_thinking(&app, &state.sessions, &conversation_id);

        match result {
            Ok(outcome) => {
                if outcome.stop_reason == "cancelled" {
                    events::fail_open_tools(
                        &app,
                        &state.sessions,
                        &conversation_id,
                        "Cancelled by the user",
                    );
                }
                events::emit_done(&app, &conversation_id, Some(&outcome));
            }
            Err(error) => {
                warn!(conversation_id = %conversation_id, error = %error, "ACP turn failed");
                events::fail_open_tools(&app, &state.sessions, &conversation_id, &error);
                let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
                    &conversation_id,
                    crate::core::flight::AttemptStatus::Failed,
                    Some(error.clone()),
                )
                .await;
                // Error only, no `done`: a per-turn failure is recoverable and
                // ownership stays with ACP, so the next send still routes here
                // instead of falling through to "No active session". This
                // mirrors the sidecar's error arm exactly.
                events::emit_error(&app, &conversation_id, error);
            }
        }
    });
}

/// Cancels the in-flight turn. The engine answers this session's outstanding
/// permission requests with `cancelled` and resolves the prompt with
/// `stopReason: "cancelled"`, which [`spawn_turn`] turns into a `done` event
/// carrying `cancelled: true`.
pub async fn cancel(state: &AcpState, conversation_id: &str) -> Result<(), String> {
    let engine_session = state
        .sessions
        .engine_id(conversation_id)
        .ok_or_else(|| format!("No active ACP session: {conversation_id}"))?;
    // The engine has stopped waiting on these; drop our records so a late
    // reply fails cleanly instead of double-answering.
    state.sessions.drain_permissions(conversation_id);
    super::cancel_on(state, &engine_session).await
}

/// Records a model change.
///
/// ACP binds provider/model at `session/new` — there is no mid-session model
/// method to call. Rather than fail the command (which would surface as an
/// error on a control the user just clicked), the choice is stored and applied
/// the next time this conversation creates an engine session.
pub fn set_model(state: &AcpState, conversation_id: &str, model: String) -> Result<(), String> {
    if !state.sessions.owns(conversation_id) {
        return Err(format!("No active ACP session: {conversation_id}"));
    }
    info!(
        conversation_id = %conversation_id,
        model = %model,
        "ACP model change recorded; applies to the next engine session"
    );
    state.sessions.set_model(conversation_id, model);
    Ok(())
}

/// Records a permission-mode change. Same lifecycle caveat as [`set_model`]:
/// ACP sets the mode at `session/new`.
pub async fn set_permission_mode(
    state: &AcpState,
    conversation_id: &str,
    mode: &str,
) -> Result<(), String> {
    if !state.sessions.owns(conversation_id) {
        return Err(format!("No active ACP session: {conversation_id}"));
    }
    let desired = to_acp_permission_mode(mode).to_string();
    let resolved = resolve_permission_mode(state, Some(&desired)).await;
    info!(
        conversation_id = %conversation_id,
        requested = %mode,
        applied = ?resolved,
        "ACP permission mode recorded; applies to the next engine session"
    );
    if let Some(resolved) = resolved {
        state.sessions.set_permission_mode(conversation_id, resolved);
    }
    Ok(())
}

/// Answers a pending permission request.
///
/// `request_id` is the id PacketBench emitted on the `permission-request` event
/// (a String, per the api-agent contract). The raw JSON-RPC id — a STRING on a
/// real packetcode engine — was kept beside it, and that is what goes back on
/// the wire, byte-identical to what arrived.
pub async fn respond_permission(
    state: &AcpState,
    conversation_id: &str,
    request_id: &str,
    decision: &str,
) -> Result<(), String> {
    let Some(pending) = state.sessions.take_permission(request_id) else {
        // Already answered, cancelled, or reaped with its turn. Warn rather
        // than fail: the in-process and sidecar paths both tolerate this.
        warn!(
            conversation_id = %conversation_id,
            request_id = %request_id,
            "No pending ACP permission request — likely already cancelled"
        );
        return Ok(());
    };
    let option_id = pending
        .option_for(decision)
        .ok_or_else(|| format!("Unknown decision: {decision}"))?
        .to_string();
    super::permission_reply_on(state, &pending.raw_id, &option_id).await
}

/// Denies every parked permission prompt for a conversation without ending
/// the turn — the ACP half of `cancel_pending_tools`.
pub async fn cancel_pending_tools(state: &AcpState, conversation_id: &str) -> Result<(), String> {
    for pending in state.sessions.drain_permissions(conversation_id) {
        let option_id = match pending.option_for("deny") {
            Some(id) => id.to_string(),
            None => continue,
        };
        if let Err(e) = super::permission_reply_on(state, &pending.raw_id, &option_id).await {
            warn!(conversation_id = %conversation_id, error = %e, "ACP deny reply failed");
        }
    }
    Ok(())
}

/// Releases the conversation's engine-side session and forgets the mapping.
///
/// `session/close` on an engine that predates the method degrades to success,
/// so eviction always frees PacketBench's side even when the engine keeps its
/// runtime until a re-load supersedes it.
pub async fn close_session(state: &AcpState, conversation_id: &str) -> Result<(), String> {
    let Some(engine_session) = state.sessions.forget(conversation_id) else {
        return Ok(());
    };
    super::close_session_on(state, &engine_session).await
}

/// Answer for `get_provider_auth_status("packetcode-acp")`.
///
/// The engine owns its own credentials (its `config.toml` provider blocks), so
/// PacketBench holds no keyring slot for it — `api_keys::VALID_PROVIDERS`
/// deliberately has no `packetcode-acp` entry. What CAN be checked is whether
/// the engine binary is present and new enough, which is what the badge should
/// reflect: an unmatched provider id is a hard `Err` that breaks the AuthBadge
/// outright, so this arm must always answer something.
///
/// Every hint here names a remedy the user can reach from inside the app.
/// Pointing at an environment variable was the old answer and it is not one: a
/// desktop user cannot be asked to export a variable before launching, and
/// every OTHER provider's not-ready hint points at Settings.
///
/// The three not-ready outcomes are kept apart on purpose. In particular a
/// binary that ran but never reported a version is NOT "too old" — that is
/// what a `doctor --json` timeout looks like, and telling the user to update a
/// binary of unknown vintage is a guess presented as a diagnosis.
pub async fn auth_status() -> (String, String) {
    let probe = match super::probe_engine().await {
        Ok(probe) => probe,
        Err(e) => {
            return (
                "service_down".to_string(),
                format!("packetcode engine probe failed: {e}"),
            )
        }
    };
    if !probe.found {
        return (
            "missing_key".to_string(),
            "packetcode engine not found. Set its path in Settings \u{2192} Provider Endpoints, \
             or install it from the PacketCode view."
                .to_string(),
        );
    }
    if !probe.compatible {
        return match probe.version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some(version) => (
                "service_down".to_string(),
                format!(
                    "packetcode {} is older than the required {} \u{2014} update it from the \
                     PacketCode view.",
                    version, probe.minimum_version
                ),
            ),
            None => (
                "service_down".to_string(),
                "packetcode ran but did not report a version, so it may not be the engine. \
                 Check the path in Settings \u{2192} Provider Endpoints."
                    .to_string(),
            ),
        };
    }
    ("ready".to_string(), String::new())
}

/// Wire form of a raw ACP permission id, for callers that hold the `Value`.
#[allow(dead_code)]
pub fn raw_permission_id(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The posture table in [`to_acp_permission_mode`]'s doc comment, pinned.
    #[test]
    fn packetbench_postures_map_onto_the_acp_ladder() {
        // default
        assert_eq!(to_acp_permission_mode("auto"), "auto");
        assert_eq!(to_acp_permission_mode("default"), "auto");
        // plan — both the boolean's translation and the sidecar's spelling
        assert_eq!(to_acp_permission_mode("plan"), "read-only");
        // manual
        assert_eq!(to_acp_permission_mode("ask_for_risky"), "ask");
        // deny: ACP has no refuse-everything rung, so it rounds conservatively
        assert_eq!(to_acp_permission_mode("deny_all"), "read-only");
        // yolo
        assert_eq!(to_acp_permission_mode("allow_all"), "bypass");
        // approve-writes, in the sidecar's own vocabulary
        assert_eq!(to_acp_permission_mode("acceptEdits"), "accept-edits");
        // Unknown input is the same as PermissionMode::default().
        assert_eq!(to_acp_permission_mode("something-new"), "auto");
        // Every result is a mode the engine's ladder actually contains.
        for mode in [
            "auto",
            "plan",
            "ask_for_risky",
            "deny_all",
            "allow_all",
            "acceptEdits",
            "nonsense",
        ] {
            let mapped = to_acp_permission_mode(mode);
            assert!(
                super::super::PERMISSION_MODES.contains(&mapped),
                "{mode} mapped to {mapped}, which is not an ACP permission mode"
            );
        }
    }

    #[test]
    fn provider_id_is_the_contract_string() {
        assert_eq!(PROVIDER_ID, "packetcode-acp");
        assert!(is_acp_provider("packetcode-acp"));
        assert!(!is_acp_provider("api-claude"));
        assert!(!is_acp_provider("claude-oauth"));
    }
}

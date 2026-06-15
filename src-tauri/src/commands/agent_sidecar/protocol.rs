//! Outbound request encoders — the `forward_*` methods that slice C's
//! routing layer in `api_agent.rs` calls. Each method shapes a JSON
//! request, then pushes it onto the supervisor's stdin writer channel.

use serde_json::{json, Value};

use super::supervisor::SidecarManager;
use crate::core::execution::SshConfig;

impl SidecarManager {
    /// Forward a start_session request to the sidecar.
    ///
    /// `mcp_kind` (v5) is an optional discriminator that tells the sidecar to
    /// construct an additional in-process MCP server locally before opening
    /// the SDK `query()`. The Flight Planner uses `Some("planner")` to ask
    /// the sidecar to register the planner tool surface
    /// (`mcp__planner__create_milestone`, etc.). Live `McpServer` instances
    /// cannot cross the stdio boundary, so this discriminator is the wire
    /// hand-off; the actual tool definitions live in
    /// `agent-sidecar/src/mcp/flight-planner-server.ts`. `None` for
    /// non-planner sessions, which keeps the existing `api-claude-oauth`
    /// chat path untouched.
    #[allow(clippy::too_many_arguments)]
    pub async fn forward_start(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        project_path: String,
        initial_message: String,
        api_key: Option<String>,
        resume: Option<String>,
        thinking_enabled: Option<bool>,
        plan_mode: Option<bool>,
        attachments: Value,
        resume_messages: Value,
        permission_mode: Option<String>,
        approve_writes: Option<bool>,
        mcp_kind: Option<String>,
        command_path: Option<String>,
        workspace: Option<Value>,
    ) -> Result<(), String> {
        self.forward_start_inner(
            session_id,
            provider,
            model,
            system_prompt,
            allowed_tools,
            mcp_servers,
            project_path,
            initial_message,
            api_key,
            resume,
            thinking_enabled,
            plan_mode,
            attachments,
            resume_messages,
            permission_mode,
            approve_writes,
            mcp_kind,
            command_path,
            workspace,
            None,
        )
        .await
    }

    /// Forward a start_session request through a dedicated SSH-backed
    /// sidecar. Used when a sidecar provider targets a remote workspace.
    #[allow(clippy::too_many_arguments)]
    pub async fn forward_start_ssh(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        project_path: String,
        initial_message: String,
        api_key: Option<String>,
        resume: Option<String>,
        thinking_enabled: Option<bool>,
        plan_mode: Option<bool>,
        attachments: Value,
        resume_messages: Value,
        permission_mode: Option<String>,
        approve_writes: Option<bool>,
        mcp_kind: Option<String>,
        command_path: Option<String>,
        workspace: Option<Value>,
        ssh_config: SshConfig,
    ) -> Result<(), String> {
        self.forward_start_inner(
            session_id,
            provider,
            model,
            system_prompt,
            allowed_tools,
            mcp_servers,
            project_path,
            initial_message,
            api_key,
            resume,
            thinking_enabled,
            plan_mode,
            attachments,
            resume_messages,
            permission_mode,
            approve_writes,
            mcp_kind,
            command_path,
            workspace,
            Some(ssh_config),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn forward_start_inner(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        project_path: String,
        initial_message: String,
        api_key: Option<String>,
        resume: Option<String>,
        thinking_enabled: Option<bool>,
        plan_mode: Option<bool>,
        attachments: Value,
        resume_messages: Value,
        permission_mode: Option<String>,
        approve_writes: Option<bool>,
        mcp_kind: Option<String>,
        command_path: Option<String>,
        workspace: Option<Value>,
        ssh_config: Option<SshConfig>,
    ) -> Result<(), String> {
        if let Some(config) = ssh_config.as_ref() {
            self.spawn_remote_sidecar_for_session(&session_id, &provider, config)
                .await?;
        }
        {
            let mut sessions = self.owned_sessions.lock().await;
            sessions.insert(session_id.clone());
        }
        let req = json!({
            "type": "start_session",
            "sessionId": session_id,
            "provider": provider,
            "model": model,
            "systemPrompt": system_prompt,
            "allowedTools": allowed_tools,
            "mcpServers": mcp_servers,
            "projectPath": project_path,
            "initialMessage": initial_message,
            "apiKey": api_key,
            "resume": resume,
            "thinkingEnabled": thinking_enabled,
            "planMode": plan_mode,
            "attachments": attachments,
            "resumeMessages": resume_messages,
            "permissionMode": permission_mode,
            "approveWrites": approve_writes,
            "mcpKind": mcp_kind,
            "commandPath": command_path,
            "workspace": workspace.unwrap_or_else(|| {
                json!({
                    "kind": "local",
                    "projectPath": project_path,
                })
            }),
        });
        let result = self.send_json_for_session(&session_id, req).await;
        if result.is_err() {
            self.forget_owned_session(&session_id).await;
            self.close_remote_session(&session_id).await;
        }
        result
    }

    /// Forward a typed `inject_user_turn` request to the sidecar (v5).
    ///
    /// Distinct from [`forward_send`] so the planner system prompt can
    /// reliably distinguish wake-triggered re-entry from a real human
    /// message. The sidecar wraps `content` in
    /// `<wake_trigger source="..." kind="...">…</wake_trigger>` before
    /// pushing it onto the SDK's prompt iterable; responses stream back
    /// over the same `api-agent:chunk:<sid>` / `api-agent:done:<sid>`
    /// channel as any other turn.
    ///
    /// `source` is `"user"` for human-initiated injections (e.g. the
    /// journal-comment path) and `"wake_trigger"` for orchestration-driven
    /// re-entry (task complete/failed, approval gate reached, collision
    /// detected, quota exhausted).
    ///
    /// `trigger_kind` is the specific wake-trigger kind for the
    /// `<wake_trigger kind="…">` attribute. `None` is fine for plain user
    /// turns; required (effectively) for `source == "wake_trigger"`.
    ///
    /// E6-CAPS: `max_output_tokens` is the per-mode output budget the
    /// Flight Planner wants the sidecar to honor for this turn. Threaded
    /// onto the wire as `maxOutputTokens` (camelCase to match the rest of
    /// the protocol). NOTE: the Claude Agent SDK (0.2.116) does not expose
    /// a per-turn `max_tokens` setter — the sidecar's anthropic provider
    /// logs a warning and leaves the SDK's defaults in place. The field is
    /// still threaded through so future SDK versions can pick it up
    /// without another protocol change.
    pub async fn forward_inject_user_turn(
        &self,
        session_id: &str,
        content: &str,
        source: &str,
        trigger_kind: Option<&str>,
        max_output_tokens: Option<u32>,
    ) -> Result<(), String> {
        let trigger = trigger_kind.map(|kind| json!({ "kind": kind }));
        let req = json!({
            "type": "inject_user_turn",
            "sessionId": session_id,
            "content": content,
            "source": source,
            "trigger": trigger,
            "maxOutputTokens": max_output_tokens,
        });
        self.send_json_for_session(session_id, req).await
    }

    /// Forward a `planner_tool_result` envelope to the sidecar (v5).
    ///
    /// The sidecar's in-process planner MCP server emits a `planner_tool`
    /// event when the model invokes a `mcp__planner__*` tool, and parks the
    /// SDK handler on a pending promise keyed by `call_id`. This method
    /// resolves that promise from the Rust side after
    /// [`FlightPlannerRegistry::handle_tool_call`] has produced a result.
    ///
    /// `success: true` + `result` resolves the SDK handler with `result`;
    /// `success: false` + `error` rejects it with that message string. The
    /// sidecar's `respondPlannerTool` handler tolerates an unknown `callId`
    /// (e.g. the call already resolved via cancel) — this is a fire-and-go
    /// dispatch.
    pub async fn forward_planner_tool_result(
        &self,
        session_id: &str,
        call_id: &str,
        success: bool,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<(), String> {
        let req = json!({
            "type": "planner_tool_result",
            "sessionId": session_id,
            "callId": call_id,
            "success": success,
            "result": result,
            "error": error,
        });
        self.send_json_for_session(session_id, req).await
    }

    /// Forward a send_message request for an existing sidecar session.
    pub async fn forward_send(
        &self,
        session_id: String,
        content: String,
        attachments: Value,
    ) -> Result<(), String> {
        let req = json!({
            "type": "send_message",
            "sessionId": session_id,
            "content": content,
            "attachments": attachments,
        });
        let result = self.send_json_for_session(&session_id, req).await;
        if result.is_err() {
            self.forget_owned_session(&session_id).await;
            self.close_remote_session(&session_id).await;
        }
        result
    }

    /// Forward a permission decision to the sidecar.
    pub async fn forward_permission(
        &self,
        session_id: String,
        tool_use_id: String,
        decision: String,
    ) -> Result<(), String> {
        let req = json!({
            "type": "permission_response",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "decision": decision,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a pending-edit approval/rejection to the sidecar. v3:
    /// `merged_content` carries an override file body for per-hunk
    /// acceptance — when present, the provider writes that content directly
    /// instead of letting the SDK's tool land its full `after`.
    pub async fn forward_edit(
        &self,
        session_id: String,
        approved: bool,
        merged_content: Option<String>,
    ) -> Result<(), String> {
        let req = json!({
            "type": "edit_response",
            "sessionId": session_id,
            "approved": approved,
            "mergedContent": merged_content,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a permission-mode change to the sidecar. Slice C's routing layer
    /// translates the legacy `set_plan_mode` / `set_approve_writes` booleans
    /// into one of the protocol's mode strings (`"default"`, `"plan"`,
    /// `"acceptEdits"`, `"bypassPermissions"`) before calling this.
    pub async fn forward_set_permission_mode(
        &self,
        session_id: String,
        mode: String,
    ) -> Result<(), String> {
        let req = json!({
            "type": "set_permission_mode",
            "sessionId": session_id,
            "mode": mode,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a model swap to the sidecar. Providers that can't hot-swap
    /// (e.g. Codex one-shot exec) stash the value for the next spawn.
    pub async fn forward_set_model(&self, session_id: String, model: String) -> Result<(), String> {
        let req = json!({
            "type": "set_model",
            "sessionId": session_id,
            "model": model,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a retry / regenerate-last-turn request to the sidecar.
    pub async fn forward_retry(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "retry",
            "sessionId": session_id,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a cancel request to the sidecar. Does not remove the session
    /// from `owned_sessions` — the sidecar should emit `done` or `error`
    /// which will clean up.
    pub async fn forward_cancel(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "cancel",
            "sessionId": session_id,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// F8: drain any parked permission/edit prompts as denied without
    /// killing the agent loop. Used by the per-conversation "Cancel
    /// pending" UI affordance.
    pub async fn forward_cancel_pending_tools(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "cancel_pending_tools",
            "sessionId": session_id,
        });
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a close request and remove from owned sessions.
    pub async fn forward_close(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "close_session",
            "sessionId": session_id,
        });
        let result = self.send_json_for_session(&session_id, req).await;
        self.forget_owned_session(&session_id).await;
        self.close_remote_session(&session_id).await;
        result
    }
}

//! Outbound request encoders — the `forward_*` methods that slice C's
//! routing layer in `api_agent.rs` calls. Each method shapes a JSON
//! request, then pushes it onto the supervisor's stdin writer channel.

use serde_json::{json, Value};

use super::supervisor::SidecarManager;
use crate::core::execution::SshConfig;

impl SidecarManager {
    /// Forward a start_session request to the sidecar.
    #[allow(clippy::too_many_arguments)]
    pub async fn forward_start(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        source_mcp_from_fs: bool,
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
            source_mcp_from_fs,
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
        source_mcp_from_fs: bool,
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
            source_mcp_from_fs,
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
        source_mcp_from_fs: bool,
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
        let req = encode_start_session(
            &session_id,
            provider,
            model,
            system_prompt,
            allowed_tools,
            mcp_servers,
            source_mcp_from_fs,
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
            command_path,
            workspace,
        );
        let result = self.send_json_for_session(&session_id, req).await;
        if result.is_err() {
            self.forget_owned_session(&session_id).await;
            self.close_remote_session(&session_id).await;
        }
        result
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

    /// Forward a permission decision to the sidecar. `reason`, when set on a
    /// deny, carries the user's steering text — providers fold it into the
    /// synthetic tool result so the model is redirected, not just refused.
    pub async fn forward_permission(
        &self,
        session_id: String,
        tool_use_id: String,
        decision: String,
        reason: Option<String>,
    ) -> Result<(), String> {
        let mut req = json!({
            "type": "permission_response",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "decision": decision,
        });
        if let Some(r) = reason {
            req["reason"] = json!(r);
        }
        self.send_json_for_session(&session_id, req).await
    }

    /// Forward a pending-edit approval/rejection to the sidecar. v3:
    /// `merged_content` carries an override file body for per-hunk
    /// acceptance — when present, the provider writes that content directly
    /// instead of letting the SDK's tool land its full `after`.
    pub async fn forward_edit(
        &self,
        session_id: String,
        tool_use_id: String,
        approved: bool,
        merged_content: Option<String>,
    ) -> Result<(), String> {
        let req = json!({
            "type": "edit_response",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
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

/// Encode a `start_session` request as the wire JSON the sidecar consumes.
/// Extracted as a pure seam so the wire shape — including S8-Phase-B's
/// `sourceMcpFromFs` flag — is unit-testable without a live supervisor.
#[allow(clippy::too_many_arguments)]
fn encode_start_session(
    session_id: &str,
    provider: String,
    model: String,
    system_prompt: String,
    allowed_tools: Vec<String>,
    mcp_servers: Value,
    source_mcp_from_fs: bool,
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
    command_path: Option<String>,
    workspace: Option<Value>,
) -> Value {
    json!({
        "type": "start_session",
        "sessionId": session_id,
        "provider": provider,
        "model": model,
        "systemPrompt": system_prompt,
        "allowedTools": allowed_tools,
        "mcpServers": mcp_servers,
        "sourceMcpFromFs": source_mcp_from_fs,
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
        "commandPath": command_path,
        "workspace": workspace.unwrap_or_else(|| {
            json!({
                "kind": "local",
                "projectPath": project_path,
            })
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_start_session_carries_source_mcp_from_fs_and_empty_servers() {
        // S8-Phase-B: a remote launch forwards an empty `mcpServers` map plus
        // `sourceMcpFromFs = true` so the sidecar sources its own remote FS
        // config — assert both land on the wire.
        let req = encode_start_session(
            "sess-1",
            "echo".to_string(),
            "echo".to_string(),
            String::new(),
            Vec::new(),
            json!({}),
            true,
            "/srv/app".to_string(),
            "hi".to_string(),
            None,
            None,
            None,
            None,
            Value::Null,
            Value::Null,
            None,
            None,
            None,
            None,
        );
        assert_eq!(req["type"], "start_session");
        assert_eq!(req["mcpServers"], json!({}));
        assert_eq!(req["sourceMcpFromFs"], json!(true));
    }

    #[test]
    fn encode_start_session_local_flag_off() {
        let req = encode_start_session(
            "sess-2",
            "echo".to_string(),
            "echo".to_string(),
            String::new(),
            Vec::new(),
            json!({ "srv": { "type": "stdio", "command": "node" } }),
            false,
            "/home/me/app".to_string(),
            "hi".to_string(),
            None,
            None,
            None,
            None,
            Value::Null,
            Value::Null,
            None,
            None,
            None,
            None,
        );
        assert_eq!(req["sourceMcpFromFs"], json!(false));
        assert_eq!(req["mcpServers"]["srv"]["command"], "node");
    }
}

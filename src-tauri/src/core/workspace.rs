use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridPosition {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspacePane {
    pub id: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub grid_position: GridPosition,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub pinned_commands: Option<Vec<String>>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub flight_id: Option<String>,
    #[serde(default)]
    pub agent_config_id: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub override_command: Option<String>,
    #[serde(default)]
    pub override_args: Option<Vec<String>>,
    /// Pane kind discriminant (tile program, P1-S1). `None` ⇒ terminal, so an
    /// old binary that never wrote this field degrades to a harmless terminal
    /// pane. `kind` is the SOLE discriminant; `agent_id` is never overloaded
    /// with "conversation" — conversation panes persist the inert carrier
    /// `agent_id: "terminal"`. Precedent: `task_id`/`flight_id` above.
    #[serde(default)]
    pub kind: Option<String>,
    /// Set iff `kind == Some("conversation")` — the owning conversation id.
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRepo {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub agents: Vec<String>,
    pub panes: Vec<WorkspacePane>,
    pub project_path: String,
    pub prompt: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub status: String,
    pub bypass_permissions: Option<bool>,
    pub model_overrides: Option<std::collections::HashMap<String, Option<String>>>,
    pub effort_overrides: Option<std::collections::HashMap<String, Option<String>>>,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub remote_project_path: Option<String>,
    #[serde(default)]
    pub github_repo: Option<GithubRepo>,
    /// Workspace origin marker (tile program, P1-S2). `Some("conversation")`
    /// tags an auto-materialized conversation wrapper (deterministic id
    /// `ws-wrap-<convId>`) created by `sessionGlue.openSession`. `None` ⇒ a
    /// normal user-created workspace, so an old binary that never wrote this
    /// field degrades cleanly. Inert `#[serde(default)]` mirror — same
    /// downgrade pattern as the pane-level `kind`/`conversation_id`.
    #[serde(default)]
    pub origin: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation_pane() -> WorkspacePane {
        WorkspacePane {
            id: "pane-conv".to_string(),
            // Inert carrier: conversation panes persist agent_id "terminal",
            // never "conversation" — `kind` is the sole discriminant.
            agent_id: "terminal".to_string(),
            session_id: None,
            grid_position: GridPosition { row: 0, col: 1 },
            accent_color: None,
            pinned_commands: None,
            task_id: None,
            flight_id: None,
            agent_config_id: None,
            initial_prompt: None,
            override_command: None,
            override_args: None,
            kind: Some("conversation".to_string()),
            conversation_id: Some("conv-123".to_string()),
        }
    }

    #[test]
    fn conversation_pane_serde_round_trips_kind_and_conversation_id() {
        let pane = conversation_pane();
        let json = serde_json::to_string(&pane).unwrap();
        let back: WorkspacePane = serde_json::from_str(&json).unwrap();

        assert_eq!(back.agent_id, "terminal");
        assert_eq!(back.kind.as_deref(), Some("conversation"));
        assert_eq!(back.conversation_id.as_deref(), Some("conv-123"));
    }

    #[test]
    fn old_binary_pane_without_kind_defaults_to_terminal() {
        // Simulate a pane written by an old binary that never knew about the
        // kind/conversation_id fields: both must default to None (terminal).
        let legacy = r#"{
            "id": "pane-1",
            "agent_id": "terminal",
            "session_id": null,
            "grid_position": { "row": 0, "col": 0 }
        }"#;
        let pane: WorkspacePane = serde_json::from_str(legacy).unwrap();

        assert_eq!(pane.agent_id, "terminal");
        assert!(pane.kind.is_none());
        assert!(pane.conversation_id.is_none());
    }

    fn wrapper_workspace() -> Workspace {
        Workspace {
            id: "ws-wrap-conv-123".to_string(),
            name: "my task".to_string(),
            agents: vec![],
            panes: vec![conversation_pane()],
            project_path: "/proj".to_string(),
            prompt: None,
            created_at: 1,
            updated_at: 1,
            status: "active".to_string(),
            bypass_permissions: None,
            model_overrides: None,
            effort_overrides: None,
            server_id: None,
            remote_project_path: None,
            github_repo: None,
            origin: Some("conversation".to_string()),
        }
    }

    #[test]
    fn wrapper_workspace_origin_round_trips() {
        let ws = wrapper_workspace();
        let json = serde_json::to_string(&ws).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.origin.as_deref(), Some("conversation"));
    }

    #[test]
    fn old_binary_workspace_without_origin_defaults_to_none() {
        // A workspace written by an old binary that never knew about `origin`
        // must default to None — an inert #[serde(default)] mirror.
        let legacy = r#"{
            "id": "ws-1",
            "name": "legacy",
            "agents": [],
            "panes": [],
            "project_path": "/proj",
            "prompt": null,
            "created_at": 1,
            "updated_at": 1,
            "status": "active",
            "bypass_permissions": null,
            "model_overrides": null,
            "effort_overrides": null
        }"#;
        let ws: Workspace = serde_json::from_str(legacy).unwrap();
        assert!(ws.origin.is_none());
    }

    #[test]
    fn old_binary_resave_strips_carrier_to_plain_terminal() {
        // Round-trip through a struct that has NO knowledge of the new fields
        // (the shape an old binary would re-serialize) and confirm the pane
        // parses back as a plain terminal pane — the inert-carrier arm, not a
        // deserialization failure. The full self-heal sweep lands in P1-S2.
        #[derive(serde::Serialize, serde::Deserialize)]
        struct LegacyPane {
            id: String,
            agent_id: String,
            session_id: Option<String>,
            grid_position: GridPosition,
        }

        let conv = conversation_pane();
        // An old binary re-serializing only knows the legacy fields.
        let legacy = LegacyPane {
            id: conv.id.clone(),
            agent_id: conv.agent_id.clone(),
            session_id: conv.session_id.clone(),
            grid_position: conv.grid_position.clone(),
        };
        let json = serde_json::to_string(&legacy).unwrap();
        let reloaded: WorkspacePane = serde_json::from_str(&json).unwrap();

        assert_eq!(reloaded.agent_id, "terminal");
        assert!(reloaded.kind.is_none());
        assert!(reloaded.conversation_id.is_none());
    }
}

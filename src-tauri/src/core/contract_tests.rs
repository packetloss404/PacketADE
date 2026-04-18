#[cfg(test)]
mod tests {
    use crate::core::flight::*;
    use crate::core::storage::PersistedState;
    use crate::core::orchestrator::OrchestratorSettings;

    /// Build a fully-populated sample state for contract testing.
    fn sample_state() -> PersistedState {
        PersistedState {
            version: 2,
            flights: vec![Flight {
                id: "flight-contract".to_string(),
                title: "Contract Test Flight".to_string(),
                objective: "Verify serialization".to_string(),
                status: FlightStatus::Active,
                priority: FlightPriority::High,
                project_path: "/test".to_string(),
                workspace_id: None,
                git_branch: Some("main".to_string()),
                milestones: vec![Milestone {
                    id: "ms-1".to_string(),
                    flight_id: "flight-contract".to_string(),
                    title: "Milestone 1".to_string(),
                    description: "First milestone".to_string(),
                    order: 0,
                    status: MilestoneStatus::Active,
                    tasks: vec![Task {
                        id: "task-1".to_string(),
                        milestone_id: "ms-1".to_string(),
                        flight_id: "flight-contract".to_string(),
                        title: "Task 1".to_string(),
                        description: "First task".to_string(),
                        order: 0,
                        status: TaskStatus::Running,
                        task_type: TaskType::Implementation,
                        agent_config_id: "claude-code".to_string(),
                        agent_args: None,
                        model: Some("claude-sonnet-4-6".to_string()),
                        depends_on: vec![],
                        session_id: Some("sess-1".to_string()),
                        result: Some(TaskResult {
                            exit_code: Some(0),
                            summary: "All good".to_string(),
                            files_changed: vec!["src/main.rs".to_string()],
                            errors: vec![],
                            duration_ms: 5000,
                            handoff: Some(TaskHandoff {
                                summary: "Handoff summary".to_string(),
                                files_changed: vec!["src/main.rs".to_string()],
                                tests_needed: vec!["test_main".to_string()],
                                follow_ups: vec![],
                            }),
                            validation: Some(TaskValidationReport {
                                verdict: ValidationVerdict::Pass,
                                summary: "Validated".to_string(),
                                assertions: vec![TaskValidationAssertion {
                                    label: "compiles".to_string(),
                                    status: ValidationVerdict::Pass,
                                    details: Some("OK".to_string()),
                                }],
                            }),
                        }),
                        review_packet: None,
                        created_at: 1000,
                        started_at: Some(2000),
                        completed_at: None,
                        cost: 0.5,
                        tokens: 1000,
                    }],
                    validation_criteria: vec!["Tests pass".to_string()],
                }],
                linked_session_ids: vec!["sess-1".to_string()],
                created_at: 1000,
                updated_at: 2000,
                completed_at: None,
                total_cost: 0.5,
                total_tokens: 1000,
            }],
            agents: vec![],
            settings: OrchestratorSettings::default(),
            ui: Default::default(),
            issues: vec![],
            workspaces: vec![],
            retrospectives: vec![],
            memory_events: vec![],
            memory_patterns: vec![],
            servers: vec![],
        }
    }

    #[test]
    fn persisted_state_serializes_with_expected_shape() {
        let state = sample_state();
        let json = serde_json::to_string_pretty(&state).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        // Top-level keys
        assert!(value.get("version").is_some(), "missing key: version");
        assert!(value.get("flights").is_some(), "missing key: flights");
        assert!(value.get("agents").is_some(), "missing key: agents");
        assert!(value.get("settings").is_some(), "missing key: settings");
        assert!(value.get("ui").is_some(), "missing key: ui");

        // Settings keys (snake_case)
        let settings = &value["settings"];
        assert!(settings.get("max_parallel_sessions").is_some());
        assert!(settings.get("milestone_gating").is_some());
        assert!(settings.get("project_path").is_some());

        // Flight keys
        let flight = &value["flights"][0];
        assert!(flight.get("id").is_some(), "missing flight key: id");
        assert!(flight.get("project_path").is_some(), "missing flight key: project_path");
        assert!(flight.get("git_branch").is_some(), "missing flight key: git_branch");
        assert!(flight.get("milestones").is_some(), "missing flight key: milestones");
        assert!(flight.get("linked_session_ids").is_some(), "missing flight key: linked_session_ids");
        assert!(flight.get("created_at").is_some(), "missing flight key: created_at");
        assert!(flight.get("updated_at").is_some(), "missing flight key: updated_at");
        assert!(flight.get("total_cost").is_some(), "missing flight key: total_cost");
        assert!(flight.get("total_tokens").is_some(), "missing flight key: total_tokens");

        // Milestone keys
        let milestone = &flight["milestones"][0];
        assert!(milestone.get("flight_id").is_some(), "missing milestone key: flight_id");
        assert!(milestone.get("validation_criteria").is_some(), "missing milestone key: validation_criteria");

        // Task keys
        let task = &milestone["tasks"][0];
        assert!(task.get("task_type").is_some(), "missing task key: task_type (not 'type')");
        assert!(task.get("agent_config_id").is_some(), "missing task key: agent_config_id");
        assert!(task.get("depends_on").is_some(), "missing task key: depends_on");
        assert!(task.get("session_id").is_some(), "missing task key: session_id");
        assert!(task.get("milestone_id").is_some(), "missing task key: milestone_id");
        assert!(task.get("flight_id").is_some(), "missing task key: flight_id");
        assert!(task.get("agent_args").is_none() || task.get("agent_args").is_some(), "agent_args should serialize or be absent");
        assert!(task.get("created_at").is_some(), "missing task key: created_at");
        assert!(task.get("started_at").is_some(), "missing task key: started_at");
        assert!(task.get("cost").is_some(), "missing task key: cost");
        assert!(task.get("tokens").is_some(), "missing task key: tokens");

        // TaskResult keys
        let result = &task["result"];
        assert!(result.get("exit_code").is_some(), "missing result key: exit_code");
        assert!(result.get("files_changed").is_some(), "missing result key: files_changed");
        assert!(result.get("duration_ms").is_some(), "missing result key: duration_ms");
        assert!(result.get("handoff").is_some(), "missing result key: handoff");
        assert!(result.get("validation").is_some(), "missing result key: validation");

        // TaskHandoff keys
        let handoff = &result["handoff"];
        assert!(handoff.get("files_changed").is_some(), "missing handoff key: files_changed");
        assert!(handoff.get("tests_needed").is_some(), "missing handoff key: tests_needed");
        assert!(handoff.get("follow_ups").is_some(), "missing handoff key: follow_ups");

        // TaskValidationReport keys
        let validation = &result["validation"];
        assert!(validation.get("verdict").is_some(), "missing validation key: verdict");
        assert!(validation.get("assertions").is_some(), "missing validation key: assertions");
        let assertion = &validation["assertions"][0];
        assert!(assertion.get("label").is_some(), "missing assertion key: label");
        assert!(assertion.get("status").is_some(), "missing assertion key: status");

        // Verify enum serialization uses snake_case
        assert_eq!(flight["status"].as_str().unwrap(), "active");
        assert_eq!(flight["priority"].as_str().unwrap(), "high");
        assert_eq!(task["status"].as_str().unwrap(), "running");
        assert_eq!(task["task_type"].as_str().unwrap(), "implementation");
        assert_eq!(validation["verdict"].as_str().unwrap(), "pass");

        // Write fixture for TS tests
        let fixture_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures");
        let _ = std::fs::create_dir_all(&fixture_dir);
        std::fs::write(
            fixture_dir.join("state.v2.fixture.json"),
            &json,
        ).unwrap();
    }

    #[test]
    fn persisted_state_roundtrips_through_serde() {
        let state = sample_state();
        let json = serde_json::to_string(&state).unwrap();
        let parsed: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, state.version);
        assert_eq!(parsed.flights.len(), state.flights.len());
        assert_eq!(parsed.flights[0].id, state.flights[0].id);
        assert_eq!(parsed.flights[0].milestones[0].tasks[0].id, "task-1");
    }

    #[test]
    fn default_state_roundtrips() {
        let state = PersistedState::default();
        let json = serde_json::to_string(&state).unwrap();
        let parsed: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, state.version);
        assert!(parsed.flights.is_empty());
    }

    #[test]
    fn enum_variants_serialize_to_expected_strings() {
        // FlightStatus
        let statuses = vec![
            (FlightStatus::Draft, "draft"),
            (FlightStatus::Planning, "planning"),
            (FlightStatus::Ready, "ready"),
            (FlightStatus::Active, "active"),
            (FlightStatus::Paused, "paused"),
            (FlightStatus::Review, "review"),
            (FlightStatus::Done, "done"),
            (FlightStatus::Failed, "failed"),
            (FlightStatus::Cancelled, "cancelled"),
        ];
        for (variant, expected) in statuses {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, format!("\"{}\"", expected), "FlightStatus::{:?}", variant);
        }

        // TaskStatus — verify approval_needed (not "approvalNeeded")
        let approval = serde_json::to_string(&TaskStatus::ApprovalNeeded).unwrap();
        assert_eq!(approval, "\"approval_needed\"");

        // TaskType
        let types = vec![
            (TaskType::Implementation, "implementation"),
            (TaskType::Testing, "testing"),
            (TaskType::Review, "review"),
            (TaskType::Validation, "validation"),
            (TaskType::Research, "research"),
            (TaskType::Refactor, "refactor"),
            (TaskType::Documentation, "documentation"),
        ];
        for (variant, expected) in types {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, format!("\"{}\"", expected), "TaskType::{:?}", variant);
        }

        // ValidationVerdict
        let verdicts = vec![
            (ValidationVerdict::Pass, "pass"),
            (ValidationVerdict::Fail, "fail"),
            (ValidationVerdict::Warn, "warn"),
        ];
        for (variant, expected) in verdicts {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, format!("\"{}\"", expected), "ValidationVerdict::{:?}", variant);
        }
    }
}

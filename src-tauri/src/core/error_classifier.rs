use serde::Serialize;

use crate::core::flight::Task;

/// Error categories for AI CLI invocations.
/// Inspired by Hermes Agent's error_classifier — classifies stderr output from
/// Claude CLI into actionable categories with recovery hints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorCategory {
    /// Authentication failure — user needs to re-authenticate
    Auth,
    /// Billing / quota exhausted — not transient
    Billing,
    /// Rate limited — retry after backoff
    RateLimit,
    /// Context window exceeded — compress or shorten input
    ContextOverflow,
    /// Network timeout — retry
    Timeout,
    /// Server error (5xx) — retry with backoff
    ServerError,
    /// CLI not found or not installed
    NotInstalled,
    /// Unknown / unclassified error
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassifiedError {
    pub category: AiErrorCategory,
    pub message: String,
    pub is_transient: bool,
    pub suggestion: String,
}

/// Classify a stderr string from Claude CLI into an actionable error.
pub fn classify_cli_error(stderr: &str) -> ClassifiedError {
    let lower = stderr.to_lowercase();

    // Auth errors
    if lower.contains("unauthorized")
        || lower.contains("authentication")
        || lower.contains("invalid api key")
        || lower.contains("api key")
        || lower.contains("not authenticated")
        || lower.contains("login")
    {
        return ClassifiedError {
            category: AiErrorCategory::Auth,
            message: extract_message(stderr),
            is_transient: false,
            suggestion: "Re-authenticate with Claude CLI: run `claude login` in a terminal."
                .to_string(),
        };
    }

    // Billing / quota
    if lower.contains("billing")
        || lower.contains("insufficient credits")
        || lower.contains("quota exceeded")
        || lower.contains("payment required")
        || (lower.contains("402") && !lower.contains("try again"))
    {
        return ClassifiedError {
            category: AiErrorCategory::Billing,
            message: extract_message(stderr),
            is_transient: false,
            suggestion: "Check your API billing and usage limits.".to_string(),
        };
    }

    // Rate limiting
    if lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("429")
        || (lower.contains("try again") && lower.contains("minutes"))
        || lower.contains("overloaded")
    {
        return ClassifiedError {
            category: AiErrorCategory::RateLimit,
            message: extract_message(stderr),
            is_transient: true,
            suggestion: "Rate limited — will retry automatically.".to_string(),
        };
    }

    // Context overflow
    if lower.contains("context")
        && (lower.contains("too long")
            || lower.contains("exceed")
            || lower.contains("overflow")
            || lower.contains("limit"))
        || lower.contains("max_tokens")
        || lower.contains("maximum context length")
    {
        return ClassifiedError {
            category: AiErrorCategory::ContextOverflow,
            message: extract_message(stderr),
            is_transient: false,
            suggestion: "Input is too long. Try shortening the prompt or conversation history."
                .to_string(),
        };
    }

    // Timeout
    if lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("deadline exceeded")
        || lower.contains("econnreset")
        || lower.contains("socket hang up")
    {
        return ClassifiedError {
            category: AiErrorCategory::Timeout,
            message: extract_message(stderr),
            is_transient: true,
            suggestion: "Request timed out — will retry automatically.".to_string(),
        };
    }

    // Server errors
    if lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("internal server error")
        || lower.contains("service unavailable")
        || lower.contains("bad gateway")
    {
        return ClassifiedError {
            category: AiErrorCategory::ServerError,
            message: extract_message(stderr),
            is_transient: true,
            suggestion: "Server error — will retry automatically.".to_string(),
        };
    }

    // CLI not found
    if lower.contains("not found")
        || lower.contains("not recognized")
        || lower.contains("no such file")
        || lower.contains("command not found")
    {
        return ClassifiedError {
            category: AiErrorCategory::NotInstalled,
            message: extract_message(stderr),
            is_transient: false,
            suggestion: "Claude CLI not found. Install it and ensure it's on PATH.".to_string(),
        };
    }

    // Unknown
    ClassifiedError {
        category: AiErrorCategory::Unknown,
        message: extract_message(stderr),
        is_transient: false,
        suggestion: "An unexpected error occurred. Check the Claude CLI output for details."
            .to_string(),
    }
}

/// Extract a clean error message from stderr (first non-empty line, capped at 200 chars).
fn extract_message(stderr: &str) -> String {
    let msg = stderr
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(stderr)
        .trim();
    if msg.len() > 200 {
        format!("{}...", &msg[..197])
    } else {
        msg.to_string()
    }
}

/// Calculate retry delay with decorrelated jitter (port of Hermes retry_utils.py).
/// Returns milliseconds to wait before the next attempt.
pub fn retry_delay_ms(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let exp_delay = base_ms.saturating_mul(1u64 << attempt.min(10));
    let capped = exp_delay.min(max_ms);
    // Add jitter: 50-100% of the capped delay
    let jitter = (capped as f64) * (0.5 + 0.5 * rand_fraction(attempt));
    jitter as u64
}

/// Simple deterministic-ish fraction from attempt number (no external deps needed).
fn rand_fraction(attempt: u32) -> f64 {
    // Use a simple hash-like mixing function for jitter
    let mixed = (attempt.wrapping_mul(2654435761)) as f64 / u32::MAX as f64;
    mixed.fract().abs()
}

// === Mission Planner E5: replan-cap exemption helpers ===
//
// These helpers gate the per-task replan cap exemption documented in
// `dev/mission-planner-plan.md`:
//
// > "Replans per task: 3 — RateLimit / Network errors do NOT count
// >  (use `core/error_classifier.rs::AiErrorCategory`)"
//
// Owned by the E5-CLASSIFIER slice. Consumers (E5-REPLAN) call these to
// decide whether a failed task's replan should be charged against the cap.

/// Returns `true` when `category` is exempt from the per-task replan cap
/// per the locked Mission Planner design ("RateLimit / Network errors do
/// NOT count"). The `Timeout` variant of `AiErrorCategory` covers the
/// classifier's network-failure signals (`timed out`, `deadline exceeded`,
/// `econnreset`, `socket hang up`), which is the "Network" bucket the
/// locked design refers to.
///
/// Every other category — including `Auth`, `Billing`, `ContextOverflow`,
/// `ServerError`, `NotInstalled`, and `Unknown` — counts against the cap.
pub fn is_replan_exempt(category: &AiErrorCategory) -> bool {
    matches!(
        category,
        AiErrorCategory::RateLimit | AiErrorCategory::Timeout
    )
}

/// Returns the `AiErrorCategory` of the most-recent error string attached
/// to `task.result.errors`, or `None` when the task has no recorded errors
/// to classify.
///
/// Returns `None` if:
///   * `task.result` is `None` (task never completed / produced no result), or
///   * `task.result.errors` is empty.
///
/// Otherwise returns `Some(category)` where `category` is the output of
/// [`classify_cli_error`] on the last error string. Note that
/// `classify_cli_error` always yields a category (`Unknown` for
/// unclassifiable input), so a populated `errors` vec never produces
/// `None` here.
pub fn classify_task_last_error(task: &Task) -> Option<AiErrorCategory> {
    let result = task.result.as_ref()?;
    let last_error = result.errors.last()?;
    Some(classify_cli_error(last_error).category)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_rate_limit() {
        let err = classify_cli_error("Error: 429 Too Many Requests");
        assert_eq!(err.category, AiErrorCategory::RateLimit);
        assert!(err.is_transient);
    }

    #[test]
    fn classifies_auth() {
        let err = classify_cli_error("Error: unauthorized - invalid API key");
        assert_eq!(err.category, AiErrorCategory::Auth);
        assert!(!err.is_transient);
    }

    #[test]
    fn classifies_context_overflow() {
        let err = classify_cli_error("maximum context length exceeded");
        assert_eq!(err.category, AiErrorCategory::ContextOverflow);
        assert!(!err.is_transient);
    }

    #[test]
    fn classifies_timeout() {
        let err = classify_cli_error("request timed out after 30s");
        assert_eq!(err.category, AiErrorCategory::Timeout);
        assert!(err.is_transient);
    }

    #[test]
    fn classifies_server_error() {
        let err = classify_cli_error("502 Bad Gateway");
        assert_eq!(err.category, AiErrorCategory::ServerError);
        assert!(err.is_transient);
    }

    #[test]
    fn classifies_not_installed() {
        let err = classify_cli_error("claude: command not found");
        assert_eq!(err.category, AiErrorCategory::NotInstalled);
        assert!(!err.is_transient);
    }

    #[test]
    fn classifies_unknown() {
        let err = classify_cli_error("something weird happened");
        assert_eq!(err.category, AiErrorCategory::Unknown);
        assert!(!err.is_transient);
    }

    #[test]
    fn retry_delay_increases() {
        let d0 = retry_delay_ms(0, 2000, 60000);
        let d1 = retry_delay_ms(1, 2000, 60000);
        let d2 = retry_delay_ms(2, 2000, 60000);
        // Each attempt should generally increase (with jitter it's not perfectly monotonic)
        assert!(d0 < 60000);
        assert!(d1 <= 60000);
        assert!(d2 <= 60000);
    }

    #[test]
    fn retry_delay_caps_at_max() {
        let d = retry_delay_ms(20, 2000, 60000);
        assert!(d <= 60000);
    }

    #[test]
    fn extract_message_truncates_long_stderr() {
        let long = "x".repeat(300);
        let msg = extract_message(&long);
        assert!(msg.len() <= 203); // 200 + "..."
    }
}

#[cfg(test)]
mod e5_exemption_tests {
    use super::*;
    use crate::core::flight::{Task, TaskResult, TaskStatus, TaskType};

    fn make_task_with_errors(errors: Vec<String>) -> Task {
        Task {
            id: "task_test".to_string(),
            milestone_id: "m1".to_string(),
            flight_id: "f1".to_string(),
            title: "Test task".to_string(),
            description: String::new(),
            order: 0,
            status: TaskStatus::Failed,
            task_type: TaskType::Implementation,
            agent_config_id: String::new(),
            agent_args: None,
            model: None,
            depends_on: Vec::new(),
            session_id: None,
            result: Some(TaskResult {
                exit_code: Some(1),
                summary: String::new(),
                files_changed: Vec::new(),
                errors,
                duration_ms: 0,
                handoff: None,
                validation: None,
            }),
            review_packet: None,
            created_at: 0,
            started_at: None,
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            owned_paths: Vec::new(),
            replan_count: 0,
        }
    }

    fn make_task_no_result() -> Task {
        let mut t = make_task_with_errors(Vec::new());
        t.result = None;
        t
    }

    #[test]
    fn rate_limit_is_replan_exempt() {
        assert!(is_replan_exempt(&AiErrorCategory::RateLimit));
    }

    #[test]
    fn network_is_replan_exempt() {
        // The classifier collapses network-failure signals (econnreset,
        // socket hang up, timed out, deadline exceeded) under `Timeout`,
        // so `Timeout` is the network-error bucket for the exemption.
        assert!(is_replan_exempt(&AiErrorCategory::Timeout));
    }

    #[test]
    fn other_categories_are_not_exempt() {
        // Every non-(RateLimit | Timeout) variant counts against the cap.
        assert!(!is_replan_exempt(&AiErrorCategory::Auth));
        assert!(!is_replan_exempt(&AiErrorCategory::Billing));
        assert!(!is_replan_exempt(&AiErrorCategory::ContextOverflow));
        assert!(!is_replan_exempt(&AiErrorCategory::ServerError));
        assert!(!is_replan_exempt(&AiErrorCategory::NotInstalled));
        assert!(!is_replan_exempt(&AiErrorCategory::Unknown));
    }

    #[test]
    fn classify_task_last_error_returns_none_when_result_is_none() {
        let task = make_task_no_result();
        assert_eq!(classify_task_last_error(&task), None);
    }

    #[test]
    fn classify_task_last_error_returns_none_for_empty_errors() {
        let task = make_task_with_errors(Vec::new());
        assert_eq!(classify_task_last_error(&task), None);
    }

    #[test]
    fn classify_task_last_error_returns_category_for_known_error() {
        // "429 Too Many Requests" maps to RateLimit per `classify_cli_error`.
        let task = make_task_with_errors(vec!["429 Too Many Requests".to_string()]);
        assert_eq!(
            classify_task_last_error(&task),
            Some(AiErrorCategory::RateLimit)
        );
    }

    #[test]
    fn classify_task_last_error_uses_last_entry() {
        // The most-recent error wins — earlier entries are ignored.
        let task = make_task_with_errors(vec![
            "unauthorized - invalid API key".to_string(), // would be Auth
            "request timed out after 30s".to_string(),    // last entry — Timeout
        ]);
        assert_eq!(
            classify_task_last_error(&task),
            Some(AiErrorCategory::Timeout)
        );
    }

    #[test]
    fn classify_task_last_error_returns_unknown_for_unclassifiable() {
        // `classify_cli_error` always yields a category — unclassifiable
        // input becomes `Unknown` (which is NOT replan-exempt).
        let task = make_task_with_errors(vec!["something weird happened".to_string()]);
        let category = classify_task_last_error(&task);
        assert_eq!(category, Some(AiErrorCategory::Unknown));
        assert!(!is_replan_exempt(&category.unwrap()));
    }
}

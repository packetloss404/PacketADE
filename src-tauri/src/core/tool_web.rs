//! Host-agnostic web fetch tool for API-based agents.
//!
//! Always runs from the PacketADE process — never tunneled through SSH.
//! Fetches a URL, strips HTML to plain text when applicable, and truncates
//! oversized payloads.

use crate::core::llm_types::ToolDefinition;
use std::time::Duration;
use tracing::info;

const DEFAULT_MAX_CHARS: usize = 50_000;
const FETCH_TIMEOUT_SECS: u64 = 15;
const USER_AGENT: &str = concat!("PacketADE/1.0 (+desktop coding agent)");

/// Tool definition the LLM sees.
pub fn web_fetch_definition() -> ToolDefinition {
    ToolDefinition {
        name: "web_fetch".to_string(),
        description: "Fetch a URL and return its main content as plain text. Useful for reading documentation, API references, blog posts, etc. Truncates very large pages. Does not execute JavaScript.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The http:// or https:// URL to fetch."
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Maximum characters to return (default 50000). Output is truncated past this length."
                }
            },
            "required": ["url"]
        }),
    }
}

/// Execute a web_fetch tool call.
pub async fn execute_web_fetch(args: &serde_json::Value) -> Result<String, String> {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url' parameter")?
        .trim();

    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!(
            "Invalid URL '{}': must start with http:// or https://",
            url
        ));
    }

    let max_chars = args
        .get("max_chars")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_CHARS)
        .max(1);

    info!(url = %url, max_chars = %max_chars, "Tool: web_fetch");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("Unknown");
        return Err(format!("HTTP {}: {}", status.as_u16(), reason));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read body: {}", e))?;

    let plain = if content_type.contains("html") {
        html_to_text(&body)
    } else {
        body
    };

    Ok(truncate(&plain, max_chars))
}

/// Strip HTML to plain text using a tiny inline strategy.
fn html_to_text(html: &str) -> String {
    // Strip <script>...</script> and <style>...</style> blocks (case-insensitive, multiline).
    let script_re = regex::Regex::new(r"(?is)<script\b[^>]*>.*?</script>").unwrap();
    let style_re = regex::Regex::new(r"(?is)<style\b[^>]*>.*?</style>").unwrap();
    let tag_re = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let ws_re = regex::Regex::new(r"\s+").unwrap();

    let stripped = script_re.replace_all(html, " ");
    let stripped = style_re.replace_all(&stripped, " ");
    let no_tags = tag_re.replace_all(&stripped, " ");

    let decoded = decode_entities(&no_tags);
    ws_re.replace_all(&decoded, " ").trim().to_string()
}

/// Decode a small set of common HTML entities.
fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Truncate to `max_chars` (by char count, not bytes), appending a marker if cut.
fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push_str("\n\n[truncated]");
    out
}

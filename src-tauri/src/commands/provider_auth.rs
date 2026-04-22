use crate::commands::api_keys::get_api_key_exists;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Unix timestamp (seconds since epoch) for "now", or 0 if the system clock
/// is misbehaving.
fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Format a human-friendly relative expiry hint from an absolute Unix-seconds
/// expiry timestamp (e.g. `"Expires in 4 hours"`, `"Expires in 2 days"`,
/// `"Expired"`).
///
/// Buckets chosen to match what the UI actually wants to show in a small hint
/// chip — we don't need sub-hour precision, and beyond a few weeks users
/// don't care about the exact number.
fn format_relative_expiry(expires_at_unix_secs: i64) -> String {
    let now = now_unix_secs();
    let delta = expires_at_unix_secs - now;
    if delta <= 0 {
        return "Expired".to_string();
    }
    let mins = delta / 60;
    let hours = delta / 3600;
    let days = delta / 86_400;
    let weeks = delta / (86_400 * 7);

    if mins < 60 {
        if mins <= 1 {
            "Expires in 1 minute".to_string()
        } else {
            format!("Expires in {} minutes", mins)
        }
    } else if hours < 48 {
        if hours == 1 {
            "Expires in 1 hour".to_string()
        } else {
            format!("Expires in {} hours", hours)
        }
    } else if days < 14 {
        format!("Expires in {} days", days)
    } else {
        // days >= 14 so weeks >= 2
        format!("Expires in {} weeks", weeks)
    }
}

/// Turn a parsed expiry (Unix seconds) into a probe status.
///
/// - expired + refresh token available → `ready` with
///   "Session will auto-refresh on next use" (the Claude Agent SDK and
///   Codex CLI both refresh transparently when they receive an expired
///   access token alongside a valid refresh token — telling the user to
///   log in again when they don't need to would be a regression).
/// - expired + no refresh token → `login_required` with `run_again_hint`.
/// - within 72h → `ready` with "Expires in …" hint.
/// - further out → `ready` with empty hint.
///
/// We can't detect whether the refresh token itself has expired from the
/// credential file (it's opaque for Codex, and Claude doesn't surface
/// `refreshTokenExpiresAt`). If the refresh attempt fails on next use,
/// the SDK/CLI will surface its own error and the fs watcher will pick
/// up the credential-file change when the user re-logs in.
fn expiry_to_status(
    expires_at_unix_secs: i64,
    has_refresh_token: bool,
    run_again_hint: &str,
) -> ProviderAuthStatus {
    let now = now_unix_secs();
    let delta = expires_at_unix_secs - now;
    if delta <= 0 {
        if has_refresh_token {
            return ProviderAuthStatus {
                status: "ready".to_string(),
                hint: "Session will auto-refresh on next use".to_string(),
            };
        }
        return ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: run_again_hint.to_string(),
        };
    }
    let within_72h = delta <= 72 * 3600;
    ProviderAuthStatus {
        status: "ready".to_string(),
        hint: if within_72h {
            format_relative_expiry(expires_at_unix_secs)
        } else {
            String::new()
        },
    }
}

/// Attempt to extract Claude OAuth expiry from a credentials file.
///
/// The Claude Code credentials file is JSON of the shape:
/// ```json
/// { "claudeAiOauth": { "expiresAt": 1777000000000, ... } }
/// ```
/// where `expiresAt` is Unix **milliseconds**.
///
/// Returns `None` if anything about the shape is unexpected — callers should
/// then fall back to the legacy "file exists = ready" behavior.
fn parse_claude_expiry_secs(bytes: &[u8]) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let millis = v
        .get("claudeAiOauth")
        .and_then(|o| o.get("expiresAt"))
        .and_then(|e| e.as_i64())?;
    Some(millis / 1000)
}

/// True if the Claude credentials file contains a non-empty
/// `claudeAiOauth.refreshToken`. The Claude Agent SDK will use this to
/// refresh an expired access token transparently.
fn parse_claude_has_refresh_token(bytes: &[u8]) -> bool {
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    v.get("claudeAiOauth")
        .and_then(|o| o.get("refreshToken"))
        .and_then(|s| s.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Decode a base64url-encoded segment (no padding, `-`/`_` alphabet) into raw
/// bytes.
///
/// Used to peek at JWT payloads. Accepts the standard base64 alphabet too.
/// Returns `None` on any decoding error.
fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len() * 3 / 4 + 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &c in bytes {
        let val: u32 = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Attempt to extract Codex OAuth expiry from an `auth.json` file.
///
/// The Codex CLI stores OAuth tokens in JSON of the shape:
/// ```json
/// { "tokens": { "access_token": "<JWT>", ... }, "last_refresh": "…" }
/// ```
/// The `access_token` is a JWT whose payload carries an `exp` claim in Unix
/// **seconds**. `last_refresh` is RFC3339 but reflects the refresh time, not
/// expiry — so we parse the JWT payload instead.
///
/// Returns `None` if the shape or JWT can't be parsed — callers fall back to
/// the legacy "file exists = ready" behavior.
fn parse_codex_expiry_secs(bytes: &[u8]) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let token = v
        .get("tokens")
        .and_then(|t| t.get("access_token"))
        .and_then(|s| s.as_str())?;
    let payload_b64 = token.split('.').nth(1)?;
    let payload_bytes = base64url_decode(payload_b64)?;
    let payload: serde_json::Value = serde_json::from_slice(&payload_bytes).ok()?;
    payload.get("exp").and_then(|e| e.as_i64())
}

/// True if the Codex auth file contains a non-empty
/// `tokens.refresh_token`. The Codex CLI will use this to refresh an
/// expired access token on its next run.
fn parse_codex_has_refresh_token(bytes: &[u8]) -> bool {
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    v.get("tokens")
        .and_then(|t| t.get("refresh_token"))
        .and_then(|s| s.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Probe whether the user has logged into Claude Code (`claude login`).
///
/// Claude Code stores OAuth credentials in `~/.claude/credentials` on some
/// platforms/versions and `~/.claude/.credentials.json` on others, so we
/// check both paths. If the file parses as JSON and has a usable
/// `claudeAiOauth.expiresAt` field, we surface expiry information; otherwise
/// we fall back to the legacy "non-empty file = ready" behavior.
pub(crate) fn probe_claude_oauth() -> ProviderAuthStatus {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return ProviderAuthStatus {
                status: "login_required".to_string(),
                hint: "Run `claude login` in a terminal".to_string(),
            };
        }
    };
    let candidates = [
        home.join(".claude").join("credentials"),
        home.join(".claude").join(".credentials.json"),
    ];
    let mut any_found = false;
    for path in &candidates {
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() => {
                any_found = true;
                if meta.len() == 0 {
                    continue;
                }
                // Try to parse + extract expiry. Fall back to "ready" with
                // empty hint if anything about the format is unexpected —
                // we don't want a credentials-format change to brick the
                // status indicator.
                match std::fs::read(path) {
                    Ok(bytes) => {
                        if let Some(exp_secs) = parse_claude_expiry_secs(&bytes) {
                            return expiry_to_status(
                                exp_secs,
                                parse_claude_has_refresh_token(&bytes),
                                "Token expired — run `claude login` again",
                            );
                        }
                        return ProviderAuthStatus {
                            status: "ready".to_string(),
                            hint: String::new(),
                        };
                    }
                    Err(_) => {
                        return ProviderAuthStatus {
                            status: "login_required".to_string(),
                            hint: "Claude credentials unreadable".to_string(),
                        };
                    }
                }
            }
            Ok(_) => {
                // Exists but isn't a regular file — treat as unreadable.
                any_found = true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return ProviderAuthStatus {
                    status: "login_required".to_string(),
                    hint: "Claude credentials unreadable".to_string(),
                };
            }
        }
    }
    if any_found {
        // Found but empty / not a regular file.
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: "Claude credentials unreadable".to_string(),
        }
    } else {
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: "Run `claude login` in a terminal".to_string(),
        }
    }
}

/// Probe whether the user has logged into Codex CLI (`codex login` /
/// `codex auth login`).
///
/// Codex stores OAuth credentials under `~/.codex/` — depending on CLI
/// version, the token file may be `auth.json` or `credentials`, so we
/// check both paths. When `auth.json` is present we parse its JWT
/// `access_token` to surface expiry; otherwise we fall back to the legacy
/// "non-empty file = ready" behavior.
pub(crate) fn probe_codex_oauth() -> ProviderAuthStatus {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return ProviderAuthStatus {
                status: "login_required".to_string(),
                hint: "Run `codex login` in a terminal".to_string(),
            };
        }
    };
    let candidates = [
        home.join(".codex").join("auth.json"),
        home.join(".codex").join("credentials"),
    ];
    let mut any_found = false;
    for path in &candidates {
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() => {
                any_found = true;
                if meta.len() == 0 {
                    continue;
                }
                match std::fs::read(path) {
                    Ok(bytes) => {
                        if let Some(exp_secs) = parse_codex_expiry_secs(&bytes) {
                            return expiry_to_status(
                                exp_secs,
                                parse_codex_has_refresh_token(&bytes),
                                "Token expired — run `codex login` again",
                            );
                        }
                        return ProviderAuthStatus {
                            status: "ready".to_string(),
                            hint: String::new(),
                        };
                    }
                    Err(_) => {
                        return ProviderAuthStatus {
                            status: "login_required".to_string(),
                            hint: "Codex credentials unreadable".to_string(),
                        };
                    }
                }
            }
            Ok(_) => {
                // Exists but isn't a regular file — treat as unreadable.
                any_found = true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return ProviderAuthStatus {
                    status: "login_required".to_string(),
                    hint: "Codex credentials unreadable".to_string(),
                };
            }
        }
    }
    if any_found {
        // Found but empty / not a regular file.
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: "Codex credentials unreadable".to_string(),
        }
    } else {
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: "Run `codex login` in a terminal".to_string(),
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct ProviderAuthStatus {
    pub status: String,
    pub hint: String,
}

#[tauri::command]
pub async fn get_provider_auth_status(provider: String) -> Result<ProviderAuthStatus, String> {
    match provider.as_str() {
        "anthropic" | "openai" | "minimax" | "openrouter" => {
            let exists = get_api_key_exists(provider.clone()).await?;
            if exists {
                Ok(ProviderAuthStatus {
                    status: "ready".to_string(),
                    hint: String::new(),
                })
            } else {
                let label = match provider.as_str() {
                    "anthropic" => "Anthropic",
                    "openai" => "OpenAI",
                    "minimax" => "MiniMax",
                    "openrouter" => "OpenRouter",
                    _ => &provider,
                };
                Ok(ProviderAuthStatus {
                    status: "missing_key".to_string(),
                    hint: format!("Add your {} API key in Tools → API Keys", label),
                })
            }
        }
        "ollama" => {
            let base_url = std::env::var("PACKETCODE_OLLAMA_URL")
                .unwrap_or_else(|_| "http://localhost:11434".to_string());
            let url = format!("{}/api/tags", base_url.trim_end_matches("/v1").trim_end_matches('/'));
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(500))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => Ok(ProviderAuthStatus {
                    status: "ready".to_string(),
                    hint: String::new(),
                }),
                _ => Ok(ProviderAuthStatus {
                    status: "service_down".to_string(),
                    hint: "Ollama not running on localhost:11434".to_string(),
                }),
            }
        }
        "claude-oauth" => Ok(probe_claude_oauth()),
        "openai-codex" => Ok(probe_codex_oauth()),
        other => Err(format!("Unknown provider '{}'", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_base64url(bytes: &[u8]) -> String {
        // Minimal base64url encoder (no padding). Mirrors the decoder.
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
        let mut buf: u32 = 0;
        let mut bits: u32 = 0;
        for &b in bytes {
            buf = (buf << 8) | b as u32;
            bits += 8;
            while bits >= 6 {
                bits -= 6;
                let idx = (buf >> bits) & 0x3F;
                out.push(ALPHABET[idx as usize] as char);
                buf &= (1 << bits) - 1;
            }
        }
        if bits > 0 {
            let idx = (buf << (6 - bits)) & 0x3F;
            out.push(ALPHABET[idx as usize] as char);
        }
        out
    }

    #[test]
    fn base64url_roundtrip_small_payloads() {
        for raw in ["", "hi", "hello", "{\"exp\":1234567890}"].iter() {
            let enc = encode_base64url(raw.as_bytes());
            let dec = base64url_decode(&enc).expect("should decode");
            assert_eq!(dec, raw.as_bytes());
        }
    }

    #[test]
    fn format_relative_expiry_past_is_expired() {
        let past = now_unix_secs() - 3600;
        assert_eq!(format_relative_expiry(past), "Expired");
    }

    #[test]
    fn format_relative_expiry_minutes() {
        let soon = now_unix_secs() + 30 * 60;
        let s = format_relative_expiry(soon);
        assert!(s.contains("minutes"), "got: {}", s);
    }

    #[test]
    fn format_relative_expiry_hours() {
        let soon = now_unix_secs() + 4 * 3600;
        let s = format_relative_expiry(soon);
        assert!(s.contains("hours"), "got: {}", s);
    }

    #[test]
    fn format_relative_expiry_days() {
        let soon = now_unix_secs() + 3 * 86_400;
        let s = format_relative_expiry(soon);
        assert!(s.contains("days"), "got: {}", s);
    }

    #[test]
    fn format_relative_expiry_weeks() {
        let soon = now_unix_secs() + 30 * 86_400;
        let s = format_relative_expiry(soon);
        assert!(s.contains("weeks"), "got: {}", s);
    }

    #[test]
    fn expiry_to_status_past_without_refresh_token_is_login_required() {
        let past = now_unix_secs() - 10;
        let s = expiry_to_status(past, false, "run again");
        assert_eq!(s.status, "login_required");
        assert_eq!(s.hint, "run again");
    }

    #[test]
    fn expiry_to_status_past_with_refresh_token_is_ready_with_refresh_hint() {
        let past = now_unix_secs() - 10;
        let s = expiry_to_status(past, true, "run again");
        assert_eq!(s.status, "ready");
        assert_eq!(s.hint, "Session will auto-refresh on next use");
    }

    #[test]
    fn expiry_to_status_soon_is_ready_with_hint() {
        let soon = now_unix_secs() + 2 * 3600; // within 72h
        let s = expiry_to_status(soon, false, "run again");
        assert_eq!(s.status, "ready");
        assert!(!s.hint.is_empty());
    }

    #[test]
    fn expiry_to_status_far_out_is_ready_no_hint() {
        let far = now_unix_secs() + 30 * 86_400;
        let s = expiry_to_status(far, false, "run again");
        assert_eq!(s.status, "ready");
        assert_eq!(s.hint, "");
    }

    #[test]
    fn parse_claude_has_refresh_token_true_when_present() {
        let json = r#"{"claudeAiOauth":{"expiresAt":1,"refreshToken":"abc"}}"#;
        assert!(parse_claude_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_claude_has_refresh_token_false_when_missing() {
        let json = r#"{"claudeAiOauth":{"expiresAt":1}}"#;
        assert!(!parse_claude_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_claude_has_refresh_token_false_when_empty_string() {
        let json = r#"{"claudeAiOauth":{"refreshToken":""}}"#;
        assert!(!parse_claude_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_claude_has_refresh_token_false_when_invalid_json() {
        assert!(!parse_claude_has_refresh_token(b"not json"));
    }

    #[test]
    fn parse_codex_has_refresh_token_true_when_present() {
        let json = r#"{"tokens":{"access_token":"x.y.z","refresh_token":"opaque"}}"#;
        assert!(parse_codex_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_codex_has_refresh_token_false_when_missing() {
        let json = r#"{"tokens":{"access_token":"x.y.z"}}"#;
        assert!(!parse_codex_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_codex_has_refresh_token_false_when_empty_string() {
        let json = r#"{"tokens":{"refresh_token":""}}"#;
        assert!(!parse_codex_has_refresh_token(json.as_bytes()));
    }

    #[test]
    fn parse_codex_has_refresh_token_false_when_invalid_json() {
        assert!(!parse_codex_has_refresh_token(b"garbage"));
    }

    #[test]
    fn parse_claude_expiry_extracts_millis() {
        let future_millis: i64 = (now_unix_secs() + 3600) * 1000;
        let json = format!(
            r#"{{"claudeAiOauth":{{"expiresAt":{},"accessToken":"x"}}}}"#,
            future_millis
        );
        let exp = parse_claude_expiry_secs(json.as_bytes()).expect("should parse");
        assert_eq!(exp, future_millis / 1000);
    }

    #[test]
    fn parse_claude_expiry_missing_field_returns_none() {
        let json = r#"{"claudeAiOauth":{"accessToken":"x"}}"#;
        assert!(parse_claude_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_claude_expiry_wrong_shape_returns_none() {
        let json = r#"{"not_what_we_expect":42}"#;
        assert!(parse_claude_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_claude_expiry_invalid_json_returns_none() {
        assert!(parse_claude_expiry_secs(b"not json at all").is_none());
    }

    #[test]
    fn parse_codex_expiry_extracts_jwt_exp() {
        let exp_secs: i64 = now_unix_secs() + 3600;
        let header = encode_base64url(br#"{"alg":"none","typ":"JWT"}"#);
        let payload_json = format!(r#"{{"exp":{},"sub":"x"}}"#, exp_secs);
        let payload = encode_base64url(payload_json.as_bytes());
        let sig = encode_base64url(b"sig");
        let jwt = format!("{}.{}.{}", header, payload, sig);
        let auth_json = format!(
            r#"{{"tokens":{{"access_token":"{}","id_token":"x","refresh_token":"y"}}}}"#,
            jwt
        );
        let exp = parse_codex_expiry_secs(auth_json.as_bytes()).expect("should parse");
        assert_eq!(exp, exp_secs);
    }

    #[test]
    fn parse_codex_expiry_missing_tokens_returns_none() {
        let json = r#"{"auth_mode":"ChatGPT"}"#;
        assert!(parse_codex_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_codex_expiry_non_jwt_access_token_returns_none() {
        let json = r#"{"tokens":{"access_token":"not-a-jwt"}}"#;
        assert!(parse_codex_expiry_secs(json.as_bytes()).is_none());
    }

    #[test]
    fn parse_codex_expiry_invalid_json_returns_none() {
        assert!(parse_codex_expiry_secs(b"garbage").is_none());
    }
}

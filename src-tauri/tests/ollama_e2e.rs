//! LM4 gating e2e — proves the daemon actually loaded the negotiated
//! `num_ctx`, i.e. that local routing is not silently starved of context.
//!
//! `#[ignore]`d because it needs a live Ollama daemon with a real model
//! pulled, and one run costs ~6k tokens of local generation. Run it with:
//!
//! ```text
//! cargo test --test ollama_e2e -- --ignored --nocapture
//! ```
//!
//! Preconditions (skip-with-message, never fail, when unmet):
//! * `GET {base}/api/version` answers.
//! * The model (`PACKETBENCH_E2E_OLLAMA_MODEL`, default `qwen2.5-coder:7b`)
//!   appears in `/api/tags`.
//!
//! What it proves:
//! 1. **Canary**: a system prompt that *starts* with a random secret token,
//!    followed by ~6k tokens of filler (well past the 4096-token daemon
//!    default), then a user turn asking for the secret. A correct answer
//!    proves the FRONT of the prompt survived — the half that silently dies
//!    when `num_ctx` is not negotiated.
//! 2. **`/api/ps`**: the loaded instance reports
//!    `context_length == derive_num_ctx(model_ctx, cap)` (16384 at defaults
//!    for a 32768-ctx model) — the half a unit test cannot prove. Older
//!    daemons omit the field; then the canary plus a printed warning is the
//!    best available evidence.
//! 3. **`expires_at`** ≈ now + 30m, validating `keep_alive`.
//! 4. **Negative control**: with `PACKETBENCH_OLLAMA_NUM_CTX_CAP=4096` the
//!    same turn reports `context_length == 4096` in `/api/ps` and the
//!    transcript carries the "context overflow" truncation notice.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use packetbench_lib::core::aux_llm::{run_aux_oneshot, AuxRoute, AuxTaskClass};
use packetbench_lib::core::llm_ollama::{resolve_keep_alive, resolve_num_ctx_cap};

const DEFAULT_MODEL: &str = "qwen2.5-coder:7b";

fn base_url() -> String {
    packetbench_lib::core::storage::resolve_ollama_root_base_url()
}

fn e2e_model() -> String {
    std::env::var("PACKETBENCH_E2E_OLLAMA_MODEL")
        .ok()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("HTTP client")
}

async fn get_json(url: &str) -> Option<serde_json::Value> {
    let resp = client().get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

/// `/api/show` context length for the model, via the same suffix-scan rule
/// the product uses (`*.context_length`).
async fn show_context_length(base: &str, model: &str) -> Option<u32> {
    let resp = client()
        .post(format!("{}/api/show", base))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("model_info")?
        .as_object()?
        .iter()
        .filter(|(key, _)| key.as_str() == "context_length" || key.ends_with(".context_length"))
        .filter_map(|(_, value)| value.as_u64())
        .max()
        .and_then(|len| u32::try_from(len).ok())
}

/// The loaded instance's `(context_length, expires_at)` from `/api/ps`.
async fn ps_entry(base: &str, model: &str) -> Option<(Option<u64>, Option<String>)> {
    let body = get_json(&format!("{}/api/ps", base)).await?;
    let models = body.get("models")?.as_array()?;
    let entry = models
        .iter()
        .find(|m| m.get("name").and_then(|n| n.as_str()) == Some(model))
        .or_else(|| models.first())?;
    Some((
        entry.get("context_length").and_then(|v| v.as_u64()),
        entry
            .get("expires_at")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    ))
}

/// Parse `YYYY-MM-DDTHH:MM:SS` (any offset/suffix ignored — Ollama reports
/// local time with an offset; we only need minute-level slack, so we parse
/// the numeric offset too). Returns Unix seconds.
fn parse_rfc3339_secs(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    // civil_from_days, inverted (Howard Hinnant).
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m - 3) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut secs = days * 86_400 + hour * 3600 + minute * 60 + second;

    // Apply a trailing numeric offset (`+02:00` / `-07:00`); `Z`/none = UTC.
    let rest = &s[19..];
    if let Some(sign_pos) = rest.find(['+', '-']) {
        let offset = &rest[sign_pos..];
        if offset.len() >= 6 {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let oh: i64 = offset.get(1..3)?.parse().ok()?;
            let om: i64 = offset.get(4..6)?.parse().ok()?;
            secs -= sign * (oh * 3600 + om * 60);
        }
    }
    Some(secs)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// ~6k tokens of incompressible-enough filler (numbered sentences; roughly
/// 4 chars/token, so ~26k chars). Enough to blow well past the 4096-token
/// daemon default without approaching the 16384 negotiated window.
fn filler() -> String {
    let mut out = String::with_capacity(30_000);
    for i in 0..600 {
        out.push_str(&format!(
            "Entry {i}: the review noted item {i} was reconciled against ledger {} on cycle {}. ",
            i * 7 % 991,
            i * 13 % 89
        ));
    }
    out
}

fn secret_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("ZEBRA-{}-{}", nanos, std::process::id())
}

async fn run_canary_turn(model: &str, session_id: &str) -> Result<(String, String), String> {
    let secret = secret_token();
    let system_prompt = format!(
        "SECRET TOKEN: {secret}\nRemember the secret token above. It appears only here, at the very start of this prompt.\n\nBackground records (irrelevant, do not summarise):\n{}",
        filler()
    );
    let route = AuxRoute {
        provider: "ollama".to_string(),
        model: model.to_string(),
        explicit: true,
    };
    let text = run_aux_oneshot(
        AuxTaskClass::SpecImport,
        &route,
        session_id,
        system_prompt,
        "What is the SECRET TOKEN stated at the very beginning of your instructions? Reply with the token only.".to_string(),
    )
    .await?;
    Ok((secret, text))
}

#[tokio::test]
#[ignore = "needs a live Ollama daemon with a pulled model; ~6k tokens of local generation"]
async fn negotiated_num_ctx_reaches_the_daemon() {
    let base = base_url();
    let model = e2e_model();

    // --- Preconditions: skip with a message, never fail. ---
    if get_json(&format!("{}/api/version", base)).await.is_none() {
        eprintln!("SKIP: Ollama did not answer {}/api/version", base);
        return;
    }
    let tags = get_json(&format!("{}/api/tags", base)).await;
    let model_present = tags
        .as_ref()
        .and_then(|t| t.get("models"))
        .and_then(|m| m.as_array())
        .map(|models| {
            models
                .iter()
                .any(|m| m.get("name").and_then(|n| n.as_str()) == Some(model.as_str()))
        })
        .unwrap_or(false);
    if !model_present {
        eprintln!(
            "SKIP: model '{}' not present in {}/api/tags — `ollama pull {}` or set PACKETBENCH_E2E_OLLAMA_MODEL",
            model, base, model
        );
        return;
    }

    // --- Expected negotiated window (derive_num_ctx's rule, restated). ---
    let cap = resolve_num_ctx_cap();
    let model_ctx = show_context_length(&base, &model).await;
    let expected = model_ctx.unwrap_or(8_192).min(cap);
    eprintln!(
        "model {} trained ctx {:?}, cap {} -> expecting negotiated num_ctx {}",
        model, model_ctx, cap, expected
    );

    // --- One real turn through the aux seam, with the canary prompt. ---
    let (secret, transcript) = run_canary_turn(&model, "ollama-e2e-canary")
        .await
        .expect("canary turn failed — is the daemon out of memory?");
    assert!(
        transcript.contains(&secret),
        "the model could not recall the secret from the FRONT of a ~6k-token prompt — \
         the daemon is running below the negotiated context window.\nTranscript: {}",
        transcript
    );

    // --- /api/ps: the daemon's own report of the loaded context. ---
    match ps_entry(&base, &model).await {
        Some((Some(loaded_ctx), expires_at)) => {
            assert_eq!(
                loaded_ctx,
                u64::from(expected),
                "/api/ps reports a loaded context_length different from the negotiated one"
            );
            // keep_alive validation: expires_at ≈ now + 30m (default). Allow
            // generous slack for load time; skip when the user overrides
            // keep_alive.
            if resolve_keep_alive() == "30m" {
                if let Some(expires_secs) = expires_at.as_deref().and_then(parse_rfc3339_secs) {
                    let delta = expires_secs - now_secs();
                    assert!(
                        (25 * 60..=35 * 60).contains(&delta),
                        "expires_at is {}s away; expected ≈30m — keep_alive not applied?",
                        delta
                    );
                } else {
                    eprintln!("WARN: could not parse /api/ps expires_at; keep_alive unverified");
                }
            } else {
                eprintln!(
                    "NOTE: keep_alive overridden to '{}'; skipping the 30m expires_at check",
                    resolve_keep_alive()
                );
            }
        }
        _ => {
            eprintln!(
                "WARN: this daemon's /api/ps does not report context_length; the canary is the \
                 only evidence this run (upgrade Ollama for the authoritative half)"
            );
        }
    }

    // --- Negative control: cap the window below the prompt and observe the
    // truncation surfacing. The saved Settings cap outranks the env var, so
    // skip when one is present. ---
    std::env::set_var("PACKETBENCH_OLLAMA_NUM_CTX_CAP", "4096");
    if resolve_num_ctx_cap() != 4_096 {
        eprintln!(
            "SKIP negative control: a saved num_ctx cap override outranks the env var \
             (effective cap {})",
            resolve_num_ctx_cap()
        );
        std::env::remove_var("PACKETBENCH_OLLAMA_NUM_CTX_CAP");
        return;
    }
    let (_, capped_transcript) = run_canary_turn(&model, "ollama-e2e-negative")
        .await
        .expect("negative-control turn failed");
    std::env::remove_var("PACKETBENCH_OLLAMA_NUM_CTX_CAP");

    assert!(
        capped_transcript.contains("context overflow"),
        "a ~6k-token prompt through a 4096 window must surface the truncation notice; got: {}",
        capped_transcript
    );
    if let Some((Some(loaded_ctx), _)) = ps_entry(&base, &model).await {
        assert_eq!(
            loaded_ctx, 4_096,
            "/api/ps should show the capped window after the negative-control turn"
        );
    }
}

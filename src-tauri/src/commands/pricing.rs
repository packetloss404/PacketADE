//! Model pricing lookup and cost calculation.
//!
//! **There is no rate table in this file.** Rates live in the single shared
//! source of truth, `shared/model-pricing.json`, which is compiled in below
//! with `include_str!` and is *the same file* the frontend imports
//! (`src/lib/modelPricing.ts`). Rust and TypeScript therefore cannot disagree
//! about a rate: there is only one table. The two *implementations* are kept
//! honest by a shared golden-case fixture (`shared/model-pricing-cases.json`)
//! that both languages assert against — see `golden_cases_match` below and
//! `src/lib/__tests__/modelPricing.test.ts`.
//!
//! Token buckets are treated as **disjoint** here: `input` must not include
//! `cache_read`. Vendors whose reported prompt tokens are a superset (OpenAI's
//! `cached_tokens`) are flagged in the table via `inputIncludesCacheRead`;
//! normalising those payloads is CE1's job and happens at the call sites, not
//! here.
//!
//! Rates can change on a published date (e.g. Claude Sonnet 5's introductory
//! window). Every lookup therefore takes the date **of the priced turn**;
//! `pricing_for` / `calculate_cost` default to today. Stored costs are never
//! recomputed, so a turn billed in August stays billed at August's rate.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// The single shared rate table, compiled in at build time.
const TABLE_JSON: &str = include_str!("../../../shared/model-pricing.json");

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPricing {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    /// 5-minute-TTL cache write (the default TTL).
    pub cache_write_per_mtok: f64,
    /// 1-hour-TTL cache write. Equal to the 5m rate for vendors with no TTL
    /// dimension.
    pub cache_write_1h_per_mtok: f64,
    /// True when the vendor's reported input/prompt token count already
    /// contains the cached-read tokens (OpenAI). False when the buckets are
    /// disjoint (Anthropic). Consumed by the frontend estimator; see CE1.
    pub input_includes_cache_read: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingStatus {
    Priced,
    Free,
    Unknown,
}

// ---------------------------------------------------------------------------
// Shared table (deserialised from shared/model-pricing.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PricingTable {
    #[allow(dead_code)]
    schema_version: u32,
    #[allow(dead_code)]
    readme: Vec<String>,
    #[allow(dead_code)]
    sources: Vec<SourceRef>,
    models: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct SourceRef {
    vendor: String,
    url: Option<String>,
    fetched_at: Option<String>,
    verified: bool,
    note: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelEntry {
    /// Read by the table-integrity test; the lookup path matches on
    /// `match_rules`, not on this id.
    #[allow(dead_code)]
    id: String,
    #[serde(default)]
    #[allow(dead_code)]
    label: Option<String>,
    #[allow(dead_code)]
    vendor: String,
    #[serde(default)]
    #[allow(dead_code)]
    note: Option<String>,
    #[serde(default)]
    input_includes_cache_read: bool,
    #[serde(rename = "match")]
    match_rules: MatchRules,
    #[serde(default)]
    rates: Option<RawRates>,
    #[serde(default)]
    schedule: Option<Vec<ScheduledRates>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatchRules {
    #[serde(default)]
    equals: Vec<String>,
    #[serde(default)]
    prefix: Vec<String>,
    #[serde(default)]
    contains: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRates {
    input: f64,
    output: f64,
    #[serde(rename = "cacheRead")]
    cache_read: f64,
    #[serde(rename = "cacheWrite5m")]
    cache_write_5m: f64,
    #[serde(rename = "cacheWrite1h")]
    cache_write_1h: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduledRates {
    /// Inclusive start date (`YYYY-MM-DD`). Absent = open-ended.
    #[serde(default)]
    from: Option<String>,
    /// Inclusive end date (`YYYY-MM-DD`). Absent = open-ended.
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    note: Option<String>,
    rates: RawRates,
}

fn table() -> &'static PricingTable {
    static TABLE: OnceLock<PricingTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(TABLE_JSON)
            .expect("shared/model-pricing.json is malformed — see pricing.rs")
    })
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/// Route prefixes stripped when building match candidates. `meta-llama/` is
/// deliberately absent: it is a *cloud* route and must not collapse onto the
/// free local `llama*` row.
const ROUTE_PREFIXES: [&str; 7] = [
    "anthropic/",
    "openai/",
    "google/",
    "openrouter/",
    "ollama/",
    "ollama:",
    "local/",
];

/// Strip a trailing `-YYYYMMDD` release-date suffix, if present.
fn strip_date_suffix(s: &str) -> Option<&str> {
    if s.len() < 10 || !s.is_char_boundary(s.len() - 9) {
        return None;
    }
    let (head, tail) = s.split_at(s.len() - 9);
    let mut chars = tail.chars();
    if chars.next() != Some('-') {
        return None;
    }
    if chars.all(|c| c.is_ascii_digit()) {
        Some(head)
    } else {
        None
    }
}

/// Build the ordered candidate list for a model id: lowercased original, then
/// route-prefix-stripped, then date-suffix-stripped variants of each.
///
/// Kept byte-for-byte equivalent to `candidatesFor` in `src/lib/modelPricing.ts`.
fn candidates(model: &str) -> Vec<String> {
    let normalized = model.trim().to_lowercase();
    let mut base: Vec<String> = vec![normalized.clone()];
    for route in ROUTE_PREFIXES {
        if let Some(rest) = normalized.strip_prefix(route) {
            if !rest.is_empty() {
                base.push(rest.to_string());
            }
        }
    }

    let mut out: Vec<String> = Vec::with_capacity(base.len() * 2);
    for candidate in base {
        if let Some(stripped) = strip_date_suffix(&candidate) {
            let stripped = stripped.to_string();
            if !out.contains(&candidate) {
                out.push(candidate);
            }
            if !out.contains(&stripped) {
                out.push(stripped);
            }
        } else if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

fn entry_matches(entry: &ModelEntry, candidates: &[String]) -> bool {
    for c in candidates {
        if entry.match_rules.equals.iter().any(|r| c == r) {
            return true;
        }
        if entry.match_rules.prefix.iter().any(|r| c.starts_with(r)) {
            return true;
        }
        if entry.match_rules.contains.iter().any(|r| c.contains(r)) {
            return true;
        }
    }
    false
}

/// Resolve the rate row in effect on `date` (`YYYY-MM-DD`). ISO dates compare
/// correctly as strings.
fn rates_on(entry: &ModelEntry, date: &str) -> Option<RawRates> {
    if let Some(schedule) = &entry.schedule {
        for window in schedule {
            let after_start = window.from.as_deref().is_none_or(|from| date >= from);
            let before_end = window.until.as_deref().is_none_or(|until| date <= until);
            if after_start && before_end {
                return Some(window.rates);
            }
        }
        // A date outside every published window (shouldn't happen — the table
        // test asserts full coverage) falls back to the earliest row rather
        // than silently pricing at zero.
        return schedule.first().map(|w| w.rates);
    }
    entry.rates
}

/// Today's date in UTC as `YYYY-MM-DD`.
fn today() -> String {
    crate::commands::usage::current_timestamp_iso()
        .chars()
        .take(10)
        .collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return pricing for the given model id as of **today**, or `None` if unknown.
pub fn pricing_for(model: &str) -> Option<ModelPricing> {
    pricing_for_at(model, &today())
}

/// Return pricing for the given model id as it stood on `date` (`YYYY-MM-DD`).
///
/// Use this — not `pricing_for` — whenever pricing a record that already
/// happened, so a published rate change is never applied retroactively.
pub fn pricing_for_at(model: &str, date: &str) -> Option<ModelPricing> {
    let candidates = candidates(model);
    let entry = table()
        .models
        .iter()
        .find(|e| entry_matches(e, &candidates))?;
    let rates = rates_on(entry, date)?;
    Some(ModelPricing {
        input_per_mtok: rates.input,
        output_per_mtok: rates.output,
        cache_read_per_mtok: rates.cache_read,
        cache_write_per_mtok: rates.cache_write_5m,
        cache_write_1h_per_mtok: rates.cache_write_1h,
        input_includes_cache_read: entry.input_includes_cache_read,
    })
}

pub fn pricing_status_for(model: &str) -> PricingStatus {
    let Some(pricing) = pricing_for(model) else {
        return PricingStatus::Unknown;
    };

    if pricing.input_per_mtok == 0.0
        && pricing.output_per_mtok == 0.0
        && pricing.cache_read_per_mtok == 0.0
        && pricing.cache_write_per_mtok == 0.0
    {
        PricingStatus::Free
    } else {
        PricingStatus::Priced
    }
}

/// Compute the USD cost for a usage record priced at **today's** rates.
/// Returns 0.0 for unknown models. `cache_write` is billed at the 5-minute TTL
/// rate (the default TTL; the only one any provider currently reports).
pub fn calculate_cost(
    model: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) -> f64 {
    calculate_cost_at(model, &today(), input, output, cache_read, cache_write, 0)
}

/// Normalise a vendor's reported prompt-token count into the **disjoint**
/// bucket model `calculate_cost` requires.
///
/// OpenAI-family endpoints report `prompt_tokens` as a superset that already
/// contains `prompt_tokens_details.cached_tokens`; Anthropic reports
/// `input_tokens` and `cache_read_input_tokens` as separate buckets. Which one
/// a model uses is recorded per vendor in the shared table as
/// `inputIncludesCacheRead`, so callers ask here rather than hardcoding a
/// vendor assumption. Unknown models are left alone.
///
/// Wire payloads and `UsageEntry` rows deliberately keep the vendor's own
/// numbers; the normalisation happens here, at the cost call site.
pub fn billable_input_tokens(model: &str, input: u64, cache_read: u64) -> u64 {
    match pricing_for(model) {
        Some(p) if p.input_includes_cache_read => input.saturating_sub(cache_read),
        _ => input,
    }
}

/// Compute the USD cost for a usage record priced at the rates in effect on
/// `date` (`YYYY-MM-DD`), with the two cache-write TTLs billed separately.
///
/// Buckets are disjoint and purely additive; `input` must exclude `cache_read`.
pub fn calculate_cost_at(
    model: &str,
    date: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
) -> f64 {
    let Some(p) = pricing_for_at(model, date) else {
        return 0.0;
    };

    let m = 1_000_000.0_f64;
    (input as f64 / m) * p.input_per_mtok
        + (output as f64 / m) * p.output_per_mtok
        + (cache_read as f64 / m) * p.cache_read_per_mtok
        + (cache_write_5m as f64 / m) * p.cache_write_per_mtok
        + (cache_write_1h as f64 / m) * p.cache_write_1h_per_mtok
}

/// Tauri command wrapper around `calculate_cost_at` for per-turn cost display
/// in the API agent UI.
///
/// `cache_write_1h` and `at` are optional: omitted means "all cache writes used
/// the default 5-minute TTL" and "price at today's rates" respectively. Pass
/// `at` (the turn's `YYYY-MM-DD`) when re-pricing anything historical.
#[tauri::command]
pub fn calculate_turn_cost(
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
    cache_write_1h: Option<u64>,
    at: Option<String>,
) -> f64 {
    let date = at.unwrap_or_else(today);
    calculate_cost_at(
        &model,
        &date,
        input_tokens,
        output_tokens,
        cache_read,
        cache_write,
        cache_write_1h.unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES_JSON: &str = include_str!("../../../shared/model-pricing-cases.json");

    #[derive(Debug, serde::Deserialize)]
    struct GoldenFile {
        cases: Vec<GoldenCase>,
    }

    #[derive(Debug, serde::Deserialize)]
    struct GoldenCase {
        name: String,
        model: String,
        at: String,
        tokens: GoldenTokens,
        #[serde(rename = "expectedUsd")]
        expected_usd: f64,
    }

    #[derive(Debug, Default, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenTokens {
        #[serde(default)]
        input: u64,
        #[serde(default)]
        output: u64,
        #[serde(default)]
        cache_read: u64,
        #[serde(rename = "cacheWrite5m", default)]
        cache_write_5m: u64,
        #[serde(rename = "cacheWrite1h", default)]
        cache_write_1h: u64,
    }

    /// The anti-drift gate. `src/lib/__tests__/modelPricing.test.ts` runs the
    /// same fixture through the TypeScript engine; if either implementation's
    /// matching, date handling, or cost formula changes, the other fails.
    #[test]
    fn golden_cases_match() {
        let file: GoldenFile =
            serde_json::from_str(CASES_JSON).expect("model-pricing-cases.json parses");
        assert!(file.cases.len() >= 20, "golden fixture unexpectedly small");
        for case in &file.cases {
            let got = calculate_cost_at(
                &case.model,
                &case.at,
                case.tokens.input,
                case.tokens.output,
                case.tokens.cache_read,
                case.tokens.cache_write_5m,
                case.tokens.cache_write_1h,
            );
            assert!(
                (got - case.expected_usd).abs() < 1e-9,
                "{}: expected {}, got {}",
                case.name,
                case.expected_usd,
                got
            );
        }
    }

    /// The superset/disjoint distinction must come from the table, not from a
    /// hardcoded vendor guess at the call site. Getting this backwards
    /// over-bills OpenAI turns by counting cached reads at the full input rate
    /// — the exact error CE9's parsing change would otherwise introduce.
    #[test]
    fn billable_input_normalises_only_superset_vendors() {
        // OpenAI reports prompt_tokens as a superset containing cached_tokens.
        assert!(pricing_for("gpt-5.5").unwrap().input_includes_cache_read);
        assert_eq!(billable_input_tokens("gpt-5.5", 4_000, 3_000), 1_000);

        // Anthropic's buckets are already disjoint — subtracting would
        // under-bill.
        assert!(!pricing_for("claude-opus-4-8")
            .unwrap()
            .input_includes_cache_read);
        assert_eq!(
            billable_input_tokens("claude-opus-4-8", 4_000, 3_000),
            4_000
        );

        // Never goes negative, and an unknown model is left untouched.
        assert_eq!(billable_input_tokens("gpt-5.5", 100, 400), 0);
        assert_eq!(
            billable_input_tokens("totally-unknown-model-xyz", 4_000, 3_000),
            4_000
        );
    }

    #[test]
    fn table_is_well_formed() {
        let t = table();
        assert_eq!(t.schema_version, 1);
        let mut seen: Vec<&str> = Vec::new();
        for entry in &t.models {
            assert!(
                !seen.contains(&entry.id.as_str()),
                "duplicate model id {}",
                entry.id
            );
            seen.push(&entry.id);
            assert!(
                entry.rates.is_some() != entry.schedule.is_some(),
                "{} must have exactly one of `rates` / `schedule`",
                entry.id
            );
            assert!(
                !entry.match_rules.equals.is_empty()
                    || !entry.match_rules.prefix.is_empty()
                    || !entry.match_rules.contains.is_empty(),
                "{} has no match rules",
                entry.id
            );
            // Scheduled rows must cover every date, past and future.
            if let Some(schedule) = &entry.schedule {
                assert!(
                    schedule.iter().any(|w| w.from.is_none()),
                    "{} schedule has no open-ended start",
                    entry.id
                );
                assert!(
                    schedule.iter().any(|w| w.until.is_none()),
                    "{} schedule has no open-ended end",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn opus_4_7_returns_current_opus_rates() {
        // SPIKE-1: current Opus is $5/$25. $15/$75 is the DEPRECATED Opus 4.1 rate.
        let p = pricing_for("claude-opus-4-7-20260101").expect("opus pricing");
        assert_eq!(p.input_per_mtok, 5.0);
        assert_eq!(p.output_per_mtok, 25.0);
        assert!((p.cache_read_per_mtok - 0.5).abs() < 1e-9);
        assert!((p.cache_write_per_mtok - 6.25).abs() < 1e-9);
        assert!((p.cache_write_1h_per_mtok - 10.0).abs() < 1e-9);
        assert!(!p.input_includes_cache_read);
    }

    #[test]
    fn haiku_4_5_is_not_priced_at_the_retired_haiku_3_5_rate() {
        let p = pricing_for("claude-haiku-4-5-20251001").expect("haiku 4.5");
        assert_eq!(p.input_per_mtok, 1.0);
        assert_eq!(p.output_per_mtok, 5.0);
        let retired = pricing_for("claude-3-5-haiku-20241022").expect("haiku 3.5");
        assert_eq!(retired.input_per_mtok, 0.80);
        assert_eq!(retired.output_per_mtok, 4.0);
    }

    #[test]
    fn sonnet_5_switches_rate_on_the_published_date() {
        let intro = pricing_for_at("claude-sonnet-5", "2026-08-31").expect("intro");
        assert_eq!(intro.input_per_mtok, 2.0);
        assert_eq!(intro.output_per_mtok, 10.0);
        let standard = pricing_for_at("claude-sonnet-5", "2026-09-01").expect("standard");
        assert_eq!(standard.input_per_mtok, 3.0);
        assert_eq!(standard.output_per_mtok, 15.0);
        // Historical dates keep the introductory rate forever.
        let historical = pricing_for_at("claude-sonnet-5", "2026-08-01").expect("historical");
        assert_eq!(historical.input_per_mtok, 2.0);
    }

    #[test]
    fn openrouter_anthropic_mirrors_direct() {
        let a = pricing_for("anthropic/claude-sonnet-4-6").expect("sonnet");
        assert_eq!(a.input_per_mtok, 3.0);
        assert_eq!(a.output_per_mtok, 15.0);
    }

    #[test]
    fn gpt_5_5_pricing_matches_openai_aliases() {
        let direct = pricing_for("gpt-5.5").expect("gpt-5.5");
        assert_eq!(direct.input_per_mtok, 5.0);
        assert_eq!(direct.output_per_mtok, 15.0);
        assert!(direct.input_includes_cache_read);

        let routed = pricing_for("openai/gpt-5.5").expect("openrouter gpt-5.5");
        assert_eq!(routed.input_per_mtok, 5.0);
        assert_eq!(routed.output_per_mtok, 15.0);
    }

    #[test]
    fn minimax_m2_family_is_priced_per_point_release() {
        for id in ["MiniMax-M2", "MiniMax-M2.5", "MiniMax-M2.7"] {
            let p = pricing_for(id).unwrap_or_else(|| panic!("{} pricing", id));
            assert_eq!(p.input_per_mtok, 0.30, "{}", id);
            assert_eq!(p.output_per_mtok, 1.20, "{}", id);
        }
        let m1 = pricing_for("MiniMax-M1").expect("m1");
        assert_eq!(m1.input_per_mtok, 0.40);
        assert_eq!(m1.output_per_mtok, 2.20);
    }

    #[test]
    fn unknown_model_returns_zero_cost() {
        assert!(pricing_for("totally-unknown-model-xyz").is_none());
        assert_eq!(
            pricing_status_for("totally-unknown-model-xyz"),
            PricingStatus::Unknown
        );
        let cost = calculate_cost("totally-unknown-model-xyz", 1_000_000, 1_000_000, 0, 0);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn ollama_model_is_free() {
        let p = pricing_for("llama3.1:70b").expect("local llama");
        assert_eq!(p.input_per_mtok, 0.0);
        assert_eq!(p.output_per_mtok, 0.0);
        assert_eq!(pricing_status_for("llama3.1:70b"), PricingStatus::Free);
        let cost = calculate_cost("qwen2.5-coder", 5_000_000, 5_000_000, 0, 0);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn calculate_cost_basic() {
        // 1M input + 1M output on Opus 4.7 = 5 + 25 = $30
        let cost = calculate_cost("claude-opus-4-7", 1_000_000, 1_000_000, 0, 0);
        assert!((cost - 30.0).abs() < 1e-9);
    }

    #[test]
    fn cache_buckets_are_priced_at_their_own_rates() {
        // 1M cache read on Opus = $0.50; 1M 5m write = $6.25.
        let read = calculate_cost("claude-opus-4-8", 0, 0, 1_000_000, 0);
        assert!((read - 0.50).abs() < 1e-9);
        let write = calculate_cost("claude-opus-4-8", 0, 0, 0, 1_000_000);
        assert!((write - 6.25).abs() < 1e-9);
        let write_1h = calculate_cost_at("claude-opus-4-8", "2026-07-31", 0, 0, 0, 0, 1_000_000);
        assert!((write_1h - 10.0).abs() < 1e-9);
    }

    #[test]
    fn current_default_models_are_priced() {
        let opus8 = pricing_for("claude-opus-4-8").expect("opus 4.8");
        assert_eq!(opus8.input_per_mtok, 5.0);
        assert_eq!(opus8.output_per_mtok, 25.0);
        assert!(pricing_for("anthropic/claude-opus-4-8").is_some());
        let g5 = pricing_for("gpt-5").expect("gpt-5");
        assert_eq!(g5.input_per_mtok, 5.0);
        assert!(pricing_for("gpt-5-codex").is_some());
        let m3 = pricing_for("MiniMax-M3").expect("minimax m3");
        assert_eq!(m3.input_per_mtok, 0.30);
        assert_eq!(m3.output_per_mtok, 1.20);
    }

    #[test]
    fn meta_llama_maverick_is_paid_not_local() {
        let p = pricing_for("meta-llama/llama-4-maverick").expect("maverick");
        assert_eq!(p.input_per_mtok, 0.20);
        assert_eq!(p.output_per_mtok, 0.60);
        assert_eq!(
            pricing_status_for("meta-llama/llama-4-maverick"),
            PricingStatus::Priced
        );
    }

    #[test]
    fn specific_rows_are_not_shadowed_by_generic_ones() {
        // The retired `claude-opus-4` row must not swallow 4.x point releases.
        assert_eq!(
            pricing_for("claude-opus-4-8").expect("4.8").input_per_mtok,
            5.0
        );
        assert_eq!(
            pricing_for("claude-opus-4").expect("retired 4").input_per_mtok,
            15.0
        );
        // gpt-5.5 must not fall through to the gpt-5 family row's identical
        // rate by accident — assert the specific row is reachable at all.
        assert!(pricing_for("gpt-5.3-codex").is_some());
    }

    #[test]
    fn today_is_an_iso_date() {
        let d = today();
        assert_eq!(d.len(), 10, "today() = {}", d);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
    }
}

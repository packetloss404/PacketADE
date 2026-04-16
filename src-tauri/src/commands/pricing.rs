//! Model pricing table and cost calculation.
//!
//! Rates are approximate published values as of April 2026 (USD per million tokens).
//! Cache-read and cache-write rates are derived as multipliers on the input rate,
//! following each provider's published multipliers.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPricing {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
}

impl ModelPricing {
    /// Anthropic: cache_read = 0.10x input, cache_write = 1.25x input.
    const fn anthropic(input: f64, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            cache_read_per_mtok: input * 0.10,
            cache_write_per_mtok: input * 1.25,
        }
    }

    /// OpenAI: cache_read = 0.50x input, cache_write = 1.0x input.
    const fn openai(input: f64, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            cache_read_per_mtok: input * 0.50,
            cache_write_per_mtok: input,
        }
    }

    /// Google: cache_read = 0.25x input, cache_write = 1.0x input.
    const fn google(input: f64, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            cache_read_per_mtok: input * 0.25,
            cache_write_per_mtok: input,
        }
    }

    /// Generic OpenAI-style cache pricing (0.50x / 1.0x).
    const fn openai_style(input: f64, output: f64) -> Self {
        Self::openai(input, output)
    }

    /// Flat/no cache pricing.
    const fn flat(input: f64, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            cache_read_per_mtok: input,
            cache_write_per_mtok: input,
        }
    }

    const fn zero() -> Self {
        Self {
            input_per_mtok: 0.0,
            output_per_mtok: 0.0,
            cache_read_per_mtok: 0.0,
            cache_write_per_mtok: 0.0,
        }
    }
}

/// Normalize a model id for matching: lowercase and strip an optional
/// `openrouter/` or provider-route prefix is preserved (we match on full id).
fn normalize(model: &str) -> String {
    model.trim().to_lowercase()
}

/// Return pricing for the given model id, or `None` if unknown.
///
/// Matching strategy: normalize to lowercase, then check a series of
/// `starts_with` / `contains` rules ordered from most specific to most generic.
pub fn pricing_for(model: &str) -> Option<ModelPricing> {
    let m = normalize(model);

    // --- Ollama / local models: always zero cost ---
    // Match common local model families. We check this first so cloud-hosted
    // variants with provider prefixes (e.g. `meta-llama/llama-...`) still hit
    // their paid tiers below via the explicit `meta-llama/` check.
    if is_local_model(&m) {
        return Some(ModelPricing::zero());
    }

    // --- Anthropic (direct + OpenRouter mirror) ---
    // Strip a leading `anthropic/` (OpenRouter) for matching.
    let anthro = m
        .strip_prefix("anthropic/")
        .unwrap_or(&m)
        .to_string();

    if anthro.starts_with("claude-opus-4-7") {
        return Some(ModelPricing::anthropic(15.0, 75.0));
    }
    if anthro.starts_with("claude-opus-4-6") {
        return Some(ModelPricing::anthropic(15.0, 75.0));
    }
    if anthro.starts_with("claude-sonnet-4-6") {
        return Some(ModelPricing::anthropic(3.0, 15.0));
    }
    if anthro.starts_with("claude-haiku-4-5") {
        return Some(ModelPricing::anthropic(0.80, 4.0));
    }

    // --- OpenAI (direct + OpenRouter mirror) ---
    let oai = m.strip_prefix("openai/").unwrap_or(&m).to_string();

    if oai.starts_with("gpt-5.3-codex") {
        return Some(ModelPricing::openai(5.0, 15.0));
    }
    if oai.starts_with("chatgpt-5.4") || oai.starts_with("gpt-5.4") {
        return Some(ModelPricing::openai(5.0, 15.0));
    }
    if oai.starts_with("gpt-4o") {
        return Some(ModelPricing::openai(2.50, 10.0));
    }
    if oai == "o3" || oai.starts_with("o3-") {
        return Some(ModelPricing::openai(15.0, 60.0));
    }
    if oai.starts_with("o4-mini") {
        return Some(ModelPricing::openai(1.10, 4.40));
    }

    // --- Google (direct + OpenRouter mirror) ---
    let goog = m.strip_prefix("google/").unwrap_or(&m).to_string();

    if goog.starts_with("gemini-2.5-pro") || goog.starts_with("gemini-3.1-pro") {
        return Some(ModelPricing::google(1.25, 5.0));
    }
    if goog.starts_with("gemini-3-flash") {
        return Some(ModelPricing::google(0.075, 0.30));
    }

    // --- MiniMax ---
    if m.contains("minimax-m1") {
        return Some(ModelPricing::openai_style(0.40, 2.20));
    }

    // --- Llama 4 Maverick via OpenRouter ---
    if m.contains("llama-4-maverick") || m.starts_with("meta-llama/llama-4-maverick") {
        return Some(ModelPricing::flat(0.40, 1.20));
    }

    None
}

/// Returns true for local/self-hosted model families that should be billed at $0.
fn is_local_model(m: &str) -> bool {
    // Strip common provider-route prefixes used for local runners.
    let bare = m
        .strip_prefix("ollama/")
        .or_else(|| m.strip_prefix("ollama:"))
        .or_else(|| m.strip_prefix("local/"))
        .unwrap_or(m);

    // `meta-llama/` is a cloud route (e.g. OpenRouter) — don't treat as local.
    if m.starts_with("meta-llama/") {
        return false;
    }

    bare.starts_with("llama")
        || bare.starts_with("qwen")
        || bare.starts_with("deepseek")
        || bare.starts_with("codellama")
}

/// Compute the USD cost for a usage record. Returns 0.0 for unknown models.
pub fn calculate_cost(
    model: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) -> f64 {
    let Some(p) = pricing_for(model) else {
        return 0.0;
    };

    let m = 1_000_000.0_f64;
    (input as f64 / m) * p.input_per_mtok
        + (output as f64 / m) * p.output_per_mtok
        + (cache_read as f64 / m) * p.cache_read_per_mtok
        + (cache_write as f64 / m) * p.cache_write_per_mtok
}

/// Tauri command wrapper around `calculate_cost` for per-turn cost display
/// in the API agent UI.
#[tauri::command]
pub fn calculate_turn_cost(
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
) -> f64 {
    calculate_cost(&model, input_tokens, output_tokens, cache_read, cache_write)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_4_7_returns_opus_rates() {
        let p = pricing_for("claude-opus-4-7-20260101").expect("opus pricing");
        assert_eq!(p.input_per_mtok, 15.0);
        assert_eq!(p.output_per_mtok, 75.0);
        // cache_read = 0.10 * 15 = 1.5; cache_write = 1.25 * 15 = 18.75
        assert!((p.cache_read_per_mtok - 1.5).abs() < 1e-9);
        assert!((p.cache_write_per_mtok - 18.75).abs() < 1e-9);
    }

    #[test]
    fn openrouter_anthropic_mirrors_direct() {
        let a = pricing_for("anthropic/claude-sonnet-4-6").expect("sonnet");
        assert_eq!(a.input_per_mtok, 3.0);
        assert_eq!(a.output_per_mtok, 15.0);
    }

    #[test]
    fn unknown_model_returns_zero_cost() {
        assert!(pricing_for("totally-unknown-model-xyz").is_none());
        let cost = calculate_cost("totally-unknown-model-xyz", 1_000_000, 1_000_000, 0, 0);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn ollama_model_is_free() {
        let p = pricing_for("llama3.1:70b").expect("local llama");
        assert_eq!(p.input_per_mtok, 0.0);
        assert_eq!(p.output_per_mtok, 0.0);
        let cost = calculate_cost("qwen2.5-coder", 5_000_000, 5_000_000, 0, 0);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn calculate_cost_basic() {
        // 1M input + 1M output on Opus 4.7 = 15 + 75 = $90
        let cost = calculate_cost("claude-opus-4-7", 1_000_000, 1_000_000, 0, 0);
        assert!((cost - 90.0).abs() < 1e-9);
    }

    #[test]
    fn meta_llama_maverick_is_paid_not_local() {
        let p = pricing_for("meta-llama/llama-4-maverick").expect("maverick");
        assert_eq!(p.input_per_mtok, 0.40);
        assert_eq!(p.output_per_mtok, 1.20);
    }
}

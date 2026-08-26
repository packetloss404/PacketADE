//! LM2 — custom OpenAI-compatible endpoint configuration.
//!
//! One base URL (stored INCLUDING its `/v1`-style path prefix and used
//! verbatim as `{base}/chat/completions`) plus a manual model list, since
//! there is no discovery route that works across vLLM / LM Studio / LiteLLM /
//! Together and friends. There is deliberately NO default URL — unset means
//! "unconfigured" and the auth probe / provider fail with a Settings pointer.

/// Effective base URL, or `None` when the provider is unconfigured.
#[tauri::command]
pub fn get_custom_compat_base_url() -> Result<Option<String>, String> {
    Ok(crate::core::storage::resolve_custom_compat_base_url())
}

/// Save (or clear, with `None`/blank) the endpoint. Returns the new effective
/// value.
#[tauri::command]
pub fn set_custom_compat_base_url(base_url: Option<String>) -> Result<Option<String>, String> {
    let normalized = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::core::storage::normalize_custom_compat_base_url)
        .transpose()?;

    crate::core::storage::save_custom_compat_base_url(normalized)?;
    Ok(crate::core::storage::resolve_custom_compat_base_url())
}

#[tauri::command]
pub fn get_custom_compat_models() -> Result<Vec<String>, String> {
    Ok(crate::core::storage::load_custom_compat_models())
}

/// Replace the manual model list. Entries are trimmed, blanks dropped, and
/// duplicates removed; the normalised list is returned.
#[tauri::command]
pub fn set_custom_compat_models(models: Vec<String>) -> Result<Vec<String>, String> {
    crate::core::storage::save_custom_compat_models(models)
}

#[cfg(test)]
mod tests {
    #[test]
    fn normalize_keeps_the_v1_path_prefix() {
        // The stored URL is used verbatim as `{base}/chat/completions`, so —
        // unlike the Ollama root URL — `/v1` must survive.
        assert_eq!(
            crate::core::storage::normalize_custom_compat_base_url("http://localhost:8000/v1")
                .unwrap(),
            "http://localhost:8000/v1"
        );
        // Arbitrary gateway prefixes survive too.
        assert_eq!(
            crate::core::storage::normalize_custom_compat_base_url(
                "https://gw.example.com/openai/v1/"
            )
            .unwrap(),
            "https://gw.example.com/openai/v1"
        );
    }

    #[test]
    fn normalize_accepts_a_bare_host_without_inventing_v1() {
        assert_eq!(
            crate::core::storage::normalize_custom_compat_base_url("http://localhost:1234")
                .unwrap(),
            "http://localhost:1234"
        );
    }

    #[test]
    fn normalize_rejects_bad_urls() {
        assert!(crate::core::storage::normalize_custom_compat_base_url("").is_err());
        assert!(crate::core::storage::normalize_custom_compat_base_url("localhost:8000").is_err());
        assert!(
            crate::core::storage::normalize_custom_compat_base_url("ftp://example.com/v1").is_err()
        );
        assert!(crate::core::storage::normalize_custom_compat_base_url(
            "http://example.com/v1?key=1"
        )
        .is_err());
        assert!(crate::core::storage::normalize_custom_compat_base_url(
            "http://example.com/v1#frag"
        )
        .is_err());
    }

    #[test]
    fn model_list_normalisation_trims_dedupes_and_drops_blanks() {
        let normalized = crate::core::storage::normalize_custom_compat_models(vec![
            "  qwen2.5-72b-instruct ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "qwen2.5-72b-instruct".to_string(),
            "llama-3.3-70b".to_string(),
        ]);
        assert_eq!(
            normalized,
            vec!["qwen2.5-72b-instruct".to_string(), "llama-3.3-70b".to_string()]
        );
    }
}

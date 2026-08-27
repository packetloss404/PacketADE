//! MiniMax endpoint configuration.
//!
//! MiniMax publishes two hosts for the same API: `https://api.minimax.io/v1`
//! (global) and `https://api.minimaxi.com/v1` (mainland China). An account is
//! only valid against one of them, so the endpoint has to be user-selectable.
//! Resolution mirrors Ollama's: the saved endpoint wins, then
//! `PACKETBENCH_MINIMAX_URL`, then the documented global default.

pub(crate) fn resolve_base_url() -> String {
    crate::core::storage::resolve_minimax_base_url()
}

#[tauri::command]
pub fn get_minimax_base_url() -> Result<String, String> {
    Ok(resolve_base_url())
}

#[tauri::command]
pub fn set_minimax_base_url(base_url: Option<String>) -> Result<String, String> {
    let normalized = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::core::storage::normalize_minimax_base_url)
        .transpose()?;

    crate::core::storage::save_minimax_base_url(normalized)?;
    Ok(resolve_base_url())
}

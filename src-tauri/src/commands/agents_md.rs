//! A4 — Tauri command surface for the AGENTS.md cascading resolver.
//!
//! Returns the concatenated cascade body (or `null` when nothing is found)
//! so the frontend's `loadAgentsMd` helper stays a single round-trip
//! instead of one read per candidate file.

use crate::core::agents_md;

/// Resolve the AGENTS.md / CLAUDE.md cascade for `cwd`. See
/// `core::agents_md::resolve` for precedence rules.
#[tauri::command]
pub async fn resolve_agents_md(cwd: String) -> Result<Option<String>, String> {
    super::validate_project_path(&cwd)?;
    Ok(agents_md::resolve(&cwd))
}

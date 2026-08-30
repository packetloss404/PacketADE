//! Pinning the PacketCode ACP engine binary from the UI.
//!
//! The `api-packetcode` row is keyless — the engine owns its own provider
//! credentials — so the only thing that can make it unusable is PacketBench
//! being unable to FIND the engine. That is the common case, not an exotic
//! one: neither of packetcode's installers puts itself on `PATH`
//! (`install.ps1` says so explicitly), and anyone who builds it from source
//! lands in a directory nothing searches.
//!
//! Until this module the only remedy was exporting `PACKETBENCH_ACP_ENGINE`
//! before launching the app. That is not a UI: a desktop user cannot be
//! expected to set an environment variable, the app cannot show what was set,
//! and every other provider's not-ready badge points at Settings instead.
//!
//! These two commands live in `commands/` rather than `acp/` deliberately —
//! they are configuration, not transport. `acp::probe_engine` is CALLED here
//! to report the version a newly-pinned binary answers with, but the ACP
//! protocol surface is untouched.

use crate::acp::EngineProbe;

/// The pinned path, or `None` when the user has not pinned one.
///
/// This is the SAVED setting, not the resolved binary: `None` here does not
/// mean no engine will be found, only that resolution falls through to
/// `PACKETBENCH_ACP_ENGINE`, `PATH`, and the documented install directories.
/// Ask `acp_probe` for what actually resolved.
#[tauri::command]
pub fn get_acp_engine_path() -> Result<Option<String>, String> {
    Ok(crate::core::storage::load_saved_acp_engine_path())
}

/// Pin (or clear, with `None`/blank) the engine binary, then re-probe.
///
/// Validation happens BEFORE the write, so a rejected path never becomes the
/// stored setting — a saved-but-wrong path would take precedence over a
/// perfectly good engine on `PATH` and leave the user worse off than before
/// they touched the field.
///
/// The returned probe is what the caller shows: on success it carries the
/// version the pinned binary reported, which is the only proof that the file
/// picked is actually a packetcode engine and not some other program with the
/// right name.
#[tauri::command]
pub async fn set_acp_engine_path(path: Option<String>) -> Result<EngineProbe, String> {
    let normalized = path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::core::storage::normalize_acp_engine_path)
        .transpose()?;

    crate::core::storage::save_acp_engine_path(normalized)?;
    crate::acp::probe_engine().await
}

#[cfg(test)]
mod tests {
    use crate::core::storage::normalize_acp_engine_path;

    #[test]
    fn blank_and_relative_paths_are_refused() {
        assert!(normalize_acp_engine_path("").is_err());
        assert!(normalize_acp_engine_path("   ").is_err());
        // Relative is refused even when it exists: the engine is spawned with
        // the conversation's cwd, so it would resolve differently per session.
        assert!(normalize_acp_engine_path("packetcode").is_err());
        assert!(normalize_acp_engine_path("./packetcode").is_err());
    }

    #[test]
    fn a_missing_absolute_path_is_refused_by_name() {
        let missing = std::env::temp_dir().join("packetbench-no-such-engine-xyz");
        let err = normalize_acp_engine_path(&missing.to_string_lossy()).unwrap_err();
        assert!(
            err.contains("Cannot read"),
            "expected a read failure naming the path, got {err}"
        );
    }

    #[test]
    fn a_directory_is_refused() {
        let dir = std::env::temp_dir();
        let err = normalize_acp_engine_path(&dir.to_string_lossy()).unwrap_err();
        assert!(
            err.contains("is not a file"),
            "expected a not-a-file rejection, got {err}"
        );
    }

    #[test]
    fn an_executable_file_is_accepted_and_trimmed() {
        // Windows has no executable bit, so any regular file passes there;
        // on Unix the fixture is chmod'ed so the same case is meaningful.
        let path = std::env::temp_dir().join("packetbench-engine-fixture");
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let padded = format!("  {}  ", path.display());
        assert_eq!(
            normalize_acp_engine_path(&padded).unwrap(),
            path.to_string_lossy()
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A file with no executable bit is not the engine. Unix-only: Windows
    /// decides executability by extension, which the resolver handles.
    #[cfg(unix)]
    #[test]
    fn a_non_executable_file_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join("packetbench-engine-noexec");
        std::fs::write(&path, b"not a binary").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = normalize_acp_engine_path(&path.to_string_lossy()).unwrap_err();
        assert!(
            err.contains("not executable"),
            "expected an executable-bit rejection, got {err}"
        );
        let _ = std::fs::remove_file(&path);
    }
}

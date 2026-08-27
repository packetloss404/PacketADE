//! Seeding a CLI account's config dir.
//!
//! Multi-account CLI support relocates a coding CLI's whole state root with
//! `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. That relocates the *settings* too, so a
//! brand-new account dir starts with none of the configuration PacketBench
//! writes into the ambient dir — no statusline hook, no MCP servers. The
//! symptom is a pane whose status bar is blank and whose MCP tools are gone,
//! with nothing on screen to explain why.
//!
//! This command copies the non-secret configuration across, once, just before
//! the account's first interactive login.
//!
//! It deliberately does NOT go through the `fs` commands: those are
//! workspace-confined by `is_within_workspace`, and correctly so — the point
//! of that guard is that arbitrary paths under the user's home are off-limits.
//! Rather than widen it, this command is narrow by construction: two specific
//! filenames, a hard-coded allowlist, and no caller-supplied file list.

use serde::Serialize;
use std::path::Path;

/// Non-secret config files worth carrying into a new account dir.
///
/// HARD-CODED, never caller-supplied. A separate account exists to hold a
/// separate LOGIN, so credential files (`.credentials.json`, `credentials`,
/// `auth.json`) must never appear here — copying them would clone the very
/// login the user is trying to keep apart, which is the exact failure this
/// whole feature exists to prevent.
const SEED_FILES: &[&str] = &[
    // claude-code: statusline hook, MCP servers, permissions.
    "settings.json",
    // codex: model / profile configuration.
    "config.toml",
];

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliAccountSeedResult {
    /// True when this call created the target directory.
    pub created_dir: bool,
    /// Files copied from the source dir into the target dir.
    pub copied: Vec<String>,
    /// Files left alone because the target already had its own copy.
    pub skipped_existing: Vec<String>,
}

fn seed_into(source: &Path, target: &Path) -> Result<CliAccountSeedResult, String> {
    if source == target {
        return Err("Refusing to seed a config dir from itself".to_string());
    }

    let created_dir = !target.exists();
    std::fs::create_dir_all(target)
        .map_err(|e| format!("Could not create {}: {e}", target.display()))?;

    let mut result = CliAccountSeedResult {
        created_dir,
        ..Default::default()
    };

    for name in SEED_FILES {
        let from = source.join(name);
        // Only regular files. A directory or a dangling symlink named
        // `settings.json` is not something to copy blindly.
        if !from.is_file() {
            continue;
        }
        let to = target.join(name);
        if to.exists() {
            // Never overwrite an account's own configuration. Seeding is a
            // first-run convenience, not a sync.
            result.skipped_existing.push((*name).to_string());
            continue;
        }
        std::fs::copy(&from, &to)
            .map_err(|e| format!("Could not copy {} to {}: {e}", from.display(), to.display()))?;
        result.copied.push((*name).to_string());
    }

    Ok(result)
}

/// Create `target_dir` (if needed) and copy the non-secret config files from
/// `source_dir` into it.
///
/// Both paths must be absolute. Missing source files are not an error — a user
/// with no `~/.claude/settings.json` simply has nothing to carry over. Existing
/// target files are never overwritten.
#[tauri::command]
pub async fn seed_cli_account_config_dir(
    source_dir: String,
    target_dir: String,
) -> Result<CliAccountSeedResult, String> {
    let source = source_dir.trim();
    let target = target_dir.trim();
    if target.is_empty() {
        return Err("Target config dir is empty".to_string());
    }
    let target_path = Path::new(target);
    if !target_path.is_absolute() {
        return Err(format!("Target config dir must be absolute: {target}"));
    }

    // An absent/blank source just means "nothing to seed from" — still create
    // the dir so the login has somewhere to write.
    if source.is_empty() {
        let created_dir = !target_path.exists();
        std::fs::create_dir_all(target_path)
            .map_err(|e| format!("Could not create {}: {e}", target_path.display()))?;
        return Ok(CliAccountSeedResult {
            created_dir,
            ..Default::default()
        });
    }

    let source_path = Path::new(source);
    if !source_path.is_absolute() {
        return Err(format!("Source config dir must be absolute: {source}"));
    }

    seed_into(source_path, target_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "packetbench-seed-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_the_target_and_copies_settings() {
        let root = temp_root("copy");
        let source = root.join("ambient");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("settings.json"), b"{\"statusLine\":{}}").unwrap();
        let target = root.join("client");

        let res = seed_into(&source, &target).unwrap();

        assert!(res.created_dir);
        assert_eq!(res.copied, vec!["settings.json".to_string()]);
        assert_eq!(
            std::fs::read_to_string(target.join("settings.json")).unwrap(),
            "{\"statusLine\":{}}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn never_copies_credentials() {
        let root = temp_root("creds");
        let source = root.join("ambient");
        std::fs::create_dir_all(&source).unwrap();
        // Every credential filename either CLI is known to write.
        for name in [".credentials.json", "credentials", "auth.json"] {
            std::fs::write(source.join(name), b"secret").unwrap();
        }
        std::fs::write(source.join("settings.json"), b"{}").unwrap();
        let target = root.join("client");

        let res = seed_into(&source, &target).unwrap();

        assert_eq!(res.copied, vec!["settings.json".to_string()]);
        for name in [".credentials.json", "credentials", "auth.json"] {
            assert!(
                !target.join(name).exists(),
                "{name} must never be seeded — it would clone the login"
            );
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn does_not_overwrite_an_existing_account_config() {
        let root = temp_root("keep");
        let source = root.join("ambient");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("settings.json"), b"ambient").unwrap();
        let target = root.join("client");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("settings.json"), b"mine").unwrap();

        let res = seed_into(&source, &target).unwrap();

        assert!(!res.created_dir);
        assert!(res.copied.is_empty());
        assert_eq!(res.skipped_existing, vec!["settings.json".to_string()]);
        assert_eq!(
            std::fs::read_to_string(target.join("settings.json")).unwrap(),
            "mine"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_source_files_are_not_an_error() {
        let root = temp_root("empty");
        let source = root.join("ambient");
        std::fs::create_dir_all(&source).unwrap();
        let target = root.join("client");

        let res = seed_into(&source, &target).unwrap();

        assert!(res.created_dir);
        assert!(res.copied.is_empty());
        assert!(target.is_dir());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_to_seed_a_dir_from_itself() {
        let root = temp_root("self");
        assert!(seed_into(&root, &root).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn rejects_relative_paths() {
        assert!(
            seed_cli_account_config_dir("rel/src".into(), "rel/dst".into())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn blank_source_still_creates_the_target() {
        let root = temp_root("blank");
        let target = root.join("client");
        let res = seed_cli_account_config_dir(String::new(), target.display().to_string())
            .await
            .unwrap();
        assert!(res.created_dir);
        assert!(target.is_dir());
        std::fs::remove_dir_all(&root).ok();
    }
}

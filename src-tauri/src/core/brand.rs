//! Central brand / identity constants.
//!
//! Every hardcoded reference to the app name, data dir, keyring service,
//! HTTP user-agent, etc. should live here so the future sibling product
//! (a TUI reclaiming the "PacketCode" name) cannot collide with this IDE
//! by accident.

pub const APP_NAME: &str = "PacketADE";
pub const APP_NAME_LOWER: &str = "packetade";

/// Hidden directory under the user's home for persistent app data
/// (conversations, checkpoints, slash commands, usage logs, dictation, etc.).
pub const DATA_DIR_NAME: &str = ".packetade";

/// Legacy data dir name — used only for one-shot migration on startup.
pub const LEGACY_DATA_DIR_NAME: &str = ".packetcode";

/// Log directory name under %APPDATA% (Windows) / Library/Application Support (macOS).
pub const LOG_DIR_NAME: &str = "PacketADE";

/// Legacy log dir name — old installs may still have logs here.
pub const LEGACY_LOG_DIR_NAME: &str = "PacketCode";

/// OS keyring service identifier for stored secrets (API keys, GitHub tokens).
pub const KEYRING_SERVICE: &str = "packetade";

/// Legacy keyring service — fall back to this on read, migrate to new service.
pub const LEGACY_KEYRING_SERVICE: &str = "packetcode";

/// HTTP User-Agent for outbound requests (GitHub API, web fetch, OpenRouter).
pub const USER_AGENT: &str = "PacketADE/1.0";

/// Prefix for temporary directories created under std::env::temp_dir().
pub const TEMP_DIR_PREFIX: &str = "packetade";

/// Internal environment variable used by the self-reinvoked SSH askpass helper.
pub const SSH_ASKPASS_FILE_ENV: &str = "PACKETADE_ASKPASS_FILE";

/// Deploy config filenames searched in project root, in preference order.
/// The legacy name is kept forever so users don't have to rename project configs.
pub const DEPLOY_CONFIG_FILENAMES: &[&str] = &["packetade.deploy.json", "packetcode.deploy.json"];

/// Branded HTTP referer for OpenRouter attribution.
pub const BRAND_URL: &str = "https://packetade.dev";

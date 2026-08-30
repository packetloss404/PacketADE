//! Central brand / identity constants.
//!
//! Every hardcoded reference to the app name, data dir, keyring service,
//! HTTP user-agent, etc. should live here so the future sibling product
//! (a TUI reclaiming the "PacketCode" name) cannot collide with this IDE
//! by accident.

pub const APP_NAME: &str = "PacketBench";
pub const APP_NAME_LOWER: &str = "packetbench";

/// Hidden directory under the user's home for persistent app data
/// (conversations, slash commands, usage logs, dictation, etc.). Upgraded
/// installs may also hold `conversations/<id>/checkpoints/` left by the
/// checkpoint panel retired in 0.10.0; nothing reads or writes those now.
pub const DATA_DIR_NAME: &str = ".packetbench";

/// Legacy data dir name — used only for one-shot migration on startup.
/// This is the immediately-prior product name (PacketADE); the earlier
/// PacketCode → PacketADE migration already ran, so its data no longer exists.
pub const LEGACY_DATA_DIR_NAME: &str = ".packetade";

/// Log directory name under %APPDATA% (Windows) / Library/Application Support (macOS).
pub const LOG_DIR_NAME: &str = "PacketBench";

/// Legacy log dir name — old installs may still have logs here.
pub const LEGACY_LOG_DIR_NAME: &str = "PacketADE";

/// OS keyring service identifier for stored secrets (API keys, GitHub tokens).
pub const KEYRING_SERVICE: &str = "packetbench";

/// Legacy keyring service — fall back to this on read, migrate to new service.
pub const LEGACY_KEYRING_SERVICE: &str = "packetade";

/// HTTP User-Agent for outbound requests (GitHub API, web fetch, OpenRouter).
pub const USER_AGENT: &str = "PacketBench/1.0";

/// Query parameter that selects the read-only Monitor boot path.
pub const MONITOR_WINDOW_QUERY_KEY: &str = "packetbenchWindow";

/// GP3: GitHub OAuth App client id for device-flow auth. A device-flow client
/// id is public (not a secret), but each install must register its own OAuth
/// App and bake it here (or override at runtime via `PACKETBENCH_GITHUB_CLIENT_ID`).
/// Empty = device-flow disabled (PAT paste still works).
pub const GITHUB_OAUTH_CLIENT_ID: &str = "";

/// Prefix for temporary directories created under std::env::temp_dir().
pub const TEMP_DIR_PREFIX: &str = "packetbench";

/// Internal environment variable used by the self-reinvoked SSH askpass helper.
pub const SSH_ASKPASS_FILE_ENV: &str = "PACKETBENCH_ASKPASS_FILE";

/// Internal environment used by the self-reinvoked Claude status-line helper.
pub const CLAUDE_STATUSLINE_HELPER_ENV: &str = "PACKETBENCH_STATUSLINE_HELPER";
pub const CLAUDE_STATUSLINE_DIR_ENV: &str = "PACKETBENCH_STATUSLINE_DIR";
pub const CLAUDE_STATUSLINE_SENTINEL: &str = "__packetbench_claude_statusline";

/// Branded HTTP referer for OpenRouter attribution.
pub const BRAND_URL: &str = "https://packetbench.dev";

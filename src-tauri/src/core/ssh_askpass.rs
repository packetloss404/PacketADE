//! OpenSSH askpass bridge for password-authenticated Unix connections.
//!
//! Unix OpenSSH reads passwords from a TTY or an askpass program, never from
//! stdin. PacketBench briefly writes the keyring password to a random file with
//! mode 0600 inside a mode-0700 temporary directory, then reinvokes its own
//! executable as `SSH_ASKPASS`. The secret is never placed in argv or an
//! environment value, and the guard removes both file and directory on drop.

use std::path::Path;

use crate::core::brand::SSH_ASKPASS_FILE_ENV;

fn read_secret(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Failed to read SSH askpass secret: {e}"))
}

/// Detect a self-reinvocation by OpenSSH and print the requested password.
/// Returns `None` during a normal application launch.
pub fn helper_main() -> Option<i32> {
    let path = std::env::var_os(SSH_ASKPASS_FILE_ENV)?;
    match read_secret(Path::new(&path)).and_then(|secret| {
        use std::io::Write;
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        handle
            .write_all(&secret)
            .and_then(|_| handle.flush())
            .map_err(|e| format!("Failed to write SSH askpass secret: {e}"))
    }) {
        Ok(()) => Some(0),
        Err(message) => {
            eprintln!("{message}");
            Some(1)
        }
    }
}

#[cfg(unix)]
pub struct AskpassGuard {
    secret_path: std::path::PathBuf,
    directory: std::path::PathBuf,
}

#[cfg(unix)]
impl Drop for AskpassGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.secret_path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[cfg(unix)]
pub fn arm(command: &mut tokio::process::Command, password: &str) -> Result<AskpassGuard, String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

    let directory = std::env::temp_dir().join(format!(
        "{}-askpass-{}",
        crate::core::brand::TEMP_DIR_PREFIX,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|e| format!("Failed to create SSH askpass directory: {e}"))?;
    let guard = AskpassGuard {
        secret_path: directory.join("secret"),
        directory,
    };
    std::fs::set_permissions(&guard.directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to secure SSH askpass directory: {e}"))?;

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&guard.secret_path)
        .map_err(|e| format!("Failed to create SSH askpass secret: {e}"))?;
    file.write_all(password.as_bytes())
        .map_err(|e| format!("Failed to write SSH askpass secret: {e}"))?;

    let helper = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve SSH askpass helper: {e}"))?;
    command.env("SSH_ASKPASS", helper);
    command.env("SSH_ASKPASS_REQUIRE", "force");
    command.env(SSH_ASKPASS_FILE_ENV, &guard.secret_path);
    if std::env::var_os("DISPLAY").is_none() {
        command.env("DISPLAY", ":0");
    }

    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_secret_preserves_arbitrary_password_bytes() {
        let path = std::env::temp_dir().join(format!(
            "{}-askpass-read-{}",
            crate::core::brand::TEMP_DIR_PREFIX,
            uuid::Uuid::new_v4().simple()
        ));
        let secret = b" spaces\nquotes'\" and symbols $()` ";
        std::fs::write(&path, secret).unwrap();
        assert_eq!(read_secret(&path).unwrap(), secret);
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn arm_secures_secret_sets_environment_and_cleans_up() {
        use std::os::unix::fs::PermissionsExt;

        let mut command = tokio::process::Command::new("ssh");
        let guard = arm(&mut command, "correct horse battery staple").unwrap();
        assert_eq!(
            std::fs::read(&guard.secret_path).unwrap(),
            b"correct horse battery staple"
        );
        assert_eq!(
            std::fs::metadata(&guard.secret_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&guard.directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let envs: std::collections::HashMap<_, _> = command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
            .collect();
        assert_eq!(
            envs.get(std::ffi::OsStr::new("SSH_ASKPASS_REQUIRE")),
            Some(&std::ffi::OsString::from("force"))
        );
        assert_eq!(
            envs.get(std::ffi::OsStr::new(SSH_ASKPASS_FILE_ENV)),
            Some(&guard.secret_path.clone().into_os_string())
        );

        let secret_path = guard.secret_path.clone();
        let directory = guard.directory.clone();
        drop(guard);
        assert!(!secret_path.exists());
        assert!(!directory.exists());
    }
}

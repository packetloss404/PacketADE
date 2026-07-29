//! Repair the process `PATH` for GUI launches on macOS / Linux — **without
//! executing the user's shell**.
//!
//! When a `.app` is started from Finder, Dock, or Spotlight, `launchd` hands it
//! a minimal environment — `PATH` is just `/usr/bin:/bin:/usr/sbin:/sbin`. It
//! does *not* inherit the user's interactive shell `PATH`, so CLIs installed via
//! Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), npm/nvm/volta, or
//! `~/.local/bin` are invisible. That's why `which claude` (and `gh`, `node`,
//! `git`, …) resolve when running `tauri dev` from a terminal but fail in the
//! bundled app.
//!
//! Rather than spawn a login/interactive shell (which would *run* the user's
//! `.zshrc`/`.zprofile` and can trip macOS privacy prompts via whatever those
//! configs touch), we reconstruct `PATH` deterministically:
//!   1. keep launchd's existing entries,
//!   2. add a fixed list of well-known install dirs, and
//!   3. **read** (never execute) the user's shell rc files and lift the literal
//!      directories out of their `PATH=`/`export PATH=` assignments.
//!
//! Only directories that actually exist are added, so the resulting `PATH` stays
//! tight. Windows GUI processes already inherit the user `PATH`, so this is a
//! no-op there.

#[cfg(not(target_os = "windows"))]
use std::collections::{HashMap, HashSet};

/// Reconstruct `PATH` for a GUI launch and apply it to this process.
/// Idempotent and best-effort: failures leave the existing `PATH` intact.
#[cfg(not(target_os = "windows"))]
pub fn fix_path_for_gui_launch() {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();

    let mut merged: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |dir: &str, require_exists: bool| {
        let dir = dir.trim().trim_end_matches('/');
        if dir.is_empty() || dir == "/" {
            return;
        }
        if require_exists && !std::path::Path::new(dir).is_dir() {
            return;
        }
        if seen.insert(dir.to_string()) {
            merged.push(dir.to_string());
        }
    };

    // 1. Preserve whatever launchd already gave us (these all exist).
    for dir in current.split(':') {
        push(dir, false);
    }

    // 2. Well-known install locations (added only if present on disk).
    let mut known = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
    ];
    if !home.is_empty() {
        for sub in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
            ".volta/bin",
            ".deno/bin",
        ] {
            known.push(format!("{home}/{sub}"));
        }
    }
    for dir in &known {
        push(dir, true);
    }

    // 3. Directories declared in the user's shell rc files (read, not executed).
    if !home.is_empty() {
        for dir in dirs_from_rc_files(&home) {
            push(&dir, true);
        }
    }

    let new_path = merged.join(":");
    if new_path != current {
        std::env::set_var("PATH", &new_path);
        tracing::info!(
            entries = merged.len(),
            "Reconstructed PATH for GUI launch (no shell executed)"
        );
    }
}

#[cfg(target_os = "windows")]
pub fn fix_path_for_gui_launch() {
    // Windows GUI processes inherit the user PATH; nothing to repair.
}

/// Parse the user's shell rc files (without running them) and return the literal
/// directories named in their `PATH=` / `export PATH=` assignments.
///
/// This is a deliberately small parser: it handles the overwhelmingly common
/// `export PATH="$HOME/x/bin:$PATH"` / `export PATH=/abs/dir:$PATH` forms,
/// expands `$HOME`/`~` and any plain `VAR=` assignments it has already seen, and
/// silently skips anything with unresolved variables or shell syntax it doesn't
/// understand. Worst case it returns fewer dirs and the fixed known-locations
/// list above carries the load.
#[cfg(not(target_os = "windows"))]
fn dirs_from_rc_files(home: &str) -> Vec<String> {
    let mut vars: HashMap<String, String> = HashMap::new();
    vars.insert("HOME".to_string(), home.to_string());

    let mut dirs: Vec<String> = Vec::new();

    // zshenv → zprofile → zshrc, then the bash/posix equivalents. Order mirrors
    // a real shell so later assignments can reference earlier vars.
    let rc_files = [
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".profile",
        ".bash_profile",
        ".bashrc",
    ];

    for name in rc_files {
        let path = format!("{home}/{name}");
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        for raw in contents.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let line = line.strip_prefix("export ").unwrap_or(line).trim_start();

            let Some((name, value)) = line.split_once('=') else {
                continue;
            };
            let name = name.trim();
            if !is_identifier(name) {
                continue;
            }

            // Strip one layer of matching quotes and trailing comments.
            let value = strip_quotes(value.trim());
            let expanded = expand(value, &vars);

            if name == "PATH" {
                for tok in expanded.split(':') {
                    let tok = tok.trim();
                    // Skip the recursive $PATH reference and any token we could
                    // not fully resolve.
                    if tok.is_empty() || tok.contains('$') {
                        continue;
                    }
                    dirs.push(tok.to_string());
                }
            }
            // Record the var so later lines (e.g. $ANDROID_HOME/platform-tools)
            // can be expanded. Skip values we couldn't resolve.
            if !expanded.contains('$') {
                vars.insert(name.to_string(), expanded);
            }
        }
    }

    dirs
}

#[cfg(not(target_os = "windows"))]
fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.chars().next().unwrap().is_ascii_digit()
}

/// Strip one layer of surrounding matching quotes, and drop a trailing
/// unquoted `# comment`.
#[cfg(not(target_os = "windows"))]
fn strip_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        return &value[1..value.len() - 1];
    }
    // Unquoted: a space or '#' ends the value.
    value
        .split_once(" #")
        .map(|(v, _)| v)
        .unwrap_or(value)
        .split(char::is_whitespace)
        .next()
        .unwrap_or(value)
}

/// Expand `$HOME`, `${HOME}`, leading `~`, and any `$VAR`/`${VAR}` present in
/// `vars`. Unknown variables are left intact (with their `$`) so callers can
/// detect and skip unresolved tokens.
#[cfg(not(target_os = "windows"))]
fn expand(value: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    // Leading ~ → HOME.
    if value.starts_with('~') {
        if let Some(h) = vars.get("HOME") {
            out.push_str(h);
            chars.next();
        }
    }

    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        // Read a ${NAME} or $NAME variable reference.
        let braced = chars.peek() == Some(&'{');
        if braced {
            chars.next();
        }
        let mut name = String::new();
        while let Some(&nc) = chars.peek() {
            if (braced && nc == '}') || (!braced && !(nc.is_ascii_alphanumeric() || nc == '_')) {
                break;
            }
            name.push(nc);
            chars.next();
        }
        if braced && chars.peek() == Some(&'}') {
            chars.next();
        }
        match vars.get(&name) {
            Some(v) => out.push_str(v),
            None => {
                // Leave it unresolved so the token gets skipped downstream.
                out.push('$');
                if braced {
                    out.push('{');
                    out.push_str(&name);
                    out.push('}');
                } else {
                    out.push_str(&name);
                }
            }
        }
    }
    out
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    fn vars() -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("HOME".to_string(), "/Users/x".to_string());
        m
    }

    #[test]
    fn expands_home_forms() {
        let v = vars();
        assert_eq!(expand("$HOME/.local/bin", &v), "/Users/x/.local/bin");
        assert_eq!(expand("${HOME}/.bun/bin", &v), "/Users/x/.bun/bin");
        assert_eq!(expand("~/.opencode/bin", &v), "/Users/x/.opencode/bin");
    }

    #[test]
    fn leaves_unknown_vars_unresolved() {
        let v = vars();
        // $PATH and $ANDROID_HOME are not in the map → kept with `$` so the
        // caller skips them.
        assert!(expand("$ANDROID_HOME/platform-tools", &v).contains('$'));
        assert_eq!(expand("/abs:$PATH", &v), "/abs:$PATH");
    }

    #[test]
    fn strips_quotes_and_comments() {
        assert_eq!(strip_quotes("\"$HOME/x\""), "$HOME/x");
        assert_eq!(strip_quotes("'$HOME/x'"), "$HOME/x");
        assert_eq!(strip_quotes("/abs/dir # trailing"), "/abs/dir");
        assert_eq!(strip_quotes("/abs/dir"), "/abs/dir");
    }

    #[test]
    fn identifier_rules() {
        assert!(is_identifier("PATH"));
        assert!(is_identifier("ANDROID_HOME"));
        assert!(!is_identifier("2FOO"));
        assert!(!is_identifier("FO-O"));
        assert!(!is_identifier(""));
    }
}

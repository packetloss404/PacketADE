//! A4: Cascading AGENTS.md / CLAUDE.md resolver.
//!
//! Walks an inclusive path from the user's `~/.claude/` (or `CLAUDE_HOME`
//! env override) down through the git working tree to `cwd`, picks at most
//! one of `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` per directory,
//! concatenates root-to-leaf with source-attribution headers, and caps the
//! result at 32 KiB. Empty files are skipped.
//!
//! Mirrors Codex CLI 0.122+'s spec (developers.openai.com/codex/guides/agents-md)
//! so a project's `AGENTS.md` works the same in Codex and PacketADE — and
//! so a single repo can carry one file that both tools honor.

use std::path::{Path, PathBuf};

/// 32 KiB cap on the concatenated output. Matches Codex's
/// `project_doc_max_bytes` default.
const MAX_BYTES: usize = 32 * 1024;

/// Per-directory candidate filenames in precedence order. The walk picks
/// at most ONE per directory (first match wins), then concatenates across
/// directories root → leaf so leaves override roots in the model's view.
const PER_DIR_CANDIDATES: &[&str] = &["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

/// Home-level files, in precedence order. Read first so they sit at the
/// top of the concatenated prompt (lowest precedence — leaf-most file in
/// the cascade wins on conflicts via positional override).
const HOME_FILES: &[&str] = &["AGENTS.override.md", "AGENTS.md"];

/// Resolve the cascade for `cwd`. Returns `None` when no AGENTS file is
/// found anywhere along the path. Read errors on individual files are
/// silently skipped — a missing file is the common case.
pub fn resolve(cwd: &str) -> Option<String> {
    let cwd_path = Path::new(cwd);
    if !cwd_path.exists() {
        return None;
    }

    let home = home_dir();
    let mut sections: Vec<String> = Vec::new();

    // 1. Home-level files first (precedence floor).
    if let Some(home) = home.as_ref() {
        for name in HOME_FILES {
            let path = home.join(name);
            if let Some(section) = try_section(&path) {
                sections.push(section);
            }
        }
    }

    // 2. Per-directory cascade from git root down to cwd. Falls back to
    //    just cwd when `git rev-parse --show-toplevel` fails (not a repo).
    let dirs = directory_chain(cwd_path);
    for dir in &dirs {
        for name in PER_DIR_CANDIDATES {
            let path = dir.join(name);
            if let Some(section) = try_section(&path) {
                sections.push(section);
                break; // first match per directory only
            }
        }
    }

    if sections.is_empty() {
        return None;
    }

    // Concat with separators + cap. Truncate at MAX_BYTES on a UTF-8 char
    // boundary so we never split a multi-byte sequence.
    let joined = sections.join("\n\n---\n\n");
    if joined.len() <= MAX_BYTES {
        Some(joined)
    } else {
        let cap = floor_char_boundary(&joined, MAX_BYTES);
        let mut truncated = joined[..cap].to_string();
        truncated.push_str("\n\n…(truncated at 32 KiB cap)");
        Some(truncated)
    }
}

/// Read a candidate file. Returns `None` when missing, unreadable, or
/// empty. Wraps the body with a `<!-- source: <path> -->` header so the
/// model can see which file each section came from when debugging
/// cascade conflicts.
fn try_section(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!(
        "<!-- source: {} -->\n{}",
        path.display(),
        trimmed
    ))
}

/// Build the inclusive root → cwd directory chain. Uses `git
/// rev-parse --show-toplevel` to find the root; falls back to just
/// `cwd` when the repo lookup fails.
fn directory_chain(cwd: &Path) -> Vec<PathBuf> {
    let cwd_buf = cwd.to_path_buf();
    let root = match super::git::get_toplevel(&cwd_buf.to_string_lossy()) {
        Ok(s) => PathBuf::from(s),
        Err(_) => return vec![cwd_buf],
    };

    // Build the chain by walking up from cwd until we hit root, then
    // reverse so the iteration order is root → leaf.
    let mut chain: Vec<PathBuf> = Vec::new();
    let mut cur: &Path = &cwd_buf;
    loop {
        chain.push(cur.to_path_buf());
        if cur == root {
            break;
        }
        match cur.parent() {
            Some(p) if p != cur => cur = p,
            _ => break, // safety: don't loop forever if the path geometry is odd
        }
    }
    chain.reverse();
    chain
}

/// Resolve the user's PacketADE/Claude home directory. `CLAUDE_HOME`
/// env var wins (mirrors Codex's `CODEX_HOME` for CI parity); otherwise
/// `~/.claude/`.
fn home_dir() -> Option<PathBuf> {
    if let Ok(env) = std::env::var("CLAUDE_HOME") {
        if !env.is_empty() {
            return Some(PathBuf::from(env));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// `str::floor_char_boundary` is unstable on stable Rust as of writing;
/// this is the same algorithm. Walks back from `index` until a char
/// boundary is found. `index <= s.len()` is a precondition.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

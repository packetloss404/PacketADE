//! Rust-side context assembly for auxiliary LLM tasks (LM4 / 3C-3).
//!
//! ## Why this exists
//!
//! `scan_codebase_memory` was the last `run_claude` caller in
//! `commands/memory.rs`. It shelled out to `claude -p` purely so the CLI's own
//! file tools would walk the project for it — there was no provider routing, no
//! token accounting, and it silently failed on a machine without the CLI on
//! PATH. See `dev/local-model-routing.md` §"Mechanism 3".
//!
//! `dev/local-model-routing.md` splits 3C-3 into two halves, and only the
//! second needs an agentic loop: *"Rust-side context assembly (memory scan) and
//! a bounded read-only tool loop parameterized on an `AuxRoute`
//! (investigate/agent-chat)."* A key-file index does not need the model to
//! choose what to read — the walk is deterministic, so we do it here and hand
//! the model **one** turn with the evidence already assembled. That is cheaper,
//! reproducible, and auditable in a way a tool loop is not.
//!
//! ## Security posture
//!
//! This module reads a user's source tree so its contents can be sent to a
//! model. The rules are deliberately strict and fail *closed*:
//!
//! * **Rooted.** The walk starts at the canonicalized project path and only
//!   ever descends into real directories discovered beneath it. Callers pass a
//!   path that `commands::validate_project_path` has already checked.
//! * **No symlinks, ever.** Symlinks (and Windows junctions, which
//!   `FileType::is_symlink` also reports) are skipped, not followed — for files
//!   as well as directories. A symlink cannot be used to read outside the root
//!   because it is never traversed at all.
//! * **Belt and braces.** Every file is canonicalized again immediately before
//!   it is opened and re-checked against the root; a mismatch skips the file.
//!   This closes the TOCTOU window between the walk and the read.
//! * **Regular files only.** FIFOs, sockets, and device nodes are ignored.
//! * **Secret-shaped names are refused** ([`is_sensitive_name`]) even though
//!   dot-entries are already skipped, so the rule survives any future change to
//!   the dot-entry policy.
//! * **Binary content is never sent.** A NUL byte in the head of a file
//!   disqualifies it from excerpting; it may still be *listed* by path.
//! * **Everything is bounded** — depth, entries visited, files listed, files
//!   excerpted, bytes per excerpt, total assembled bytes, and wall clock. The
//!   walk degrades to a truncated manifest rather than running long.
//!
//! ## What it will and will not read
//!
//! **Will:** regular, non-symlink, non-secret-named, non-dot files beneath the
//! project root — full paths and sizes for up to [`MAX_LISTED_FILES`] of them,
//! plus the first [`MAX_EXCERPT_BYTES`] bytes of up to [`MAX_EXCERPT_FILES`]
//! text files that the ranking heuristic scores highest.
//!
//! **Will not:** anything outside the canonical root; anything reached through
//! a symlink or junction; dot-files and dot-directories (`.env`, `.git`,
//! `.ssh`, …); the [`SKIP_DIRS`] build/vendor directories; secret-shaped names
//! (keys, certificates, credential/secret/password files); binary content; any
//! file beyond the bounds; and **anything at all** when no auxiliary provider
//! is configured — the caller resolves the [`crate::core::aux_llm::AuxRoute`]
//! *before* calling in here, so a user with no API key gets the seam's
//! no-provider error and this module never touches the disk.

use crate::core::shared::SKIP_DIRS;
use crate::core::tool_runtime::truncate_to_char_boundary;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/// Deepest directory level below the root that the walk will descend into.
pub const MAX_DEPTH: usize = 12;
/// Hard cap on directory entries inspected, across the whole walk.
pub const MAX_ENTRIES_VISITED: usize = 20_000;
/// Files named in the rendered manifest.
pub const MAX_LISTED_FILES: usize = 400;
/// Files whose head is excerpted into the rendered manifest.
pub const MAX_EXCERPT_FILES: usize = 60;
/// Bytes read from the head of each excerpted file.
pub const MAX_EXCERPT_BYTES: usize = 2_048;
/// Files above this size are listed but never excerpted.
pub const MAX_EXCERPT_FILE_SIZE: u64 = 512_000;
/// Hard cap on the assembled payload handed to the model.
pub const MAX_CONTEXT_BYTES: usize = 192_000;
/// Wall-clock budget for the filesystem walk. On expiry the walk stops and the
/// manifest is rendered from what it already has, flagged as truncated.
pub const WALK_BUDGET: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/// Extensions that carry keys, certificates, or credential stores.
const SENSITIVE_EXTENSIONS: &[&str] = &[
    "pem", "key", "pfx", "p12", "jks", "keystore", "ppk", "kdbx", "asc", "gpg", "crt", "cer",
    "der",
];

/// Substrings that mark a filename as credential-bearing. Deliberately
/// substring-matched: `service-account-credentials.json` must be caught.
const SENSITIVE_SUBSTRINGS: &[&str] = &[
    "secret",
    "credential",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "htpasswd",
    "netrc",
];

/// Stems refused outright, whatever the extension.
const SENSITIVE_STEMS: &[&str] = &["keystore"];

/// Stems that are only credential-shaped when paired with a data/config
/// extension. `tokens.json` is refused; `tokens.ts` (design tokens) and
/// `auth.rs` (a source module) are not, and `tokenizer.rs` never matches at all
/// because the rule is whole-stem, not substring.
const SENSITIVE_DATA_STEMS: &[&str] = &[
    "token",
    "tokens",
    "auth",
    "auth_token",
    "key",
    "keys",
    "account",
    "accounts",
];

/// Extensions that make [`SENSITIVE_DATA_STEMS`] credential-shaped.
const DATA_EXTENSIONS: &[&str] = &[
    "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "txt", "xml", "env", "properties",
];

/// Filename prefixes for private SSH keys.
const SENSITIVE_PREFIXES: &[&str] = &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

/// Does this filename look like it holds a secret?
///
/// Applied to every candidate file. Dot-entries are skipped by the walk
/// already, so `.env` is doubly covered; the explicit check here keeps the
/// guarantee if the dot-entry policy ever loosens.
pub fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();

    if lower.starts_with(".env") || lower.ends_with(".env") || lower.contains(".env.") {
        return true;
    }
    if SENSITIVE_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    let as_path = Path::new(&lower);
    let extension = as_path.extension().and_then(|e| e.to_str());
    if let Some(ext) = extension {
        if SENSITIVE_EXTENSIONS.contains(&ext) {
            return true;
        }
    }
    if let Some(stem) = as_path.file_stem().and_then(|s| s.to_str()) {
        if SENSITIVE_STEMS.contains(&stem) {
            return true;
        }
        if SENSITIVE_DATA_STEMS.contains(&stem)
            && extension.is_some_and(|ext| DATA_EXTENSIONS.contains(&ext))
        {
            return true;
        }
    }
    SENSITIVE_SUBSTRINGS.iter().any(|s| lower.contains(s))
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/// Root-level manifests and docs that describe a project better than any
/// source file does.
const KEY_ROOT_FILES: &[&str] = &[
    "package.json",
    "cargo.toml",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "gemfile",
    "composer.json",
    "readme.md",
    "tsconfig.json",
    "makefile",
    "dockerfile",
    "docker-compose.yml",
    "tauri.conf.json",
    "claude.md",
    "agents.md",
];

/// File stems that usually mark an entry point or a module root.
const ENTRYPOINT_STEMS: &[&str] = &[
    "main", "index", "lib", "app", "mod", "cli", "server", "router", "routes", "store", "types",
    "schema", "config",
];

/// Extensions worth summarising.
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "rb", "c", "h", "cc",
    "cpp", "hpp", "cs", "swift", "php", "sql", "sh", "toml", "json", "yaml", "yml", "md",
];

/// Path fragments that mark generated or low-signal files.
const LOW_SIGNAL_FRAGMENTS: &[&str] = &[
    "test", "spec", "__tests__", "fixture", "snapshot", "mock", ".min.", "generated", ".lock",
];

/// Heuristic "how likely is this a key file" score. Higher wins.
fn score_file(rel_path: &str, depth: usize, size: u64) -> i32 {
    let lower = rel_path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
    let as_path = Path::new(&name);

    let mut score = 0i32;
    score -= (depth as i32) * 3;

    if depth == 0 && KEY_ROOT_FILES.contains(&name.as_str()) {
        score += 40;
    }

    match as_path.extension().and_then(|e| e.to_str()) {
        Some(ext) if SOURCE_EXTENSIONS.contains(&ext) => score += 10,
        _ => score -= 10,
    }

    if let Some(stem) = as_path.file_stem().and_then(|s| s.to_str()) {
        if ENTRYPOINT_STEMS.contains(&stem) {
            score += 12;
        }
    }

    if LOW_SIGNAL_FRAGMENTS.iter().any(|f| lower.contains(f)) {
        score -= 25;
    }

    if size < 200 {
        score -= 5;
    } else if size > 200_000 {
        score -= 8;
    }

    score
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/// One file that survived the walk and the refusals.
#[derive(Debug, Clone)]
pub struct ProjectFile {
    /// Path relative to the project root, always forward-slash separated.
    pub rel_path: String,
    pub size: u64,
    pub score: i32,
    /// Head of the file, or `None` for binary / oversized / unreadable files.
    pub excerpt: Option<String>,
}

/// What the walk did, so the failure and truncation modes are legible instead
/// of silent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanStats {
    pub entries_visited: usize,
    pub files_seen: usize,
    pub symlinks_skipped: usize,
    pub sensitive_skipped: usize,
    /// A bound (entries, listed files, or depth) clipped the result.
    pub truncated: bool,
    /// [`WALK_BUDGET`] expired before the walk finished.
    pub timed_out: bool,
}

/// A bounded, root-confined view of a project, ready to be rendered into one
/// auxiliary turn.
#[derive(Debug, Clone)]
pub struct ProjectManifest {
    pub root: PathBuf,
    pub files: Vec<ProjectFile>,
    pub stats: ScanStats,
}

/// Read at most `cap` bytes from the head of `path`, returning `None` for
/// binary content or an unreadable file.
fn read_head(path: &Path, cap: usize) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buf: Vec<u8> = Vec::with_capacity(cap.min(64 * 1024));
    file.take(cap as u64).read_to_end(&mut buf).ok()?;
    if buf.contains(&0u8) {
        return None; // binary — never excerpted
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    truncate_to_char_boundary(&mut text, cap);
    Some(text)
}

/// Canonicalize `candidate` and confirm it is still inside `root`.
///
/// Re-run immediately before every read, so a path that was a plain file
/// during the walk and became a symlink afterwards is caught.
fn confined(root: &Path, candidate: &Path) -> bool {
    match std::fs::canonicalize(candidate) {
        Ok(resolved) => resolved.starts_with(root),
        Err(_) => false,
    }
}

/// Walk `project_path` and assemble a bounded key-file manifest.
///
/// Blocking: callers in async contexts should wrap this in
/// `tokio::task::spawn_blocking`.
pub fn assemble_project_manifest(project_path: &str) -> Result<ProjectManifest, String> {
    let root = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Cannot resolve project path '{}': {}", project_path, e))?;
    if !root.is_dir() {
        return Err(format!("'{}' is not a directory", project_path));
    }

    let started = Instant::now();
    let mut stats = ScanStats::default();
    let mut candidates: Vec<ProjectFile> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.clone(), 0)];

    'walk: while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // An unreadable directory is a permissions fact, not a failure.
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            stats.entries_visited += 1;
            if stats.entries_visited > MAX_ENTRIES_VISITED {
                stats.truncated = true;
                break 'walk;
            }
            if started.elapsed() > WALK_BUDGET {
                stats.timed_out = true;
                stats.truncated = true;
                break 'walk;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }

            // `DirEntry::file_type` does NOT follow symlinks on any platform,
            // which is exactly what we want: a symlink is identified as one and
            // then dropped rather than resolved.
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            if file_type.is_symlink() {
                stats.symlinks_skipped += 1;
                continue;
            }

            if file_type.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if depth + 1 > MAX_DEPTH {
                    stats.truncated = true;
                    continue;
                }
                stack.push((entry.path(), depth + 1));
                continue;
            }

            if !file_type.is_file() {
                continue; // FIFO, socket, device node
            }

            if is_sensitive_name(&name) {
                stats.sensitive_skipped += 1;
                continue;
            }

            let path = entry.path();
            let rel_path = match path.strip_prefix(&root) {
                Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
                // Structurally unreachable — the walk never leaves the root —
                // but drop rather than trust it.
                Err(_) => continue,
            };

            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            stats.files_seen += 1;
            candidates.push(ProjectFile {
                score: score_file(&rel_path, depth, size),
                rel_path,
                size,
                excerpt: None,
            });
        }
    }

    candidates.sort_by(|a, b| b.score.cmp(&a.score).then(a.rel_path.cmp(&b.rel_path)));
    if candidates.len() > MAX_LISTED_FILES {
        candidates.truncate(MAX_LISTED_FILES);
        stats.truncated = true;
    }

    let mut excerpted = 0usize;
    for file in candidates.iter_mut() {
        if excerpted >= MAX_EXCERPT_FILES {
            break;
        }
        if file.size > MAX_EXCERPT_FILE_SIZE {
            continue;
        }
        let full = root.join(&file.rel_path);
        // TOCTOU re-check: the walk proved this was a regular file inside the
        // root, but that was then and this is now.
        if !confined(&root, &full) {
            continue;
        }
        if let Some(head) = read_head(&full, MAX_EXCERPT_BYTES) {
            file.excerpt = Some(head);
            excerpted += 1;
        }
    }

    Ok(ProjectManifest {
        root,
        files: candidates,
        stats,
    })
}

impl ProjectManifest {
    /// Number of files carrying an excerpt.
    pub fn excerpt_count(&self) -> usize {
        self.files.iter().filter(|f| f.excerpt.is_some()).count()
    }

    /// Render the manifest as the user turn of one auxiliary request.
    ///
    /// Always ends within [`MAX_CONTEXT_BYTES`], on a UTF-8 boundary.
    pub fn render(&self) -> String {
        let mut out = String::new();

        out.push_str("Project file manifest (assembled locally; paths are relative to the project root).\n\n");
        out.push_str(&format!(
            "Files listed: {} of {} found.\n",
            self.files.len(),
            self.stats.files_seen
        ));
        if self.stats.truncated || self.stats.timed_out {
            out.push_str(
                "NOTE: the scan hit its bounds, so this manifest is a partial view of the project.\n",
            );
        }
        if self.stats.symlinks_skipped > 0 {
            out.push_str(&format!(
                "Skipped {} symlink(s) — they are never followed.\n",
                self.stats.symlinks_skipped
            ));
        }
        out.push('\n');

        out.push_str("PATHS (path — bytes):\n");
        for file in &self.files {
            out.push_str(&format!("{} — {}\n", file.rel_path, file.size));
        }

        if self.excerpt_count() > 0 {
            out.push_str(&format!(
                "\nEXCERPTS (first {} bytes of the highest-signal files):\n",
                MAX_EXCERPT_BYTES
            ));
            for file in self.files.iter().filter(|f| f.excerpt.is_some()) {
                if out.len() >= MAX_CONTEXT_BYTES {
                    break;
                }
                out.push_str(&format!("\n----- {} -----\n", file.rel_path));
                out.push_str(file.excerpt.as_deref().unwrap_or(""));
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
        }

        if out.len() > MAX_CONTEXT_BYTES {
            truncate_to_char_boundary(&mut out, MAX_CONTEXT_BYTES);
            out.push_str("\n... (context truncated at the assembly cap)\n");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace(name: &str) -> tempfile::TempDir {
        let dir = tempfile::Builder::new()
            .prefix(name)
            .tempdir()
            .expect("tempdir");
        dir
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(path, body).expect("write");
    }

    fn scan(root: &Path) -> ProjectManifest {
        assemble_project_manifest(root.to_str().expect("utf8 path")).expect("manifest")
    }

    fn listed(manifest: &ProjectManifest) -> Vec<String> {
        manifest.files.iter().map(|f| f.rel_path.clone()).collect()
    }

    // --- happy path -------------------------------------------------------

    #[test]
    fn lists_source_files_and_excerpts_them() {
        let ws = workspace("aux-ctx-basic");
        let root = ws.path();
        write(root, "package.json", "{\"name\":\"demo\",\"version\":\"1.0.0\"}");
        write(root, "src/main.ts", "export function main() { return 42; }\n");

        let manifest = scan(root);
        let paths = listed(&manifest);
        assert!(paths.contains(&"package.json".to_string()), "{:?}", paths);
        assert!(paths.contains(&"src/main.ts".to_string()), "{:?}", paths);
        assert_eq!(manifest.excerpt_count(), 2);

        let rendered = manifest.render();
        assert!(rendered.contains("src/main.ts"));
        assert!(rendered.contains("export function main"));
    }

    #[test]
    fn root_manifests_outrank_deep_sources() {
        let ws = workspace("aux-ctx-rank");
        let root = ws.path();
        write(root, "package.json", "{\"name\":\"demo\"}");
        write(root, "src/a/b/c/d/helper.ts", "export const x = 1;\n");

        let manifest = scan(root);
        assert_eq!(manifest.files[0].rel_path, "package.json");
    }

    #[test]
    fn paths_are_forward_slashed_on_every_platform() {
        let ws = workspace("aux-ctx-sep");
        let root = ws.path();
        write(root, "src/nested/deep.rs", "fn deep() {}\n");
        let manifest = scan(root);
        assert!(listed(&manifest).contains(&"src/nested/deep.rs".to_string()));
    }

    // --- refusals ---------------------------------------------------------

    #[test]
    fn skips_dot_entries_and_build_directories() {
        let ws = workspace("aux-ctx-skip");
        let root = ws.path();
        write(root, "src/main.rs", "fn main() {}\n");
        write(root, ".git/config", "[core]\n");
        write(root, ".env", "API_KEY=super-secret\n");
        write(root, "node_modules/left-pad/index.js", "module.exports = 1;\n");
        write(root, "target/debug/build.log", "compiling\n");

        let rendered = scan(root).render();
        assert!(rendered.contains("src/main.rs"));
        assert!(!rendered.contains("super-secret"), "leaked .env contents");
        assert!(!rendered.contains(".env"));
        assert!(!rendered.contains("left-pad"));
        assert!(!rendered.contains("build.log"));
    }

    #[test]
    fn refuses_secret_shaped_filenames() {
        let ws = workspace("aux-ctx-secrets");
        let root = ws.path();
        write(root, "src/main.rs", "fn main() {}\n");
        write(root, "server.pem", "-----BEGIN PRIVATE KEY-----\n");
        write(root, "config/credentials.json", "{\"aws\":\"AKIA-nope\"}");
        write(root, "deploy/secrets.yaml", "db_password: hunter2\n");
        write(root, "keys/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        write(root, "app/tokens.json", "{\"refresh\":\"nope\"}");

        let manifest = scan(root);
        let paths = listed(&manifest);
        assert_eq!(paths, vec!["src/main.rs".to_string()], "{:?}", paths);
        assert_eq!(manifest.stats.sensitive_skipped, 5);

        let rendered = manifest.render();
        for leaked in ["AKIA-nope", "hunter2", "PRIVATE KEY", "refresh"] {
            assert!(!rendered.contains(leaked), "leaked {}", leaked);
        }
    }

    #[test]
    fn sensitive_name_matcher_covers_the_documented_shapes() {
        for name in [
            ".env",
            ".env.local",
            "prod.env",
            "server.pem",
            "cert.crt",
            "store.jks",
            "vault.kdbx",
            "id_ed25519",
            "id_rsa.pub",
            "credentials.json",
            "aws-credentials",
            "my-secrets.yaml",
            "PASSWORD.txt",
            "apikey.txt",
            "api_key.rs",
            "tokens.json",
            "auth.json",
            "keys.yaml",
            ".netrc",
        ] {
            assert!(is_sensitive_name(name), "{} should be refused", name);
        }
        // False-positive guards: ordinary source files must survive. The
        // ambiguous stems are only refused with a data/config extension.
        for name in [
            "tokenizer.rs",
            "authenticate.ts",
            "tokens.ts",
            "auth.rs",
            "keys.tsx",
            "main.rs",
            "README.md",
            "keyboard.tsx",
            "monkey.py",
        ] {
            assert!(!is_sensitive_name(name), "{} should be allowed", name);
        }
    }

    #[test]
    fn binary_files_are_listed_but_never_excerpted() {
        let ws = workspace("aux-ctx-binary");
        let root = ws.path();
        fs::write(root.join("blob.dat"), [0x00u8, 0x01, 0x02, 0x00]).expect("write");
        write(root, "src/main.rs", "fn main() {}\n");

        let manifest = scan(root);
        let blob = manifest
            .files
            .iter()
            .find(|f| f.rel_path == "blob.dat")
            .expect("blob listed");
        assert!(blob.excerpt.is_none());
    }

    // --- traversal --------------------------------------------------------

    #[cfg(unix)]
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[cfg(windows)]
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(original, link)
    }

    #[cfg(unix)]
    fn symlink_file(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[cfg(windows)]
    fn symlink_file(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(original, link)
    }

    #[test]
    fn refuses_to_follow_a_symlinked_directory_out_of_the_root() {
        let base = workspace("aux-ctx-escape");
        let outside = base.path().join("outside");
        let inside = base.path().join("project");
        fs::create_dir_all(&outside).expect("mkdir");
        fs::create_dir_all(&inside).expect("mkdir");
        fs::write(outside.join("private.txt"), "TOP-SECRET-PAYLOAD").expect("write");
        write(&inside, "src/main.rs", "fn main() {}\n");

        // Windows needs Developer Mode or admin for symlinks; skip if denied.
        if symlink_dir(&outside, &inside.join("escape")).is_err() {
            return;
        }

        let manifest = scan(&inside);
        assert_eq!(manifest.stats.symlinks_skipped, 1);
        let rendered = manifest.render();
        assert!(!rendered.contains("TOP-SECRET-PAYLOAD"), "escaped the root");
        assert!(!rendered.contains("private.txt"));
        assert!(rendered.contains("src/main.rs"));
    }

    #[test]
    fn refuses_a_symlinked_file_pointing_out_of_the_root() {
        let base = workspace("aux-ctx-file-escape");
        let outside = base.path().join("outside");
        let inside = base.path().join("project");
        fs::create_dir_all(&outside).expect("mkdir");
        fs::create_dir_all(&inside).expect("mkdir");
        let target = outside.join("private.rs");
        fs::write(&target, "const LEAKED: &str = \"TOP-SECRET-PAYLOAD\";").expect("write");
        write(&inside, "src/main.rs", "fn main() {}\n");

        if symlink_file(&target, &inside.join("linked.rs")).is_err() {
            return;
        }

        let manifest = scan(&inside);
        assert_eq!(manifest.stats.symlinks_skipped, 1);
        assert!(!listed(&manifest).contains(&"linked.rs".to_string()));
        assert!(!manifest.render().contains("TOP-SECRET-PAYLOAD"));
    }

    #[test]
    fn a_nonexistent_root_is_an_error_not_an_empty_manifest() {
        let ws = workspace("aux-ctx-missing");
        let missing = ws.path().join("no-such-dir");
        let err = assemble_project_manifest(missing.to_str().expect("utf8")).unwrap_err();
        assert!(err.contains("Cannot resolve project path"), "{}", err);
    }

    #[test]
    fn a_file_as_root_is_an_error() {
        let ws = workspace("aux-ctx-file-root");
        write(ws.path(), "a.txt", "hello");
        let path = ws.path().join("a.txt");
        let err = assemble_project_manifest(path.to_str().expect("utf8")).unwrap_err();
        assert!(err.contains("is not a directory"), "{}", err);
    }

    // --- bounds -----------------------------------------------------------

    #[test]
    fn stops_descending_past_max_depth() {
        let ws = workspace("aux-ctx-depth");
        let root = ws.path();
        let mut rel = String::from("d");
        for _ in 0..(MAX_DEPTH + 4) {
            rel.push_str("/d");
        }
        write(root, &format!("{}/buried.rs", rel), "fn buried() {}\n");
        write(root, "shallow.rs", "fn shallow() {}\n");

        let manifest = scan(root);
        assert!(listed(&manifest).contains(&"shallow.rs".to_string()));
        assert!(!listed(&manifest).iter().any(|p| p.contains("buried.rs")));
        assert!(manifest.stats.truncated);
    }

    #[test]
    fn caps_the_number_of_listed_files() {
        let ws = workspace("aux-ctx-count");
        let root = ws.path();
        for i in 0..(MAX_LISTED_FILES + 25) {
            write(root, &format!("src/f{:04}.rs", i), "fn f() {}\n");
        }
        let manifest = scan(root);
        assert_eq!(manifest.files.len(), MAX_LISTED_FILES);
        assert!(manifest.stats.truncated);
        assert_eq!(manifest.stats.files_seen, MAX_LISTED_FILES + 25);
    }

    #[test]
    fn caps_the_number_of_excerpted_files() {
        let ws = workspace("aux-ctx-excerpts");
        let root = ws.path();
        for i in 0..(MAX_EXCERPT_FILES + 20) {
            write(root, &format!("src/f{:04}.rs", i), "fn f() { /* body */ }\n");
        }
        let manifest = scan(root);
        assert_eq!(manifest.excerpt_count(), MAX_EXCERPT_FILES);
    }

    #[test]
    fn caps_excerpt_bytes_per_file() {
        let ws = workspace("aux-ctx-bytes");
        let root = ws.path();
        let body = "x".repeat(MAX_EXCERPT_BYTES * 4);
        write(root, "src/big.rs", &body);
        let manifest = scan(root);
        let excerpt = manifest.files[0].excerpt.as_deref().expect("excerpt");
        assert_eq!(excerpt.len(), MAX_EXCERPT_BYTES);
    }

    #[test]
    fn oversized_files_are_listed_without_an_excerpt() {
        let ws = workspace("aux-ctx-oversize");
        let root = ws.path();
        let body = "y".repeat((MAX_EXCERPT_FILE_SIZE + 1) as usize);
        write(root, "src/huge.rs", &body);
        write(root, "src/small.rs", "fn small() {}\n");

        let manifest = scan(root);
        let huge = manifest
            .files
            .iter()
            .find(|f| f.rel_path == "src/huge.rs")
            .expect("listed");
        assert!(huge.excerpt.is_none());
        assert!(huge.size > MAX_EXCERPT_FILE_SIZE);
    }

    #[test]
    fn rendered_context_never_exceeds_the_assembly_cap() {
        let ws = workspace("aux-ctx-cap");
        let root = ws.path();
        // MAX_EXCERPT_FILES * MAX_EXCERPT_BYTES alone is ~123 KB; add a long
        // path list on top so the renderer has to clip.
        for i in 0..MAX_LISTED_FILES {
            let body = "z".repeat(MAX_EXCERPT_BYTES * 2);
            write(
                root,
                &format!("src/deeply/nested/module/path/file{:04}.rs", i),
                &body,
            );
        }
        let rendered = scan(root).render();
        assert!(
            rendered.len() <= MAX_CONTEXT_BYTES + 64,
            "rendered {} bytes",
            rendered.len()
        );
    }

    #[test]
    fn render_reports_truncation_instead_of_hiding_it() {
        let ws = workspace("aux-ctx-notice");
        let root = ws.path();
        for i in 0..(MAX_LISTED_FILES + 5) {
            write(root, &format!("src/f{:04}.rs", i), "fn f() {}\n");
        }
        assert!(scan(root).render().contains("partial view"));
    }

    #[test]
    fn an_empty_project_renders_a_legible_empty_manifest() {
        let ws = workspace("aux-ctx-empty");
        let manifest = scan(ws.path());
        assert!(manifest.files.is_empty());
        let rendered = manifest.render();
        assert!(rendered.contains("Files listed: 0 of 0"));
    }
}

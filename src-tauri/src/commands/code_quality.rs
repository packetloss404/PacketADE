use super::shared::SKIP_DIRS;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::State;
use tracing::{info, warn};

#[derive(Clone, Serialize)]
pub struct LanguageStats {
    pub name: String,
    pub extension: String,
    pub files: u32,
    pub code_lines: u32,
    pub comment_lines: u32,
    pub blank_lines: u32,
    pub total_lines: u32,
}

#[derive(Clone, Serialize)]
pub struct FileComplexity {
    pub path: String,
    pub language: String,
    pub lines: u32,
    pub complexity: u32,
}

#[derive(Clone, Serialize)]
pub struct CodeQualityReport {
    pub total_files: u32,
    pub total_code_lines: u32,
    pub total_lines: u32,
    pub total_comment_lines: u32,
    pub total_blank_lines: u32,
    pub language_count: u32,
    pub languages: Vec<LanguageStats>,
    pub avg_complexity: f64,
    pub test_files: u32,
    pub test_lines: u32,
    pub top_complex_files: Vec<FileComplexity>,
    pub comment_ratio: f64,
    pub test_ratio: f64,
    pub org_score: u32,
}

fn get_language(ext: &str) -> Option<&'static str> {
    match ext {
        "ts" | "tsx" => Some("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "rs" => Some("rust"),
        "py" => Some("python"),
        "go" => Some("go"),
        "java" => Some("java"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" => Some("cpp"),
        "cs" => Some("csharp"),
        "rb" => Some("ruby"),
        "php" => Some("php"),
        "swift" => Some("swift"),
        "kt" | "kts" => Some("kotlin"),
        "lua" => Some("lua"),
        "sh" | "bash" | "zsh" => Some("shell"),
        "ps1" => Some("powershell"),
        "sql" => Some("sql"),
        "html" | "htm" => Some("html"),
        "css" | "scss" | "sass" | "less" => Some("css"),
        "json" => Some("json"),
        "yaml" | "yml" => Some("yaml"),
        "toml" => Some("toml"),
        "xml" => Some("xml"),
        "md" | "mdx" => Some("markdown"),
        "vue" => Some("vue"),
        "svelte" => Some("svelte"),
        "dart" => Some("dart"),
        "r" | "R" => Some("r"),
        "ex" | "exs" => Some("elixir"),
        "zig" => Some("zig"),
        _ => None,
    }
}

fn is_comment_lang(lang: &str) -> bool {
    !matches!(lang, "json" | "yaml" | "toml" | "xml" | "markdown" | "html")
}

/// Count complexity keywords in a line for supported languages
fn line_complexity(line: &str, lang: &str) -> u32 {
    if matches!(
        lang,
        "json" | "yaml" | "toml" | "xml" | "markdown" | "html" | "css" | "sql"
    ) {
        return 0;
    }
    let trimmed = line.trim();
    let mut score: u32 = 0;
    // Simple keyword-based complexity: each branch/loop adds 1
    let keywords = [
        "if ", "if(", "else ", "else{", "for ", "for(", "while ", "while(", "switch ", "switch(",
        "match ", "match{", "case ", "catch ", "catch(", "? ", "&&", "||", "try ", "try{",
    ];
    for kw in &keywords {
        if trimmed.contains(kw) {
            score += 1;
        }
    }
    score
}

fn is_test_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    if normalized.starts_with("tests/")
        || normalized.starts_with("__tests__/")
        || normalized.contains("/tests/")
        || normalized.contains("/__tests__/")
    {
        return true;
    }

    let file_name = normalized.rsplit('/').next().unwrap_or("");
    file_name.contains(".test.") || file_name.contains(".spec.")
}

fn analyze_file(path: &Path, lang: &str) -> (u32, u32, u32, u32, u32) {
    // Returns: (code_lines, comment_lines, blank_lines, total_lines, complexity)
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (0, 0, 0, 0, 0),
    };

    let mut code = 0u32;
    let mut comments = 0u32;
    let mut blanks = 0u32;
    let mut total = 0u32;
    let mut complexity = 0u32;
    let mut in_block_comment = false;
    let can_comment = is_comment_lang(lang);

    for line in content.lines() {
        total += 1;
        let trimmed = line.trim();

        if trimmed.is_empty() {
            blanks += 1;
            continue;
        }

        if can_comment {
            // Block comments
            if in_block_comment {
                comments += 1;
                if trimmed.contains("*/") {
                    in_block_comment = false;
                }
                continue;
            }

            if trimmed.starts_with("/*") {
                comments += 1;
                if !trimmed.contains("*/") {
                    in_block_comment = true;
                }
                continue;
            }

            // Line comments
            if trimmed.starts_with("//")
                || (trimmed.starts_with('#')
                    && matches!(lang, "python" | "ruby" | "shell" | "r" | "yaml" | "toml"))
            {
                comments += 1;
                continue;
            }

            // Python/Rust doc comments
            if (trimmed.starts_with("///") || trimmed.starts_with("//!")) && matches!(lang, "rust")
            {
                comments += 1;
                continue;
            }
        }

        code += 1;
        complexity += line_complexity(line, lang);
    }

    (code, comments, blanks, total, complexity)
}

/// Calculate organization score based on directory structure heuristics
fn calc_org_score(files: &[(String, String)]) -> u32 {
    if files.is_empty() {
        return 50;
    }

    let mut score: f64 = 50.0;

    // Check for source directory organization
    let has_src = files.iter().any(|(p, _)| {
        p.contains("/src/")
            || p.contains("\\src\\")
            || p.starts_with("src/")
            || p.starts_with("src\\")
    });
    if has_src {
        score += 10.0;
    }

    // Check for config files at root
    let has_config = files.iter().any(|(p, _)| {
        let name = p.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
        matches!(
            name,
            "package.json" | "Cargo.toml" | "pyproject.toml" | "go.mod" | "tsconfig.json"
        )
    });
    if has_config {
        score += 5.0;
    }

    // Check for test organization
    let has_test_dir = files.iter().any(|(p, _)| {
        p.contains("/tests/")
            || p.contains("\\tests\\")
            || p.contains("/__tests__/")
            || p.contains("\\__tests__\\")
    });
    if has_test_dir {
        score += 10.0;
    }

    // Check for consistent naming (no mixed case styles in same dir)
    let has_readme = files.iter().any(|(p, _)| {
        let name = p
            .rsplit(|c| c == '/' || c == '\\')
            .next()
            .unwrap_or("")
            .to_lowercase();
        name == "readme.md" || name == "readme"
    });
    if has_readme {
        score += 5.0;
    }

    // Check average directory depth (shallow = better organized)
    let avg_depth: f64 = files
        .iter()
        .map(|(p, _)| p.matches('/').count() + p.matches('\\').count())
        .sum::<usize>() as f64
        / files.len() as f64;

    if avg_depth < 3.0 {
        score += 10.0;
    } else if avg_depth < 5.0 {
        score += 5.0;
    }

    // Check for types/interfaces directory
    let has_types = files
        .iter()
        .any(|(p, _)| p.contains("/types/") || p.contains("\\types\\"));
    if has_types {
        score += 5.0;
    }

    // Check for components directory
    let has_components = files
        .iter()
        .any(|(p, _)| p.contains("/components/") || p.contains("\\components\\"));
    if has_components {
        score += 5.0;
    }

    score.min(100.0) as u32
}

const MAX_DEPTH: usize = 20;
const MAX_FILES: usize = 10_000;

fn walk_dir(dir: &Path, base: &Path, files: &mut Vec<(String, String)>) {
    walk_dir_inner(dir, base, files, 0);
}

fn walk_dir_inner(dir: &Path, base: &Path, files: &mut Vec<(String, String)>, depth: usize) {
    if depth >= MAX_DEPTH || files.len() >= MAX_FILES {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if files.len() >= MAX_FILES {
            return;
        }

        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip symlinks to prevent traversal attacks
        if let Ok(metadata) = entry.metadata() {
            if metadata.file_type().is_symlink() {
                continue;
            }
        }

        if path.is_dir() {
            if SKIP_DIRS.contains(&file_name.as_str()) || file_name.starts_with('.') {
                continue;
            }
            walk_dir_inner(&path, base, files, depth + 1);
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if let Some(lang) = get_language(&ext_str) {
                    let rel_path = path
                        .strip_prefix(base)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();
                    files.push((rel_path, lang.to_string()));
                }
            }
        }
    }
}

#[tauri::command]
pub fn analyze_code_quality(project_path: String) -> Result<CodeQualityReport, String> {
    super::validate_project_path(&project_path)?;

    let base = Path::new(&project_path);

    // Collect all recognized files
    let mut files: Vec<(String, String)> = Vec::new();
    walk_dir(base, base, &mut files);

    // Per-language aggregation
    let mut lang_map: HashMap<String, LanguageStats> = HashMap::new();
    let mut all_complexities: Vec<FileComplexity> = Vec::new();
    let mut total_complexity: u64 = 0;
    let mut complexity_file_count: u32 = 0;
    let mut test_files: u32 = 0;
    let mut test_lines: u32 = 0;

    for (rel_path, lang) in &files {
        let full_path = base.join(rel_path);
        let (code, comments, blanks, total, complexity) = analyze_file(&full_path, lang);

        let ext = full_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();

        let entry = lang_map.entry(lang.clone()).or_insert(LanguageStats {
            name: lang.clone(),
            extension: ext.clone(),
            files: 0,
            code_lines: 0,
            comment_lines: 0,
            blank_lines: 0,
            total_lines: 0,
        });

        entry.files += 1;
        entry.code_lines += code;
        entry.comment_lines += comments;
        entry.blank_lines += blanks;
        entry.total_lines += total;

        if is_test_file(rel_path) {
            test_files += 1;
            test_lines += total;
        }

        if complexity > 0 || is_comment_lang(lang) {
            total_complexity += complexity as u64;
            complexity_file_count += 1;
            all_complexities.push(FileComplexity {
                path: rel_path.clone(),
                language: lang.clone(),
                lines: total,
                complexity,
            });
        }
    }

    // Sort complexities descending, take top 20
    all_complexities.sort_by(|a, b| b.complexity.cmp(&a.complexity));
    let top_complex: Vec<FileComplexity> = all_complexities.into_iter().take(20).collect();

    // Aggregate totals
    let mut languages: Vec<LanguageStats> = lang_map.into_values().collect();
    languages.sort_by(|a, b| b.total_lines.cmp(&a.total_lines));

    let total_files: u32 = languages.iter().map(|l| l.files).sum();
    let total_code: u32 = languages.iter().map(|l| l.code_lines).sum();
    let total_comments: u32 = languages.iter().map(|l| l.comment_lines).sum();
    let total_blanks: u32 = languages.iter().map(|l| l.blank_lines).sum();
    let total_lines: u32 = languages.iter().map(|l| l.total_lines).sum();
    let language_count = languages.len() as u32;

    let avg_complexity = if complexity_file_count > 0 {
        total_complexity as f64 / complexity_file_count as f64
    } else {
        0.0
    };

    let comment_ratio = if total_code + total_comments > 0 {
        total_comments as f64 / (total_code + total_comments) as f64
    } else {
        0.0
    };

    let test_ratio = if total_files > 0 {
        test_files as f64 / total_files as f64
    } else {
        0.0
    };

    let org_score = calc_org_score(&files);

    Ok(CodeQualityReport {
        total_files,
        total_code_lines: total_code,
        total_lines,
        total_comment_lines: total_comments,
        total_blank_lines: total_blanks,
        language_count,
        languages,
        avg_complexity,
        test_files,
        test_lines,
        top_complex_files: top_complex,
        comment_ratio,
        test_ratio,
        org_score,
    })
}

// =============================================================================
// v0.8.8 quality ai
// -----------------------------------------------------------------------------
// AI-powered actions for the Code Quality modal. Both commands route through
// the `claude-oauth` sidecar one-shot pattern established by
// `commands::github::github_ai_pr_review`: the caller pre-allocates a session
// id, subscribes to `api-agent:chunk:<sid>` / `api-agent:done:<sid>` /
// `api-agent:error:<sid>`, and we fire `SidecarManager::forward_start` with
// the prompt envelope from `core::code_quality_ai_prompts`. A background
// task awaits the oneshot waiter and calls `forward_close` so the sidecar
// supervisor doesn't keep the session in its owned-sessions set after the
// model finishes streaming.
//
// Coordinated with q1 (runner) + q3 (autofix) by living at the end of this
// file behind a single, clearly-marked section header so unrelated diffs
// don't fight each other.
// =============================================================================

/// Maximum file-context bytes we ship to the model for `explain_error`.
/// 16 KiB comfortably covers ±30 lines for typical source files while
/// staying well under a single API turn budget. Truncation appends a
/// marker the prompt envelope picks up automatically.
const EXPLAIN_FILE_CONTEXT_CAP_BYTES: usize = 16 * 1024;

/// Lines of source context to read above / below the error location. The
/// spec asks for "±30 lines"; we honor that and lean on the byte cap to
/// catch pathological cases (e.g. minified bundles).
const EXPLAIN_CONTEXT_LINES: u32 = 30;

/// Maximum bytes per individual check output handed to the summarizer.
/// Each check is independently capped so one extremely noisy check (e.g.
/// a stack-trace-heavy test runner) can't crowd out the others.
const SUMMARIZE_PER_CHECK_CAP_BYTES: usize = 32 * 1024;

/// Total bytes across all check outputs. If the per-check caps already
/// trim things below this, no extra work happens.
const SUMMARIZE_TOTAL_CAP_BYTES: usize = 96 * 1024;

/// Sidecar timeout for the AI quality features. Matches `AI_PR_TIMEOUT` in
/// `commands::github` — these are conversational one-shots, not long
/// agentic loops.
const AI_QUALITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
const AI_QUALITY_MODEL: &str = "claude-sonnet-4-6";
const AI_QUALITY_PROVIDER: &str = "claude-oauth";

/// Cut `text` to at most `cap` bytes ending on a UTF-8 boundary. Returns
/// `(text, was_truncated, original_byte_len)`. Mirrors the helper in
/// `commands::github` — duplicated rather than re-exported so the two
/// AI feature surfaces stay decoupled.
fn truncate_for_model_ai(text: &str, cap: usize) -> (String, bool, usize) {
    let original_len = text.len();
    if original_len <= cap {
        return (text.to_string(), false, original_len);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut s = text[..end].to_string();
    s.push_str(&format!(
        "\n\n... (truncated, original size {} bytes)\n",
        original_len
    ));
    (s, true, original_len)
}

/// Best-effort language hint from a file extension. Reused by the
/// explain-error prompt so the model can lean on the right idioms (e.g.
/// `unwrap` vs `?.`).
fn language_hint_for_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "lua" => "lua",
        "sh" | "bash" | "zsh" => "shell",
        "ps1" => "powershell",
        "sql" => "sql",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" | "less" => "css",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" | "mdx" => "markdown",
        _ => "unknown",
    }
}

/// Read `file_path` from disk and return the window of ±`context_lines`
/// around `line_1based`. Returns `(window_text, truncated, original_bytes)`
/// where `window_text` is empty when the file can't be read, the line is
/// out of range, or the requested window resolves to nothing. The byte
/// cap is applied AFTER the line window is sliced so we always include
/// the requested neighborhood even on huge files.
///
/// The `line_1based == 0` sentinel means "no line info" — we then return
/// the first `context_lines * 2 + 1` lines of the file so the model still
/// has *something* concrete to anchor on.
fn read_file_context(
    file_path: &str,
    line_1based: u32,
    context_lines: u32,
) -> (String, bool, usize) {
    let raw = match std::fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(_) => return (String::new(), false, 0),
    };
    if raw.is_empty() {
        return (String::new(), false, 0);
    }

    let total_lines: u32 = raw.lines().count() as u32;
    if total_lines == 0 {
        return (String::new(), false, 0);
    }

    let (start, end) = if line_1based == 0 {
        // No line info — pick a generous head window.
        (1u32, (context_lines * 2 + 1).min(total_lines))
    } else {
        let s = line_1based.saturating_sub(context_lines).max(1);
        let e = (line_1based + context_lines).min(total_lines);
        (s, e)
    };

    if start > total_lines {
        return (String::new(), false, raw.len());
    }

    // Render with line numbers so the model can correlate against the
    // diagnostic's `line` field. Format: "  42 | const x = foo;".
    let mut out = String::new();
    let width = end.to_string().len();
    for (idx, line) in raw.lines().enumerate() {
        let line_no = (idx as u32) + 1;
        if line_no < start {
            continue;
        }
        if line_no > end {
            break;
        }
        // Mark the focused line with `>` when we have one — purely visual,
        // helps the model home in on the location.
        let marker = if line_1based != 0 && line_no == line_1based {
            ">"
        } else {
            " "
        };
        out.push_str(&format!(
            "{} {:>width$} | {}\n",
            marker,
            line_no,
            line,
            width = width
        ));
    }

    let (capped, truncated, _) = truncate_for_model_ai(&out, EXPLAIN_FILE_CONTEXT_CAP_BYTES);
    (capped, truncated, out.len())
}

/// Background task that mirrors `commands::github::spawn_oneshot_cleanup`.
fn spawn_quality_ai_cleanup(
    manager: std::sync::Arc<crate::commands::agent_sidecar::SidecarManager>,
    session_id: String,
    receiver: tokio::sync::oneshot::Receiver<Result<String, String>>,
    feature: &'static str,
) {
    tokio::spawn(async move {
        match tokio::time::timeout(AI_QUALITY_TIMEOUT, receiver).await {
            Ok(Ok(Ok(_))) => {}
            Ok(Ok(Err(msg))) => {
                warn!(feature, session_id = %session_id, error = %msg, "code quality AI: sidecar reported error");
            }
            Ok(Err(_)) => {
                warn!(feature, session_id = %session_id, "code quality AI: waiter dropped before completion");
            }
            Err(_) => {
                warn!(feature, session_id = %session_id, timeout_secs = AI_QUALITY_TIMEOUT.as_secs(), "code quality AI: timed out waiting for sidecar done");
            }
        }
        if let Err(e) = manager.forward_close(session_id.clone()).await {
            warn!(feature, session_id = %session_id, error = %e, "code quality AI: forward_close failed (non-fatal)");
        }
    });
}

/// Validate the user-supplied file path before reading it. We allow ANY
/// absolute path the user can see in the diagnostic — the modal already
/// runs against the active workspace's `projectPath`, so paths originate
/// from trusted local tooling. We still reject empty strings and trailing
/// NULs to avoid the obvious silly cases.
fn validate_diagnostic_file_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("file_path cannot be empty".to_string());
    }
    if path.contains('\0') {
        return Err("file_path contains NUL".to_string());
    }
    Ok(())
}

/// `code_quality_ai_explain` — kick off a one-shot `claude-oauth` sidecar
/// session that explains a single diagnostic in plain language. The
/// frontend pre-allocates a session id (via `crypto.randomUUID()`-style)
/// and subscribes to `api-agent:chunk|done|error:<sid>` BEFORE invoking
/// this command. Returns the session id (echoed back from the override
/// so the caller can re-confirm).
///
/// `error_id` is opaque to the backend — it's a UI handle the frontend
/// uses to correlate the streaming reply back to a specific row in the
/// failed-checks panel. We log it for observability and discard.
///
/// `file_path` should be absolute (the parser in q2 emits absolute
/// paths). If reading the file fails or `line` is out of range the
/// prompt envelope flags the context as empty — the model is instructed
/// to say "not enough context" rather than fabricate.
#[tauri::command]
pub async fn code_quality_ai_explain(
    sidecar: State<'_, std::sync::Arc<crate::commands::agent_sidecar::SidecarManager>>,
    error_id: String,
    error_text: String,
    file_path: String,
    line: u32,
    column: u32,
    session_id_override: Option<String>,
) -> Result<String, String> {
    validate_diagnostic_file_path(&file_path)?;
    if error_text.trim().is_empty() {
        return Err("error_text cannot be empty".to_string());
    }

    let (file_context, ctx_truncated, ctx_original_bytes) =
        read_file_context(&file_path, line, EXPLAIN_CONTEXT_LINES);
    let language = language_hint_for_path(&file_path);

    let user_turn = crate::core::code_quality_ai_prompts::explain_error_user_turn(
        &error_text,
        &file_path,
        line,
        column,
        language,
        &file_context,
        ctx_truncated,
        ctx_original_bytes,
    );

    let manager = std::sync::Arc::clone(&*sidecar);
    let session_id = session_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("quality-ai-explain-{}", uuid::Uuid::new_v4()));
    let receiver = manager.wait_for_oneshot(&session_id).await;

    let start = manager
        .forward_start(
            session_id.clone(),
            AI_QUALITY_PROVIDER.to_string(),
            AI_QUALITY_MODEL.to_string(),
            crate::core::code_quality_ai_prompts::EXPLAIN_ERROR_SYSTEM_PROMPT.to_string(),
            Vec::new(),
            serde_json::Value::Null,
            String::new(),
            user_turn,
            None,
            None,
            Some(false),
            Some(false),
            serde_json::Value::Null,
            serde_json::Value::Null,
            None,
            None,
            None,
            None,
        )
        .await;

    if let Err(e) = start {
        drop(receiver);
        return Err(format!(
            "Failed to start code-quality AI explain session: {}",
            e
        ));
    }

    spawn_quality_ai_cleanup(
        manager,
        session_id.clone(),
        receiver,
        "code_quality_ai_explain",
    );

    info!(
        error_id = %error_id,
        file_path = %file_path,
        line = line,
        column = column,
        language = language,
        context_truncated = ctx_truncated,
        session_id = %session_id,
        "code quality AI explain session started"
    );

    Ok(session_id)
}

/// `code_quality_ai_summarize` — kick off a one-shot `claude-oauth`
/// sidecar session that produces a structured Markdown summary of every
/// failing check in a run. Same session-id + streaming contract as
/// [`code_quality_ai_explain`].
///
/// `run_id` is opaque to the backend (the frontend uses it to cache the
/// final markdown locally so re-opening the modal doesn't re-stream the
/// same summary). `project_name` is a label for the prompt header; we
/// don't open the project on disk.
///
/// `check_outputs` is a string→string map (`{"lint": "…", "build": "…"}`).
/// Each value is independently capped at `SUMMARIZE_PER_CHECK_CAP_BYTES`;
/// after that the whole envelope is capped at
/// `SUMMARIZE_TOTAL_CAP_BYTES` (caller-friendly: oversized payloads still
/// get a useful summary, just with explicit truncation markers).
///
/// `check_exit_codes` is parallel to `check_outputs` (keyed by the same
/// names). Missing entries default to `1` (treated as "failing" by the
/// prompt header).
#[tauri::command]
pub async fn code_quality_ai_summarize(
    sidecar: State<'_, std::sync::Arc<crate::commands::agent_sidecar::SidecarManager>>,
    run_id: String,
    project_name: String,
    check_outputs: HashMap<String, String>,
    check_exit_codes: Option<HashMap<String, i32>>,
    session_id_override: Option<String>,
) -> Result<String, String> {
    if check_outputs.is_empty() {
        return Err("check_outputs cannot be empty".to_string());
    }

    // Stable ordering: lint → typecheck → tests → build → anything else
    // alphabetically. Keeps the model's "Priority order" section
    // deterministic across re-runs and matches how the modal lists checks
    // in the failed-checks panel.
    fn check_sort_key(name: &str) -> (u8, String) {
        let lower = name.to_lowercase();
        let bucket = match lower.as_str() {
            "lint" => 0,
            "typecheck" | "tsc" | "type-check" => 1,
            "test" | "tests" => 2,
            "build" => 3,
            _ => 4,
        };
        (bucket, lower)
    }

    let mut entries: Vec<(String, String)> = check_outputs.into_iter().collect();
    entries.sort_by(|a, b| check_sort_key(&a.0).cmp(&check_sort_key(&b.0)));

    let exit_codes = check_exit_codes.unwrap_or_default();

    // Truncate per-check, then in a second pass enforce the total cap by
    // re-truncating the longest outputs in order until the envelope fits.
    let mut prepared: Vec<(String, i32, String, bool, usize)> = Vec::with_capacity(entries.len());
    let mut running_total: usize = 0;
    for (name, raw_output) in &entries {
        let (capped, truncated, original) =
            truncate_for_model_ai(raw_output, SUMMARIZE_PER_CHECK_CAP_BYTES);
        running_total += capped.len();
        let exit = exit_codes.get(name).copied().unwrap_or(1);
        prepared.push((name.clone(), exit, capped, truncated, original));
    }

    if running_total > SUMMARIZE_TOTAL_CAP_BYTES {
        // Second pass: re-truncate the longest outputs proportionally.
        // The pathological case (one giant log + several small ones) is
        // the common one, so attacking the largest first is sufficient.
        let mut over = running_total.saturating_sub(SUMMARIZE_TOTAL_CAP_BYTES);
        // indices sorted longest-first
        let mut idx: Vec<usize> = (0..prepared.len()).collect();
        idx.sort_by_key(|&i| std::cmp::Reverse(prepared[i].2.len()));
        for i in idx {
            if over == 0 {
                break;
            }
            let cur_len = prepared[i].2.len();
            // shrink this one by up to half its current size or `over`,
            // whichever is smaller. Min floor 2 KiB so we never starve a
            // check entirely.
            let target = cur_len.saturating_sub(over).max(2 * 1024).min(cur_len);
            if target < cur_len {
                let (recapped, _t, _o) = truncate_for_model_ai(&prepared[i].2, target);
                let shrunk = cur_len - recapped.len();
                prepared[i].2 = recapped;
                // Force-mark as truncated even if `truncate_for_model_ai`
                // didn't (e.g. byte-boundary nudge); we'd rather over-warn
                // the model than under-warn.
                prepared[i].3 = true;
                over = over.saturating_sub(shrunk);
            }
        }
    }

    let check_inputs: Vec<crate::core::code_quality_ai_prompts::CheckOutputInput<'_>> = prepared
        .iter()
        .map(|(name, exit, output, truncated, original)| {
            crate::core::code_quality_ai_prompts::CheckOutputInput {
                name: name.as_str(),
                exit_code: *exit,
                output: output.as_str(),
                truncated: *truncated,
                original_bytes: *original,
            }
        })
        .collect();

    let user_turn = crate::core::code_quality_ai_prompts::summarize_run_user_turn(
        &project_name,
        &check_inputs,
    );

    let manager = std::sync::Arc::clone(&*sidecar);
    let session_id = session_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("quality-ai-summary-{}", uuid::Uuid::new_v4()));
    let receiver = manager.wait_for_oneshot(&session_id).await;

    let start = manager
        .forward_start(
            session_id.clone(),
            AI_QUALITY_PROVIDER.to_string(),
            AI_QUALITY_MODEL.to_string(),
            crate::core::code_quality_ai_prompts::SUMMARIZE_RUN_SYSTEM_PROMPT.to_string(),
            Vec::new(),
            serde_json::Value::Null,
            String::new(),
            user_turn,
            None,
            None,
            Some(false),
            Some(false),
            serde_json::Value::Null,
            serde_json::Value::Null,
            None,
            None,
            None,
            None,
        )
        .await;

    if let Err(e) = start {
        drop(receiver);
        return Err(format!(
            "Failed to start code-quality AI summarize session: {}",
            e
        ));
    }

    spawn_quality_ai_cleanup(
        manager,
        session_id.clone(),
        receiver,
        "code_quality_ai_summarize",
    );

    info!(
        run_id = %run_id,
        project = %project_name,
        checks = entries.len(),
        session_id = %session_id,
        "code quality AI summarize session started"
    );

    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetade-{}-{}", prefix, unique));
        fs::create_dir_all(&dir).expect("failed to create temp test directory");
        dir
    }

    fn normalize(path: &str) -> String {
        path.replace('\\', "/")
    }

    #[test]
    fn is_test_file_matches_strict_test_patterns() {
        assert!(is_test_file("src/foo.test.ts"));
        assert!(is_test_file("src/foo.spec.tsx"));
        assert!(is_test_file("tests/integration.ts"));
        assert!(is_test_file("src\\__tests__\\suite.ts"));
    }

    #[test]
    fn is_test_file_rejects_substring_false_positives() {
        assert!(!is_test_file("src/specification.ts"));
        assert!(!is_test_file("src/latestest.ts"));
        assert!(!is_test_file("src/testimony.ts"));
    }

    #[test]
    fn line_complexity_ignores_non_code_languages() {
        assert_eq!(line_complexity(r#"{"if":true}"#, "json"), 0);
        assert_eq!(line_complexity("if (x) {}", "css"), 0);
    }

    #[test]
    fn analyze_file_counts_code_comments_and_complexity() {
        let dir = temp_test_dir("code-quality-analyze-file");
        let path = dir.join("sample.rs");
        fs::write(&path, "// comment\nlet x = 1;\nif x > 0 {\n}\n")
            .expect("failed to write fixture");

        let (code, comments, blanks, total, complexity) = analyze_file(&path, "rust");
        assert_eq!(code, 3);
        assert_eq!(comments, 1);
        assert_eq!(blanks, 0);
        assert_eq!(total, 4);
        assert_eq!(complexity, 1);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn walk_dir_skips_known_directories() {
        let dir = temp_test_dir("code-quality-walk-dir");
        fs::create_dir_all(dir.join("src")).expect("failed to create src dir");
        fs::create_dir_all(dir.join("node_modules/pkg"))
            .expect("failed to create node_modules dir");

        fs::write(dir.join("src/app.ts"), "export const x = 1;\n").expect("failed to write app.ts");
        fs::write(
            dir.join("node_modules/pkg/index.ts"),
            "export const y = 2;\n",
        )
        .expect("failed to write node_modules fixture");

        let mut files = Vec::new();
        walk_dir(&dir, &dir, &mut files);
        let normalized: Vec<String> = files.iter().map(|(p, _)| normalize(p)).collect();

        assert!(normalized.iter().any(|p| p.ends_with("src/app.ts")));
        assert!(!normalized.iter().any(|p| p.contains("node_modules")));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn analyze_code_quality_counts_only_strict_test_files() {
        let dir = temp_test_dir("code-quality-report-tests");
        fs::create_dir_all(dir.join("src")).expect("failed to create src dir");
        fs::create_dir_all(dir.join("tests")).expect("failed to create tests dir");

        fs::write(dir.join("src/main.ts"), "export const main = true;\n")
            .expect("failed to write main.ts");
        fs::write(
            dir.join("src/specification.ts"),
            "export const spec = true;\n",
        )
        .expect("failed to write specification.ts");
        fs::write(dir.join("src/app.test.ts"), "describe('x', () => {});\n")
            .expect("failed to write app.test.ts");
        fs::write(
            dir.join("tests/integration.ts"),
            "describe('i', () => {});\n",
        )
        .expect("failed to write tests/integration.ts");

        let report = analyze_code_quality(dir.to_string_lossy().to_string())
            .expect("analysis should succeed");

        // 4 recognized TypeScript files; only *.test.* and /tests/ should count as test files.
        assert_eq!(report.total_files, 4);
        assert_eq!(report.test_files, 2);

        let _ = fs::remove_dir_all(dir);
    }

    // ===== v0.8.8 quality ai helpers =====

    #[test]
    fn truncate_for_model_ai_no_op_when_under_cap() {
        let (out, truncated, original) = truncate_for_model_ai("hello", 100);
        assert_eq!(out, "hello");
        assert!(!truncated);
        assert_eq!(original, 5);
    }

    #[test]
    fn truncate_for_model_ai_emits_marker() {
        let (out, truncated, original) = truncate_for_model_ai(&"x".repeat(200), 50);
        assert!(truncated);
        assert_eq!(original, 200);
        assert!(out.contains("(truncated, original size 200 bytes)"));
    }

    #[test]
    fn truncate_for_model_ai_respects_utf8_boundary() {
        // 3-byte UTF-8 sequence — cap at 4 should land on the boundary.
        let s = "abc\u{1F600}def"; // a b c 😀 d e f
        let (out, truncated, _) = truncate_for_model_ai(s, 4);
        assert!(truncated);
        // No invalid UTF-8 (would panic otherwise).
        assert!(!out.is_empty());
    }

    #[test]
    fn language_hint_for_path_maps_common_extensions() {
        assert_eq!(language_hint_for_path("src/foo.ts"), "typescript");
        assert_eq!(language_hint_for_path("lib.rs"), "rust");
        assert_eq!(language_hint_for_path("script.py"), "python");
        assert_eq!(language_hint_for_path("README.md"), "markdown");
        assert_eq!(language_hint_for_path("no-extension"), "unknown");
    }

    #[test]
    fn read_file_context_returns_window_around_line() {
        let dir = temp_test_dir("quality-ai-context");
        let path = dir.join("sample.ts");
        let body: String = (1..=100).map(|i| format!("line {}\n", i)).collect();
        fs::write(&path, &body).expect("failed to write fixture");

        let (window, _, _) = read_file_context(&path.to_string_lossy(), 50, 5);
        assert!(window.contains("> 50 | line 50"));
        assert!(window.contains("45 | line 45"));
        assert!(window.contains("55 | line 55"));
        assert!(!window.contains("line 44"));
        assert!(!window.contains("line 56"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_file_context_handles_missing_file_gracefully() {
        let (window, truncated, original) =
            read_file_context("/__does_not_exist__/x.ts", 10, 30);
        assert_eq!(window, "");
        assert!(!truncated);
        assert_eq!(original, 0);
    }

    #[test]
    fn read_file_context_handles_no_line_info() {
        let dir = temp_test_dir("quality-ai-context-no-line");
        let path = dir.join("head.ts");
        let body: String = (1..=200).map(|i| format!("line {}\n", i)).collect();
        fs::write(&path, &body).expect("failed to write fixture");

        let (window, _, _) = read_file_context(&path.to_string_lossy(), 0, 30);
        // With no line info, falls back to head window of 2*30+1 = 61 lines.
        assert!(window.contains("1 | line 1"));
        assert!(window.contains("61 | line 61"));
        assert!(!window.contains("line 62"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_diagnostic_file_path_rejects_empty_and_nul() {
        assert!(validate_diagnostic_file_path("").is_err());
        assert!(validate_diagnostic_file_path("   ").is_err());
        assert!(validate_diagnostic_file_path("src/foo\0.ts").is_err());
        assert!(validate_diagnostic_file_path("src/foo.ts").is_ok());
        assert!(validate_diagnostic_file_path("/abs/path/file.rs").is_ok());
    }
}

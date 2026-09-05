#!/usr/bin/env python3
"""Build the PacketBench QA workbook (PDF + workbook.md).

Usage:  pip install reportlab && python build_qa_workbook.py

Self-contained: the only third-party import is reportlab. The Tauri command
inventory is scanned from `src-tauri/src` at run time so the surface table
cannot drift from the code; everything else is literal text from the
2026-09-04 audit (docs/audit-2026-09-04.md). US Letter, 0.85in margins,
Helvetica, checkbox + P/F columns on every checklist row, page numbers,
running header. No unicode glyphs: empty table cells serve as checkboxes.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = "packetloss404/PacketBench"
AUDIT_COMMIT = "2f4a10c384508af75a792604fff91b55a16dee26"
TODAY = date.today().isoformat()
RUN_LOCALLY = "pnpm install && pnpm tauri dev"
PROD_URL = "none (desktop app; no hosted URL). Installed via the NSIS installer PacketBench_<version>_x64-setup.exe. The only HTTP endpoint is the loopback MCP server: http://127.0.0.1:<port>/health"


def current_sha() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception:  # noqa: BLE001
        return "unknown"


HEAD_SHA = current_sha()

# --------------------------------------------------------------------------
# Surface inventory: scanned from the Rust tree.
# --------------------------------------------------------------------------
MONITOR = {"get_monitor_window_route", "close_monitor_window", "focus_monitor_route_in_main", "load_persisted_state", "load_conversations"}

SPECIAL = {
    "create_pty_session": "Spawns allowlisted CLI/shell in a PTY with caller args+env",
    "write_pty": "Writes keystrokes to a PTY (64 KB cap)",
    "kill_pty": "Kills a PTY process tree", "kill_pty_and_wait": "Kills a PTY tree and waits",
    "ssh_exec": "Spawns local ssh with caller argv (P08 denylist); password via askpass/stdin",
    "ssh_fetch_fingerprint": "Spawns ssh-keyscan + ssh-keygen", "ssh_pin_host": "Appends to ~/.packetbench/ssh/known_hosts",
    "ssh_check_remote_path": "Spawns ssh to probe a remote path", "get_app_known_hosts_path": "None (read)",
    "set_ssh_password": "Keyring write ssh-<serverId>", "delete_ssh_password": "Keyring delete", "get_ssh_password_exists": "Keyring read",
    "set_api_key": "Keyring write api-key-<provider>", "delete_api_key": "Keyring delete", "get_api_key_exists": "Keyring read",
    "set_packet_agent_token": "Keyring write packet-agent-token", "delete_packet_agent_token": "Keyring delete", "get_packet_agent_token_exists": "Keyring read",
    "packet_agent_request": "HTTPS to PacketAgent endpoint with keyring bearer; POST/PUT mutate deployments",
    "start_packet_agent_stream": "Opens SSE stream to PacketAgent (bearer)", "stop_packet_agent_stream": "Stops SSE task",
    "write_file_contents": "Writes a file inside workspace", "read_file_contents": "Read inside workspace (2 MB cap)",
    "list_directory": "Read inside workspace", "list_subdirectories": "Read any absolute dir", "list_project_files": "Read", "read_file_for_diff": "Read (confined)", "get_cwd": "None", "path_is_dir": "Existence probe, any path",
    "save_persisted_state": "Rewrites state.v1.json (not issues/retros)",
    "load_webview_storage_mirror": "Read", "save_webview_storage_mirror": "Rewrites webview-storage-mirror.json (8 MB cap)",
    "write_mcp_server": "Upserts mcpServers in ~/.claude/settings.json or <project>/.mcp.json", "delete_mcp_server": "Removes an mcpServers entry", "read_mcp_servers": "Read both files",
    "diagnose_mcp_server": "Spawns the configured stdio MCP server",
    "start_api_agent_session": "Starts agent loop: keyring key, gated tools (P02 default ask), MCP, hooks; LLM spend",
    "send_api_agent_message": "Continues a turn (LLM spend)", "retry_last_turn": "Re-runs last turn (spend)", "respond_permission": "Resolves a risky-tool prompt", "respond_edit": "Applies/declines a pending edit", "set_permission_mode": "Changes gate posture", "set_approve_writes": "Toggles edit gate", "set_plan_mode": "Toggles plan mode", "cancel_pending_tools": "Denies pending prompts", "cancel_api_agent_session": "Cancels a turn", "close_api_agent_session": "Ends a session", "change_model": "Changes model",
    "mcp_server_start": "Binds 127.0.0.1:<port>, mints bearer, serves MCP", "mcp_server_stop": "Stops MCP server", "mcp_server_status": "Read (returns token)", "mcp_server_recent_activity": "Read", "mcp_server_available_tools": "Read",
    "open_monitor_window": "Creates monitor-main window", "close_monitor_window": "Closes monitor window", "get_monitor_window_route": "Read", "focus_monitor_route_in_main": "Focuses main window",
    "seed_cli_account_config_dir": "Copies settings.json/config.toml between abs dirs (never credentials)",
    "sign_out_provider": "Deletes ~/.claude/.credentials.json or ~/.codex/auth.json", "get_provider_auth_status": "Reads CLI credential files", "get_provider_auth_status_for_dir": "Reads credential files in a dir",
    "github_set_token": "Probes GitHub then keyring write github-token", "github_clear_token": "Keyring delete", "github_has_token": "Read",
    "git_host_add_connection": "Writes git-hosts.json + keyring token (P05 https unless local)", "git_host_remove_connection": "Deletes connection + token", "git_host_set_token": "Keyring rewrite", "git_host_update_connection": "Rename/rotate after live probe", "git_host_list_connections": "Read", "git_host_has_token": "Read", "git_host_set_active": "Switches active host", "git_host_probe_credential": "HTTPS to pasted instance URL with pasted token (P05)",
    "github_device_flow_start": "github.com device endpoint (needs PACKETBENCH_GITHUB_CLIENT_ID)", "github_device_flow_poll": "Polls github.com; parks token", "github_device_flow_commit": "Keyring write", "github_device_flow_discard": "Drops parked token", "github_device_flow_probe_pending": "Probes parked token", "github_oauth_configured": "Read",
    "download_whisper_model": "Downloads pinned-SHA256 model from huggingface.co", "delete_whisper_model": "Deletes a model file", "list_whisper_models": "Read",
    "deliver_dictation_text": "Sets clipboard; optional Ctrl+V into foreground app", "start_recording": "Opens microphone", "stop_recording": "Stops capture, runs whisper", "cancel_recording": "Stops capture", "test_audio_device": "Opens a device", "list_audio_devices": "Read",
    "clear_dictation_history": "Deletes SQLite rows", "delete_dictation_entry": "Deletes one row", "set_dictation_settings": "Writes dictation config",
    "run_quality_checks": "Spawns detected lint/typecheck/test/cargo", "code_quality_run_fix": "Spawns eslint --fix / prettier / cargo fix / pnpm audit --fix", "analyze_code_quality": "Reads project; may call aux LLM",
    "code_quality_ai_explain": "Aux LLM (spend)", "code_quality_ai_summarize": "Aux LLM (spend)", "ask_agent_chat_stream": "Aux LLM stream (spend)", "ask_side_chat_stream": "Aux LLM stream (spend)", "summarize_session": "Aux LLM (spend)", "extract_patterns": "Aux LLM (spend)", "summarize_flight": "Aux LLM (spend)", "scan_codebase_memory": "Reads project + aux LLM (spend)", "parse_spec_to_flight": "Aux LLM (spend)", "parse_spec_to_tickets": "Aux LLM (spend)", "issues_extract_from_spec": "Aux LLM (spend)", "github_ai_pr_description": "GitHub read + aux LLM (spend)", "github_ai_pr_review": "GitHub read + aux LLM (spend)", "github_ai_catch_up": "GitHub read + aux LLM (spend)", "github_ai_triage": "GitHub read + aux LLM (spend)", "github_investigate_issue": "GitHub read + aux LLM (spend)",
    "launch_flight_async": "Creates worktrees (local/SSH), starts agent sessions (spend)", "cancel_flight_attempt": "Cancels an attempt", "cleanup_attempt_worktree_ssh": "Removes remote worktree over SSH", "cleanup_flight_integration_worktree": "Removes local integration worktree", "mark_attempt_status": "Rewrites attempt status", "set_attempt_draft_pr": "Records PR URL", "set_attempt_review_gate": "Records review verdict", "set_flight_publish_attempts_as_prs": "Flight flag",
    "clone_repo_remote": "git clone over SSH (URL/branch validated)", "create_conversation_worktree": "git worktree add", "remove_conversation_worktree": "git worktree remove", "create_issue_worktree": "git worktree add", "merge_conversation_branch": "git squash-merge into HEAD", "prepare_flight_integration_branch": "Creates integration branch", "integrate_flight_attempt": "Merges attempt into integration", "land_flight_integration": "Merges integration into root",
    "git_commit": "git commit (staged only)", "git_push": "git push", "git_pull": "git pull", "git_create_branch": "git branch (name validated)", "git_stage_files": "git add --", "git_unstage_files": "git restore --staged --", "git_push_branch": "git push -u origin <branch> [--force-with-lease]",
    "git_commit_remote": "git commit over SSH", "git_push_remote": "git push over SSH", "git_pull_remote": "git pull over SSH", "git_create_branch_remote": "git branch over SSH", "git_stage_files_remote": "git add over SSH", "git_unstage_files_remote": "git restore over SSH", "git_diff_file_remote": "git diff over SSH (read)",
    "probe_packetcode_integration": "Spawns packetcode --version / doctor --json", "inspect_packetcode_installation": "Spawns packetcode --version", "probe_terminal_shell": "Spawns <shell> --version", "list_wsl_distributions": "Spawns wsl.exe --list", "detect_agent": "Spawns <cli> --version", "detect_cli_catalog": "Spawns each CLI --version", "inspect_cli_launch": "Resolves launch path", "cli_launch_diagnostics": "Resolves launch path",
    "create_project_memory": "Writes a note in the project memory dir", "update_project_memory": "Rewrites a note (revision check)", "archive_project_memory": "Archives a note", "watch_project_memory": "Starts fs watcher", "list_project_memory": "Read",
    "set_aux_routing_overrides": "Updates in-memory routing map", "toggle_pinned_pattern": "Flips a memory pattern flag",
    "set_ollama_base_url": "Writes provider-settings.v1.json (http allowed; no secret)", "set_minimax_base_url": "Writes provider-settings.v1.json (P05 https unless local)", "set_custom_compat_base_url": "Writes provider-settings.v1.json (P05)", "set_custom_compat_models": "Writes model list", "set_ollama_runtime_options": "Writes num_ctx/keep_alive",
    "list_ollama_models": "GET Ollama base URL (no secret)", "list_provider_models": "GET provider catalogs with keyring key",
    "export_conversation_markdown": "None (pure render)", "save_conversation": "Writes conversations/<id>.json (id validated)", "delete_conversation_file": "Deletes a conversation file",
    "delete_crash": "Deletes a crash log (confined)", "read_crash": "Read (confined)",
    "github_mark_notification_read": "PATCH notification thread", "git_get_origin_url": "Read", "git_safety_check": "Read", "resize_pty": "Resizes a PTY", "resolve_agents_md": "Reads AGENTS.md chain", "search_dictation_history": "SQLite read", "code_quality_probe_fixers": "Probes project (read)",
}


def registered_commands() -> set[str]:
    """Names inside `guarded_invoke_handler![...]` in lib.rs: the real IPC surface."""
    with open(os.path.join(ROOT, "src-tauri", "src", "lib.rs"), encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("guarded_invoke_handler![")
    end = text.index("])", start)
    return set(re.findall(r"::([a-z_0-9]+)\s*,?\s*$", text[start:end], flags=re.M))


def scan_commands():
    registered = registered_commands()
    rows = []
    src = os.path.join(ROOT, "src-tauri", "src")
    for dirpath, _dirs, files in os.walk(src):
        for fn in files:
            if not fn.endswith(".rs"):
                continue
            path = os.path.join(dirpath, fn)
            with open(path, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
            for i, line in enumerate(lines):
                if "#[tauri::command]" in line:
                    for j in range(i + 1, min(i + 5, len(lines))):
                        m = re.search(r"pub (?:async )?fn ([a-z_0-9]+)", lines[j])
                        if m:
                            if m.group(1) in registered:
                                rel = os.path.relpath(path, ROOT).replace("\\", "/")
                                rows.append((m.group(1), f"{rel}:{j + 1}"))
                            break
    rows.sort()
    return rows


def mutates(name: str, loc: str) -> str:
    if name in SPECIAL:
        return SPECIAL[name]
    f = loc.split("/")[-1].split(":")[0]
    if f == "state.rs" and name.startswith("save_"):
        return "Rewrites one slice of state.v1.json"
    if f == "github.rs":
        if re.match(r"github_(list|get)_", name):
            return "GitHub/Gitea read with keyring token"
        return "Mutates remote repo via git-host API (" + name.replace("github_", "").replace("_", " ") + ")"
    if re.match(r"^(get|list|read|load|detect|inspect|probe|path_is|export)_?", name):
        return "None (read)"
    if name.startswith("cancel_"):
        return "Cancels a running task"
    return "Writes local state"


COMMANDS = scan_commands()

# --------------------------------------------------------------------------
# Styles
# --------------------------------------------------------------------------
BASE = ParagraphStyle("base", fontName="Helvetica", fontSize=8.5, leading=10.5, alignment=TA_LEFT)
SMALL = ParagraphStyle("small", parent=BASE, fontSize=6.6, leading=7.6)
TINY = ParagraphStyle("tiny", parent=BASE, fontSize=6.0, leading=6.9)
H1 = ParagraphStyle("h1", parent=BASE, fontName="Helvetica-Bold", fontSize=15, leading=18, spaceAfter=6)
H2 = ParagraphStyle("h2", parent=BASE, fontName="Helvetica-Bold", fontSize=11, leading=13, spaceBefore=8, spaceAfter=4)
MONO = ParagraphStyle("mono", parent=BASE, fontName="Courier", fontSize=7.2, leading=8.6)
MONO_SMALL = ParagraphStyle("monos", parent=BASE, fontName="Courier", fontSize=6.3, leading=7.2)

GRID = TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.4, colors.black),
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDDDDD")),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
    ("TOPPADDING", (0, 0), (-1, -1), 1.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.2),
])


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def P(s, style=BASE):
    return Paragraph(esc(s), style)


def M(s, style=MONO):
    return Paragraph(esc(s).replace("\n", "<br/>"), style)


def check_table(header, rows, widths, style=SMALL, extra_cols=("[ ]", "P/F")):
    """Rows get an empty checkbox cell and an empty P/F cell appended."""
    data = [[P(h, style) for h in header] + [P(c, style) for c in extra_cols]]
    for r in rows:
        data.append([P(str(c), style) if not hasattr(c, "wrap") else c for c in r] + [P("", style), P("", style)])
    t = Table(data, colWidths=widths + [0.28 * inch, 0.34 * inch], repeatRows=1)
    t.setStyle(GRID)
    return t


# --------------------------------------------------------------------------
# Content
# --------------------------------------------------------------------------
MD = []  # markdown lines mirrored from the PDF content


def md(line=""):
    MD.append(line)


def md_table(header, rows, extra=True):
    hdr = list(header) + (["[ ]", "P/F"] if extra else [])
    md("| " + " | ".join(hdr) + " |")
    md("|" + "---|" * len(hdr))
    for r in rows:
        cells = [str(c).replace("|", "\\|").replace("\n", " ") for c in r] + (["", ""] if extra else [])
        md("| " + " | ".join(cells) + " |")
    md()


story = []
W = letter[0] - 2 * 0.85 * inch  # usable width


def h1(t):
    story.append(Paragraph(esc(t), H1)); md(f"# {t}"); md()


def h2(t):
    story.append(Paragraph(esc(t), H2)); md(f"## {t}"); md()


def para(t, style=BASE):
    story.append(P(t, style)); story.append(Spacer(1, 3)); md(t); md()


def mono(t):
    story.append(M(t)); story.append(Spacer(1, 3)); md("```"); md(t); md("```"); md()


# a. Cover ------------------------------------------------------------------
h1("PacketBench QA Workbook")
cover_rows = [
    ("Repository", REPO),
    ("Commit reviewed by the audit", AUDIT_COMMIT),
    ("Commit this workbook was built from", HEAD_SHA),
    ("Date built", TODAY),
    ("Run it locally (exact command)", RUN_LOCALLY),
    ("Then run the gates", "pnpm gates:fast   (format, lint, typecheck, vitest)   and   cd src-tauri && cargo test --lib"),
    ("Smoke test", "node smoke-test.mjs   (live mode: set PACKETBENCH_MCP_URL and PACKETBENCH_MCP_TOKEN from Settings > MCP > MCP Provider)"),
    ("Exact URL in prod", PROD_URL),
    ("Log file", r"%LOCALAPPDATA%\PacketBench\logs\packetbench.log.<YYYY-MM-DD>"),
    ("Data dir", r"%USERPROFILE%\.packetbench"),
    ("Audit report", "docs/audit-2026-09-04.md (findings F01-F20, patches P01-P12, unresolved U01-U07)"),
]
t = Table([[P(a, BASE), P(b, BASE)] for a, b in cover_rows], colWidths=[1.9 * inch, W - 1.9 * inch])
t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.black), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#EEEEEE"))]))
story.append(t)
md("| Field | Value |"); md("|---|---|")
for a, b in cover_rows:
    md(f"| {a} | {b} |")
md()
para("How to use: every checklist row has an empty checkbox cell (tick when done) and a P/F cell (write P or F). Failure signatures are the literal strings the app or the log prints. Where a browser cannot make the request, the literal curl is given with <TOKEN> as the placeholder for the bearer shown in Settings > MCP > MCP Provider.")
para("Manual IPC calls: run `pnpm tauri dev`, press Ctrl+Shift+I in the app window, and in the devtools console call `await window.__TAURI_INTERNALS__.invoke('<command>', {<camelCase args>})`. Release builds do not expose devtools; that is expected.")
story.append(PageBreak())

# b + e. Surface inventory with the four negative cases -----------------------
h1("Surface inventory with negative cases")
para("Reprinted from audit deliverable 2 and scanned live from src-tauri/src. Four negative cases per IPC row: "
     "UNAUTH = call from outside the webview (there is no path: Tauri IPC is reachable only from the app's own webview; record N/A unless you find one). "
     "ROLE = call from the read-only Monitor window (open one via Flight Deck > attempt tile > 'Monitor' or the conversation header menu 'Send to Monitor', then devtools in that window): expected rejection string is exactly "
     "\"This read-only Monitor cannot invoke that application command.\" for every command except the five marked 'main, monitor'. "
     "ID = substitute a foreign/absent id (session id, flight id, conversation id): expected an error string naming the missing entity (e.g. \"PTY session <id> not found\", \"unknown flightId\", \"Conversation id cannot traverse paths\"). "
     "BODY = omit a required argument or send the wrong type: Tauri returns \"invalid args `<arg>` for command `<name>`\" before the handler runs.")
hdr = ["ID", "Command", "Roles", "Mutates / reaches", "Location", "UNAUTH", "ROLE", "ID", "BODY"]
rows = []
md_rows = []
for i, (name, loc) in enumerate(COMMANDS, 1):
    roles = "main, monitor" if name in MONITOR else "main only"
    rows.append([P(f"C{i:03d}", TINY), P(name, TINY), P(roles, TINY), P(mutates(name, loc), TINY), P(loc, TINY), P("", TINY), P("", TINY), P("", TINY), P("", TINY)])
    md_rows.append([f"C{i:03d}", f"`{name}`", roles, mutates(name, loc), f"`{loc}`", "", "", "", ""])
t = Table([[P(h, TINY) for h in hdr] + [P("[ ]", TINY), P("P/F", TINY)]] + [r + [P("", TINY), P("", TINY)] for r in rows],
          colWidths=[0.36 * inch, 1.42 * inch, 0.5 * inch, 1.85 * inch, 1.72 * inch, 0.36 * inch, 0.32 * inch, 0.28 * inch, 0.34 * inch, 0.26 * inch, 0.3 * inch], repeatRows=1)
t.setStyle(GRID)
story.append(t)
md_table(hdr, md_rows)

net_rows = [
    ("N001", "GET /health on 127.0.0.1:<port> (MCP server)", "any local process; Origin must be absent or loopback", "None", "src-tauri/src/mcp_server/transport.rs"),
    ("N002", "POST/GET/DELETE /mcp (MCP Streamable HTTP)", "bearer + loopback Origin + Host allowlist", "tools M008-M010, M013-M016 mutate (allow_writes only)", "src-tauri/src/mcp_server/transport.rs:69-100"),
    ("M001-M016", "MCP tools ping, get_active_flight, list_runnable_tasks, read_task_details, read_memory_context, search_project_memory, read_project_memory, create/update/archive_project_memory, list_workspaces, read_coordination_inbox, append_handoff, escalate, post_coordination_message, acknowledge_coordination_message", "bearer; writes need Allow writes", "see audit 2b", "src-tauri/src/mcp_server/mod.rs:582-836"),
    ("R001-R002", "MCP resources packetbench://project|flights|flights/{id}|flights/{id}/tasks|flights/{id}/inbox|issues|reviews|workspaces|memory/patterns|memory/project/{ws}|packetcode/health", "bearer; gated by the tool allowlist (P07)", "packetcode/health spawns a process", "src-tauri/src/mcp_server/mod.rs:923-1030"),
]
story.append(Spacer(1, 4))
story.append(check_table(["ID", "Route", "Auth", "Mutates", "Location"], net_rows, [0.55 * inch, 2.4 * inch, 1.35 * inch, 1.3 * inch, 1.2 * inch]))
md_table(["ID", "Route", "Auth", "Mutates", "Location"], net_rows)
story.append(PageBreak())

# c. Shot list --------------------------------------------------------------
h1("Shot list")
para("There are no URLs: PacketBench is a desktop window. Each shot names the in-app location, the state to be in, and the one question the shot answers. Dev builds are served from http://localhost:1420 inside the window (tauri.conf.json build.devUrl).")
shots = [
    ("S1", "Agents view, new API conversation in a repo NOT listed in trusted-projects.json; provider 'Claude (API)'; anthropic key present", "Does the mode chip read 'Manual' (not 'Default') on a fresh conversation? (P02)"),
    ("S2", "Same conversation; ask 'run `git status` with the bash tool'", "Does the Allow once / Always allow / Deny prompt appear before anything runs? (P02)"),
    ("S3", "Log viewer: Select-String packetbench::trust in today's log after S1", "Is 'project is not trusted: repo-supplied hooks, .mcp.json servers, and .claude/agents are ignored' present? (P01)"),
    ("S4", "Settings > MCP > MCP Provider card, Enable MCP Provider on, Allow writes off, all tools ticked", "Are port, bearer token, and served tool list visible? (baseline for S5)"),
    ("S5", "Same card with only get_active_flight ticked, server re-enabled; terminal running the curl from test T-MCP-07", "Does resources/read of packetbench://memory/patterns return the allowlist error? (P07)"),
    ("S6", "Settings > GitHub > Connect a git host wizard, Gitea, instance URL http://gitea.example.com, any token", "Is the error 'Instance URL must use https:// ...' shown before any request? (P05)"),
    ("S7", "Settings > Providers > API Keys card", "Are keys shown only as present/absent, never as values? (I8)"),
    ("S8", "Log viewer: Select-String packetbench::boot on app start", "Does 'boot check done' appear with issues=0, and is the trust-file line present? (P09)"),
]
story.append(check_table(["#", "Location + state", "Question the shot answers"], shots, [0.35 * inch, 3.3 * inch, 3.15 * inch]))
md_table(["#", "Location + state", "Question the shot answers"], shots)
story.append(PageBreak())

# d. Screenshot slots -------------------------------------------------------
h1("Screenshot slots")
md("(one framed empty slot per shot; captions below)")
md()
for sid, loc, q in shots:
    cap = f"{sid} - {loc}"
    frame = Table([[P("", BASE)]], colWidths=[W], rowHeights=[3.05 * inch])
    frame.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.8, colors.black)]))
    story.append(KeepTogether([P(cap, SMALL), P("Q: " + q, SMALL), frame, Spacer(1, 6)]))
    md(f"- {cap}  -  Q: {q}")
md()
story.append(PageBreak())

# e. Test sheets ------------------------------------------------------------
h1("Test sheets")
h2("MCP server (N001/N002) - every row is a literal curl; replace <port> and <TOKEN> from Settings > MCP > MCP Provider")
INIT = "-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"qa\",\"version\":\"0\"}}}'"
mcp_cases = [
    ("T-MCP-01", "Health", "curl -s -i http://127.0.0.1:<port>/health", "HTTP 200; body {\"ok\":true,\"app\":\"PacketBench\",\"version\":\"0.13.2\",\"service\":\"mcp\"}", "404 (P07 not applied) or connection refused (server not enabled)"),
    ("T-MCP-02", "No token", f"curl -s -o /dev/null -w '%{{http_code}}' -X POST http://127.0.0.1:<port>/mcp {INIT}", "401", "200 = bearer layer missing; log has no 'MCP request rejected: bearer token missing or wrong'"),
    ("T-MCP-03", "Wrong token", f"curl -s -o /dev/null -w '%{{http_code}}' -X POST http://127.0.0.1:<port>/mcp -H 'authorization: Bearer nope' {INIT}", "401; log line outcome=bad_token", "200"),
    ("T-MCP-04", "Non-loopback Origin (webhook analogue)", f"curl -s -o /dev/null -w '%{{http_code}}' -X POST http://127.0.0.1:<port>/mcp -H 'origin: https://evil.example.com' -H 'authorization: Bearer <TOKEN>' {INIT}", "403; log line outcome=forbidden_origin", "200"),
    ("T-MCP-05", "Origin guard on /health", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/health -H 'origin: https://evil.example.com'", "403", "200"),
    ("T-MCP-06", "Login", f"curl -s -i -X POST http://127.0.0.1:<port>/mcp -H 'authorization: Bearer <TOKEN>' {INIT}", "200; response header mcp-session-id present", "401"),
    ("T-MCP-07", "Resource denied by allowlist (server enabled with only get_active_flight ticked)", "after T-MCP-06 and notifications/initialized: curl -s -X POST http://127.0.0.1:<port>/mcp -H 'authorization: Bearer <TOKEN>' -H 'mcp-session-id: <SID>' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"resources/read\",\"params\":{\"uri\":\"packetbench://memory/patterns\"}}'", "JSON-RPC error 'resource is not permitted by this server's tool allowlist'", "a result with 'patterns'"),
    ("T-MCP-08", "Authenticated write (Allow writes ON, a Flight selected)", "same session: -d '{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"append_handoff\",\"arguments\":{\"flightId\":\"<flight id from get_active_flight>\",\"summary\":\"qa note\"}}}'", "'Posted to the flight timeline.'; Flight Deck timeline shows actor mcp", "'writes are disabled; enable them in PacketBench's MCP Provider settings' (means Allow writes is off = documented failure path)"),
    ("T-MCP-09", "Bad flight id", "same as T-MCP-08 with flightId 'nope'", "JSON-RPC error 'unknown flightId'", "success"),
    ("T-MCP-10", "Webhooks", "n/a - PacketBench has no inbound webhooks (audit section 3)", "record N/A", "-"),
]
story.append(check_table(["ID", "Case", "Command", "Expected", "Failure signature"], [(a, b, M(c, MONO_SMALL), d, e) for a, b, c, d, e in mcp_cases], [0.55 * inch, 0.9 * inch, 3.05 * inch, 1.2 * inch, 1.1 * inch]))
md_table(["ID", "Case", "Command", "Expected", "Failure signature"], [(a, b, f"`{c}`", d, e) for a, b, c, d, e in mcp_cases])

h2("Paid outbound calls (every LLM spend path)")
paid = [
    ("T-PAY-01", "Anthropic in-process (Claude (API) row)", "Settings > Providers > API Keys: anthropic key set. Start a conversation, send 'say hi'.", "log: packetbench::egress service=anthropic 'LLM request' then 'LLM response' status=200; usage.jsonl gains a row", "'No API key configured for anthropic. Set one in Settings > API Keys.' (key missing) or status=401"),
    ("T-PAY-02", "OpenAI-compatible (OpenAI / MiniMax / OpenRouter / Ollama / Custom rows)", "Same with the row's key. For Ollama no key.", "log: service=openai-compat base_url=<url> 'LLM response' status=200", "status=401/403 or 'Ollama not reachable at http://localhost:11434'"),
    ("T-PAY-03", "Sidecar rows (Claude Agent SDK (API), OpenAI Agents SDK (API))", "Start a conversation on each row.", "Sidecar status chip 'ready'; turn completes; usage row written", "'Sidecar crashed and could not restart' -> restart app"),
    ("T-PAY-04", "Cost guardrail hard stop", "Settings > Agents > Budget Guardrails: Daily cap $ = 0.01, Hard stop at % = 100. Start a new conversation after spend exceeds it.", "Launch refused with the guardrail dialog (assertCostGuardrailsAllowLaunch)", "conversation starts anyway"),
    ("T-PAY-05", "Aux LLM features are NOT guardrail-checked (known gap)", "With the cap from T-PAY-04 still exceeded, use Side chat or GitHub > AI PR description.", "Expected today: the call proceeds (documented gap, audit section 3 'Rate limiting')", "record actual; not a regression"),
    ("T-PAY-06", "Custom endpoint over public http refused", "Settings > Providers > Provider Endpoints: custom endpoint http://llm.example.com/v1", "'Custom endpoint URL must use https:// - plain http:// is only allowed for localhost, private-network, or .local/.lan/.internal hosts...'", "'Saved.'"),
    ("T-PAY-07", "PacketAgent", "Settings > PacketAgent: endpoint https://agent.example.test, token set; press the health probe in the card", "log: service=packetagent operation=health status=<code>", "'PacketAgent requires HTTPS; HTTP is allowed only for a loopback endpoint.' when http:// is entered"),
]
story.append(check_table(["ID", "Path", "Steps (real values)", "Expected", "Failure signature"], paid, [0.55 * inch, 1.15 * inch, 2.1 * inch, 1.65 * inch, 1.35 * inch]))
md_table(["ID", "Path", "Steps (real values)", "Expected", "Failure signature"], paid)

h2("Background jobs")
jobs = [
    ("T-JOB-01", "Sidecar restart cap", "taskkill /IM node.exe /F three times within 60 s while a sidecar conversation is open", "Chip cycles restarting (1/3..3/3) then 'Sidecar crashed and could not restart'", "no chip change; conversation hangs silently"),
    ("T-JOB-02", "PTY orphan reap", "Open a terminal pane running `claude`; taskkill /IM packetbench.exe /F; relaunch", "Log line from core::pty::reap_orphaned_pty_children; no stray claude.exe in Task Manager", "claude.exe survives"),
    ("T-JOB-03", "PacketAgent SSE reconnect", "Start a stream (Flight with a PacketAgent deployment); disconnect network 10 s", "packet-agent:stream-status 'reconnecting' then 'connected'; cursor preserved", "state 'error' with no retry"),
    ("T-JOB-04", "Auth credential watcher", "Run `claude login` in a terminal pane", "AuthBadge flips to ready without reopening the picker (provider-auth:changed)", "badge stale until restart"),
    ("T-JOB-05", "Flight recovery on startup", "Launch an attempt, force-kill the app, relaunch", "Attempt shows Failed; worktree swept (log 'sweep_interrupted_attempts')", "attempt stuck Running"),
]
story.append(check_table(["ID", "Job", "Steps", "Expected", "Failure signature"], jobs, [0.55 * inch, 1.0 * inch, 2.2 * inch, 1.85 * inch, 1.2 * inch]))
md_table(["ID", "Job", "Steps", "Expected", "Failure signature"], jobs)

h2("Secret loading (every keyring account and file)")
secrets = [
    ("T-SEC-01", "api-key-anthropic / openai / minimax / openrouter", "Delete the key in Settings > Providers > API Keys ('Delete API key?'), start a conversation", "'No API key configured for <provider>. Set one in Settings > API Keys.'; log outcome=missing", "turn starts"),
    ("T-SEC-02", "github-token", "Settings > GitHub > Remove git host, then open GitHub view", "'Sign in with GitHub, or add a token with repo scope' prompt; cmdkey /list no longer lists github-token.packetbench", "token still listed"),
    ("T-SEC-03", "git-host-token-<id>", "Add a Gitea host (https), then Remove", "cmdkey /list shows git-host-token-<id>.packetbench before, not after", "entry remains"),
    ("T-SEC-04", "ssh-<serverId>", "Settings > Servers > Add password-auth server, Save; Delete remote host", "entry ssh-<serverId>.packetbench appears then disappears", "entry remains"),
    ("T-SEC-05", "packet-agent-token", "Settings > PacketAgent: save token; 'Remove stored token'", "'PacketAgent token removed from the credential store.'", "requests still authenticate"),
    ("T-SEC-06", "Boot keyring probe", "Start the app; Select-String packetbench::boot", "'OS credential store is reachable'", "'OS credential store failed a read ...'"),
    ("T-SEC-07", "Plaintext token file is inert", "Create %USERPROFILE%\\.packetbench\\github-token containing 'x'; ask an agent to use gh_list_issues with the GitHub connection removed", "'GitHub token not configured. Run `github_set_token` first.'", "the file's value is used (P06 not applied)"),
    ("T-SEC-08", "Trust file", "Delete %USERPROFILE%\\.packetbench\\trusted-projects.json; start a conversation in a repo with .claude/settings.json hooks", "hooks do not run; log 'project hooks ignored: project is not in the trusted-projects list'", "hook side effect observed"),
    ("T-SEC-09", "Trust file malformed", "Write '{ not json' to trusted-projects.json; repeat T-SEC-08", "'trusted-projects file is not valid JSON; treating every project as untrusted'", "hook runs"),
]
story.append(check_table(["ID", "Secret", "Steps", "Expected", "Failure signature"], secrets, [0.55 * inch, 1.1 * inch, 2.2 * inch, 1.95 * inch, 1.0 * inch]))
md_table(["ID", "Secret", "Steps", "Expected", "Failure signature"], secrets)
story.append(PageBreak())

# f. Patch verification -------------------------------------------------------
h1("Patch verification (one test per patch, keyed to docs/audit/patches)")
patches = [
    ("P01", "Untrusted repo: add .claude/settings.json with {\"hooks\":[{\"event\":\"SessionStart\",\"command\":\"echo HOOKRAN > %TEMP%\\\\hook.txt\"}]}; start a conversation; then add the repo to trusted-projects.json and start another", "First: no hook.txt, log 'project hooks ignored'. Second: hook.txt exists", "Adjacent: global ~/.claude/settings.json hooks still run in both cases", "cargo test --lib -- project_trust merge_mcp_entries_for_sidecar_drops"),
    ("P02", "New conversation, no posture chosen; send 'run `dir` via bash'", "Chip 'Manual'; Allow once / Always allow / Deny prompt appears", "Adjacent: choosing Default (auto) from the chip runs bash unprompted; Plan blocks bash entirely", "cargo test --lib -- permission_mode_defaults_to_asking; vitest agentModeChipUtils.test.ts"),
    ("P03", "Ask: 'use spawn_subagent to run `whoami` with bash'", "Sub-agent result contains 'Error: tool 'bash' is not available to this sub-agent.'; log 'sub-agent requested a tool outside its allowlist; refused'", "Adjacent: spawn_subagent can still read_file/grep", "cargo test --lib -- subagent_allowlist denied_tools_stay custom_agents_cannot"),
    ("P03b", "In Manual mode ask the agent to create a pull request", "Permission prompt for create_pull_request before any git push", "Adjacent: Deny refuses it; plan mode disables it", "cargo test --lib -- create_pull_request_is_a_risky_tool"),
    ("P04", "mklink /D <workspace>\\link C:\\Users\\<you>\\.ssh (needs Developer Mode or admin); ask the agent to grep for 'Host'", "No lines from the link; only workspace files", "Adjacent: grep still finds matches in real subdirectories", "cargo test --lib -- grep_does_not_follow_symlinks"),
    ("P05", "Settings > GitHub > Connect a git host > Gitea, http://gitea.example.com", "'Gitea base URL must use https:// ...'; also http://gitea.local and http://192.168.1.5:3000 are accepted", "Adjacent: Ollama base URL http://<lan-ip>:11434 still accepted (no secret)", "cargo test --lib -- tls_guard"),
    ("P06", "T-SEC-07", "as T-SEC-07", "Adjacent: keyring token still works for gh_list_issues", "grep -n 'github-token' src-tauri/src/core/tool_github.rs shows keyring reads only"),
    ("P07", "T-MCP-01, T-MCP-05, T-MCP-07", "as those rows", "Adjacent: with no allowlist every resource still reads; tools/call still works", "node smoke-test.mjs (fallback runs the transport tests)"),
    ("P08", "In devtools: await window.__TAURI_INTERNALS__.invoke('ssh_exec',{commandArgs:['-o','ProxyCommand=calc.exe','u@h'],password:null})", "rejects with exactly \"ssh option 'ProxyCommand=calc.exe' is not permitted\"; calc does not open", "Adjacent: Settings > Servers connect to a real key-auth host still works", "cargo test --lib -- ssh_exec_refuses_local_execution_options"),
    ("P09", "Set $env:PACKETBENCH_SIDECAR_PTH='x' and launch", "log 'PACKETBENCH_SIDECAR_PTH is set but is not a variable PacketBench reads (typo? ...)' and 'boot check done issues=1'", "Adjacent: app starts normally", "cargo test --lib -- boot_check"),
    ("P10", "Right-click a path in a conversation > Open in VS Code", "VS Code opens the file", "Adjacent: 'Show in Explorer' still fails with a console warn (known, H07)", "grep plugins src-tauri/tauri.conf.json"),
    ("P11", "ls -la .dockerignore", "file absent", "Adjacent: nothing depends on it", "git log --oneline -1 -- .dockerignore"),
    ("P12", "pnpm tauri build from a non-interactive shell", "prune-sidecar prints 'pruned node_modules' and the build reaches the bundler", "Adjacent: pnpm lint and pnpm build still work afterwards - root devDeps intact", "grep -n ignore-workspace scripts/prune-sidecar.js"),
]
story.append(check_table(["Patch", "Manual test (real values)", "Expected", "Nothing adjacent broke", "Automated / log line"], patches, [0.42 * inch, 2.1 * inch, 1.7 * inch, 1.4 * inch, 1.18 * inch]))
md_table(["Patch", "Manual test (real values)", "Expected", "Nothing adjacent broke", "Automated / log line"], patches)
story.append(PageBreak())

# g. Unresolved experiments ---------------------------------------------------
h1("Unresolved experiments (audit section 7)")
unres = [
    ("U01", "Windows password-auth SSH", "Settings > Servers > Add: Host <a linux host allowing password auth>, Authentication: password, Save, then Connect. Watch the 'Connecting via SSH...' step.", "Connected within 8 s = stdin path works (F12 void). Timeout/'Permission denied' = stdin path dead -> handoff Task 3."),
    ("U02", "xterm link handler", "SETTLED 2026-09-05: window.open() returns null in this webview, so the addon logs 'Opening link blocked as opener could not be cleared' and does nothing when a terminal URL is clicked.", "Settled - benign, no action. Re-check only if xterm or the webview is upgraded."),
    ("U03", "Key inheritance by MCP stdio servers under the Agent SDK", "SETTLED 2026-09-05: the MCP SDK spawns stdio servers with a fixed 12-name env allowlist that excludes ANTHROPIC_API_KEY; a probe child received 15 vars, none of them the key or a sentinel.", "Settled - F11 refuted, no leak. Re-run after an MCP SDK bump."),
    ("U04", "Sidecar-only audit", "cd agent-sidecar && pnpm --ignore-workspace audit --json", "SETTLED 2026-09-05: 37 advisories (10 high, 24 moderate, 3 low, 0 critical), almost all in the MCP SDK HTTP-server half the sidecar never starts. Recorded in the dependency snapshot."),
    ("U05", "Packaged shell open scope", "SETTLED 2026-09-05. Dev build: the scope rejected a bare path and file:// quoting the P10 regex, and allowed vscode://file/ (VS Code opened) and https:// (Edge opened). Packaged build: the release exe contains the scope regex once, byte-identical to tauri.conf.json line 14; the 2026-08-30 release exe contains it zero times.", "Settled. To re-check after a config change: strings the built exe for vscode://file/ before shipping."),
    ("U06", "Vitest stability", "pnpm test twice on an idle machine", "Both runs 2743 passed; any single non-reproducing failure is CPU contention."),
    ("U07", "Real-hardware acceptance", "dev/acceptance.md sections 3-5 with the headset", "Rows ticked in that file."),
]
story.append(check_table(["ID", "Question", "Procedure (cold)", "How to read the result"], unres, [0.4 * inch, 1.3 * inch, 2.9 * inch, 2.2 * inch]))
md_table(["ID", "Question", "Procedure (cold)", "How to read the result"], unres)
story.append(PageBreak())

# h. Ops pages ------------------------------------------------------------------
h1("Ops pages (from docs/runbooks.md)")
ops = [
    ("Build installers", "export PATH=\"/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH\"\npnpm gates:full\npnpm run release:gate\npnpm tauri build\npnpm run release:readiness --skip-gates\npnpm sidecar:install", "C:/Users/ianwalmsley/packetbench-build/release/bundle/nsis/PacketBench_<version>_x64-setup.exe exists"),
    ("Roll back app", "Windows Settings > Apps > PacketBench > Uninstall; run the previous -setup.exe from the bundle dir", "Version shown in Settings > Advanced matches the previous release"),
    ("Roll back a patch", "git apply -R docs/audit/patches/<name>.diff   (revert P09 before P01)", "cargo test --lib passes"),
    ("Restart app", "taskkill /IM packetbench.exe /F", "Next launch logs boot check done and reaps orphan PTYs"),
    ("Restart MCP server", "Settings > MCP > MCP Provider > Enable MCP Provider off/on", "New bearer token shown; /health answers"),
    ("Tail logs", "Get-Content -Wait -Tail 50 \"$env:LOCALAPPDATA\\PacketBench\\logs\\packetbench.log.$(Get-Date -Format yyyy-MM-dd)\"", "lines stream"),
    ("Security lines only", "Select-String -Path \"$env:LOCALAPPDATA\\PacketBench\\logs\\packetbench.log.*\" -Pattern 'packetbench::(auth|egress|trust|boot)'", "matches listed"),
    ("List secrets", "cmdkey /list | findstr packetbench", "targets <account>.packetbench listed"),
    ("Rotate API key", "Settings > Providers > API Keys: paste new key, save (old one overwritten in api-key-<provider>.packetbench)", "next turn logs outcome=found"),
    ("Rotate git-host token", "Settings > GitHub > host row > Edit > paste token > save (live-probed first)", "'Rotated the token for git-host connection' in log"),
    ("Rotate PacketAgent token", "Settings > PacketAgent > Remove stored token, then save the new one", "'PacketAgent token removed from the credential store.' then requests succeed"),
    ("Restore state", "taskkill /IM packetbench.exe /F; Copy-Item \"$env:USERPROFILE\\.packetbench\\state.v1.json.bak\" \"$env:USERPROFILE\\.packetbench\\state.v1.json\" -Force", "app launches with the previous flights/workspaces"),
    ("Full backup", "robocopy \"$env:USERPROFILE\\.packetbench\" \"D:\\backups\\packetbench-<date>\" /E /XD pty-transcripts", "folder copied; secrets must be re-entered on restore"),
    ("Health", "curl -s http://127.0.0.1:<port>/health", "{\"ok\":true,\"app\":\"PacketBench\",...}"),
]
story.append(check_table(["Task", "Command", "Success looks like"], [(a, M(b, MONO_SMALL), c) for a, b, c in ops], [1.05 * inch, 3.9 * inch, 1.85 * inch]))
md_table(["Task", "Command", "Success looks like"], [(a, f"`{b}`", c) for a, b, c in ops])
story.append(PageBreak())

# i. Blank pages ----------------------------------------------------------------
h1("Bug log")
blank = [["", "", "", "", ""] for _ in range(22)]
t = Table([[P(h, SMALL) for h in ["#", "Date", "Where (view / command / log line)", "What happened vs expected", "Severity"]]] + [[P("", SMALL)] * 5 for _ in blank], colWidths=[0.35 * inch, 0.7 * inch, 2.2 * inch, 2.75 * inch, 0.8 * inch], rowHeights=[None] + [0.36 * inch] * 22)
t.setStyle(GRID)
story.append(t)
md("| # | Date | Where | What happened vs expected | Severity |"); md("|---|---|---|---|---|")
for i in range(22):
    md(f"| {i + 1} | | | | |")
md()
story.append(PageBreak())
h1("Day-31 backlog (fill on the first day access returns)")
para("Seed items, from docs/handoff.md section 4: (1) trust-list UI, (2) cargo update -p h2 -p rustls-webpki -p quinn-proto, (3) Windows askpass for password SSH, (4) reveal_in_file_manager command, (5) restart_sidecar + turn-level cost guardrail.")
t = Table([[P(h, SMALL) for h in ["#", "Item", "Evidence (bug log # / test id)", "Priority", "Owner"]]] + [[P("", SMALL)] * 5 for _ in range(20)], colWidths=[0.35 * inch, 3.0 * inch, 2.15 * inch, 0.7 * inch, 0.6 * inch], rowHeights=[None] + [0.36 * inch] * 20)
t.setStyle(GRID)
story.append(t)
md("| # | Item | Evidence | Priority | Owner |"); md("|---|---|---|---|---|")
for i in range(20):
    md(f"| {i + 1} | | | | |")
md()

# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(0.85 * inch, letter[1] - 0.55 * inch, f"PacketBench QA Workbook - {REPO} @ {HEAD_SHA[:12]} - {TODAY}")
    canvas.drawRightString(letter[0] - 0.85 * inch, 0.5 * inch, f"Page {doc.page}")
    canvas.restoreState()


pdf_path = os.path.join(ROOT, "workbook.pdf")
doc = SimpleDocTemplate(pdf_path, pagesize=letter, leftMargin=0.85 * inch, rightMargin=0.85 * inch, topMargin=0.85 * inch, bottomMargin=0.85 * inch, title="PacketBench QA Workbook", author="audit 2026-09-04")
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)

with open(os.path.join(ROOT, "workbook.md"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(MD) + "\n")

print(f"wrote {pdf_path}: {doc.page} pages; {len(COMMANDS)} IPC commands scanned; workbook.md written")
if doc.page >= 30:
    print("WARNING: page budget exceeded (must be under 30)", file=sys.stderr)
    sys.exit(1)

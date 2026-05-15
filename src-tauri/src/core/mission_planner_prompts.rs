//! Mission Planner — system prompt + wake-message builders.
//!
//! This module is the single home for hand-authored prompt content that the
//! planner agent sees. It's intentionally split out from
//! `commands::mission_planner` so prompt iteration doesn't churn the planner
//! supervisor / registry code.
//!
//! Status: **E1 skeleton.** [`spec_mode_system_prompt`] returns a placeholder
//! and the per-wake-trigger sections of [`wake_user_message`] inline the
//! trigger payload verbatim. The real content lands in **E4** (initial
//! decomposition system prompt) and **E5** (reactive replan prompts).
//!
//! Wake-trigger envelope ownership: **the sidecar is the wrap authority.**
//! `wake_user_message` returns ONLY the body content (trigger payload,
//! journal tail, mission snapshot). The sidecar's `injectUserTurn` handler
//! in `agent-sidecar/src/providers/anthropic.ts` wraps that body in
//! `<wake_trigger source="wake_trigger" kind="…">…</wake_trigger>` based on
//! the `source` / `trigger` fields of the `inject_user_turn` request, so
//! the planner system prompt can teach the model to distinguish
//! wake-triggered re-entry from a real human message. Wrapping here too
//! would double-wrap the envelope.

use serde_json::Value;

use crate::commands::mission_planner::WakeTrigger;

/// Return the system prompt the planner agent starts with in **spec mode**.
///
/// Loaded once at session start and persists for the planner's entire life.
/// The body teaches the model:
///   * its role as autonomous Mission owner,
///   * the Mission lifecycle and which states permit which actions,
///   * the seven callable MCP tools (and the one deferred-to-v1.1 tool it
///     must NOT try to call),
///   * how to read `<wake_trigger>` envelopes the sidecar wraps around
///     every wake-bus re-entry,
///   * decomposition shape and budgets,
///   * safety rails (task ceiling, replan cap, async approvals, quota
///     handling),
///   * communication style across the spec / decomposition / reactive turns.
///
/// Keep this in lockstep with:
///   * `agent-sidecar/src/mcp/mission-planner-server.ts` — tool registrations
///     and zod schemas (model sees these descriptions too).
///   * `src-tauri/src/commands/mission_planner_tools/*.rs` — return shapes
///     and validation rules each tool enforces.
///   * `dev/mission-planner-plan.md` — locked spec.
pub fn spec_mode_system_prompt() -> String {
    r#"# Mission Planner

You are the autonomous **Mission Planner** for PacketADE, a desktop Agent Development Environment. You own a single Mission end-to-end: from the user's very first spec message, through decomposition into milestones and tasks, through reacting to task completions and failures, all the way to declaring the mission complete.

You are not a generic chat assistant. You are a project owner. Treat every Mission you are given as a real engineering project you are personally accountable for. Be decisive, be specific, and respect the user's time.

---

## 1. Role and identity

You hold one long-lived session per Mission. Your responsibilities are:

1. **Spec mode.** Converse with the user about what they want to build. Ask focused clarifying questions only where ambiguity would meaningfully change the plan — do not interview them. Propose a rough plan when you have enough signal. Stay friendly, brief, and helpful.
2. **Launch transition.** When the user clicks Launch, you will receive a `<wake_trigger source="wake_trigger" kind="launch">` envelope. At that point spec mode ends and you immediately decompose the spec into milestones and tasks using your MCP tools.
3. **Active ownership.** Once tasks are running, you will be re-entered via wake-trigger envelopes whenever something requires your attention (a task finished, a task failed, the user replied to an approval, a quota was hit, etc.). Read the envelope, decide what to do, and call the right tools. Then end your turn — the sidecar will wake you again when the next event arrives.
4. **Mission closure.** When every milestone is complete and no further work remains, call `complete_mission` with a short summary. This is terminal.

You do **not** write code yourself. You do not pretend to execute work. Tasks are dispatched to executor agents (default `claude-code`) that run in isolated worktrees. Your only mechanism for getting work done is the tool surface described below.

---

## 2. Mission lifecycle

Missions transition through these states:

```
spec → planning → active → review → paused → done | failed | cancelled
```

- **spec** — You and the user are conversing. No milestones or tasks exist yet. The only thing that ends spec mode is a `<wake_trigger kind="launch">` envelope.
- **planning** — You have received `launch`. Decompose the spec into milestones and tasks **now**, in this single turn. Do not chat. Do not ask for confirmation. Emit the tool calls and end your turn.
- **active** — Tasks are running. Every wake-trigger you receive after planning should be handled with a small, targeted tool sequence and then you end your turn.
- **review** — An approval gate is open (e.g. you called `request_user_approval`). You may continue with parallel work, but do not act on the question itself until the user resolves it. A resolution arrives later as a `user_message_in_journal` wake-trigger carrying the user's answer.
- **paused** — The user paused the mission. Do nothing until resumed. If somehow woken in paused state, end the turn without calling tools.
- **done / failed / cancelled** — Terminal. You must not call any tools. If you somehow get woken in a terminal state, end the turn immediately.

You do not control transitions to `paused`, `failed`, `cancelled`, or back to `active`. Those are owned by the user and the runtime. You **do** drive `planning → active` (by decomposing) and `active → done` (by calling `complete_mission`).

---

## 3. Tools

You have seven MCP tools available. (An eighth tool, `spawn_helper_planner`, is mentioned in some older docs — it is **deferred to v1.1** and is not available. If you attempt to call it, the dispatcher will error with `"deferred to v1.1; see backlog.md"`. Do not try.)

Tool names below are written **without** the `mcp__planner__` prefix the runtime adds. Use the names exactly as the SDK presents them to you.

### `create_milestone(title, goal, dependencies?)`

A milestone is a coherent phase of work (e.g. "Schema migration", "Frontend rewrite", "End-to-end tests"). Aim for **2–4 milestones per mission**.

- `title` (string, ≤120 chars) — short label shown in the UI.
- `goal` (string, ≤1000 chars) — what success looks like for this milestone.
- `dependencies` (string[], optional) — milestone ids that must complete first.

Returns `{ milestoneId: string }`. Keep the returned id; you will need it for `create_task`.

### `create_task(milestone_id, title, prompt, agent_id, target_spec)`

A task is a single unit of executable work an agent runs in an isolated worktree. Aim for **4–10 tasks per mission total**, each scoped to **5–30 min** of executor work.

- `milestone_id` (string) — the parent milestone's id (from `create_milestone`).
- `title` (string, ≤160 chars) — short label for the task tile.
- `prompt` (string, non-empty) — **the verbatim instruction the executor agent will receive.** Write it as if you were the human handing the work off. Include exact file paths, expected outputs, constraints, definition of done. The executor never sees your spec-mode conversation; the prompt must stand alone.
- `agent_id` (string) — the executor agent. Default to `"claude-code"` unless the user specifically asked for a different agent. Unknown ids fall back to `claude-code` with a warning.
- `target_spec` (object) — where the agent runs. Default shape:
  ```json
  {
    "kind": "local",
    "basePath": "<project path from spec mode>",
    "baseBranch": "main",
    "agentConfigId": "claude-code",
    "provider": "claude-oauth",
    "model": "claude-sonnet-4-6"
  }
  ```
  If the user specified an SSH target, use the `"kind": "ssh"` variant with the host fields they gave you. The dispatcher overwrites `agentConfigId` with the validated agent_id, so don't worry about that field drifting.

Returns `{ taskId: string }`. The task starts as `queued` and the executor picks it up; you do not need to start it manually.

### `update_task(task_id, patch)`

Mutate fields on an existing task. The dispatcher whitelists allowed patch keys:

- `title` (string) — rename the task.
- `prompt` (string) — rewrite the executor's instruction.
- `agent_id` (string) — change which agent runs it.
- `target_spec` (object) — change the execution target.
- `status` — **only** `"cancelled"` (abort this task) or `"queued"` (re-queue a previously cancelled task). All other status values are owned by the executor and the dispatcher will reject them with a clear error directing you to `mark_task_blocked` or `replan_after_failure`.

Unknown patch keys are silently dropped. Returns `{ ok: true, updated_fields: string[] }`.

### `mark_task_blocked(task_id, reason)`

The task cannot proceed and you do not want it retried. Examples: an external dependency is unavailable, a prerequisite was never done, the design changed and the work no longer applies.

- `task_id` (string).
- `reason` (string, ≤500 chars) — shown to the user in the UI.

Returns `{ ok: true }`. Blocked tasks do **not** consume an executor slot. Use this in preference to letting a task spin or fail repeatedly. If you intend to retry with a different approach, use `replan_after_failure` instead.

### `replan_after_failure(task_id)`

Acknowledge that a task failed and you are about to schedule replacement work. **Capped at 3 replans per task** (RateLimit and Network errors are exempt and handled by the runtime, not you). After the cap, the dispatcher rejects further calls and you must escalate via `request_user_approval`.

- `task_id` (string) — the failed task's id (from the wake-trigger payload).

Returns `{ ready_for_new_tasks: true, parent_milestone_id: string, replan_count: number }`. The failed task is auto-cancelled and removed from the milestone-progress rollup.

**You must follow `replan_after_failure` with one or more `create_task` calls in the SAME turn** under `parent_milestone_id`. If you do not schedule replacement work, the milestone may stall. Don't ack a failure you can't follow up on — use `mark_task_blocked` or `request_user_approval` instead.

### `request_user_approval(question, options?)`

**This tool is async-return.** It returns immediately with a sentinel; it does **not** wait for the user's answer. Reading this paragraph carefully prevents the single most common planner failure mode.

- `question` (string, ≤500 chars).
- `options` (string[], ≤6, optional) — for multiple-choice answers.

Returns `{ status: "pending_approval", approval_id: string }` **immediately**.

When you receive this response, treat it as: "Question filed. Keep working." Continue with whatever parallel tool calls make sense (creating tasks that don't depend on the answer, replanning unrelated failures, etc.). End your turn normally. The user's actual answer will arrive later as a fresh `<wake_trigger kind="user_message_in_journal">` envelope containing their reply; you act on it then.

Use this tool when you genuinely need a human decision: design ambiguity that materially changes the plan, an irreversible action that needs sign-off, hitting the 60-task ceiling, or a third replan on a task that keeps failing the same way.

### `complete_mission(summary)`

Terminal tool. Marks the mission `done`, writes a final summary to the journal, and closes your session. No further wake-triggers are delivered.

- `summary` (string, ≤2000 chars) — brief recap of what was built and any caveats.

Returns `{ ok: true }`. Only call this when **every** milestone you created is complete and no further work is planned. Do not call it mid-decomposition. Do not call it as a "just in case" cleanup.

### Wrong-tool patterns to avoid

- **Don't call `complete_mission` during decomposition.** Wait until all milestones are actually done.
- **Don't call `update_task` to set `status: "running"`, `"completed"`, or `"failed"`.** Those are owned by the executor. The dispatcher will reject them.
- **Don't call `spawn_helper_planner`.** It's deferred to v1.1; the call will error.
- **Don't call `noop`** for any real work. It exists for internal smoke testing only — do NOT call it during real work.
- **Don't `mark_task_blocked` something you actually want retried.** Use `replan_after_failure` and create a replacement task in the same turn.

---

## 4. Wake-trigger semantics

You receive two kinds of input from the runtime:

1. **Plain user messages**, only during spec mode. Treat these as a normal conversation turn — respond, ask clarifying questions, refine your understanding.
2. **`<wake_trigger source="wake_trigger" kind="...">…</wake_trigger>` envelopes**, throughout the rest of the mission. These are *not* user typing — they are the runtime waking you up because something happened. Read the envelope body completely; it contains the context (task ids, error logs, mission snapshot, journal tail) you need to decide what to do.

The possible kinds:

- **`launch`** — The user clicked Launch in the UI. Decompose the spec into milestones and tasks now. End the turn with the plan in place.
- **`task_completed`** — A task you scheduled finished successfully. Decide the next step: schedule a follow-on task, advance a milestone, or call `complete_mission` if everything is done. Often no tool call is needed — just end the turn and wait for the next event.
- **`task_failed`** — A task failed. Read the error context in the envelope body, then pick one path:
  * `replan_after_failure(task_id)` followed by one or more `create_task` calls if you can try a different approach.
  * `mark_task_blocked(task_id, reason)` if the work genuinely cannot proceed and shouldn't be retried.
  * `request_user_approval(question)` if you need human input to decide.
- **`approval_gate_reached`** — The runtime noticed you're about to do something that needs approval (e.g. approaching the 60-task ceiling). Inspect the body, then call `request_user_approval` with a focused question and stop creating tasks until the user resolves it.
- **`collision_detected`** — Two or more tasks want to write to the same files at the same time. Body contains the colliding task ids. Re-route by editing prompts (via `update_task`) or by cancelling one and scheduling it as a dependency of the other.
- **`user_message_in_journal`** — The user sent a follow-up message after Launch. This is also how `request_user_approval` answers come back. Read it, react accordingly.
- **`quota_exhausted`** — The Anthropic rate limit hit. Stop work. Do not retry — the runtime will resume you automatically when the window resets. End the turn without calling tools.
- **`compaction_resume`** — your prior conversation has been summarized
  to stay under the 200K context window. The envelope body contains
  the summary text. End your turn quietly — the next real event will
  arrive on the following wake. Do NOT call tools in response to this
  trigger.

**Read every envelope all the way through before acting.** The body may include the recent journal tail and a mission snapshot (current milestones, task statuses, attempt outcomes) — that's how you know what state the mission is in across wake events. You do not need to remember everything across turns; the snapshot is your ground truth.

If a wake_trigger envelope is empty, malformed, or missing the kind attribute, end the turn cleanly without calling tools and wait for the next trigger. Don't guess at intent — the system will retry or escalate if needed.

---

## 5. Decomposition guidelines

When you receive `<wake_trigger kind="launch">`, this is the most important turn of the mission. Get it right.

- **Shape.** Aim for **2–4 milestones**, **4–10 tasks total**. Fewer is fine for small missions; more is a smell.
- **Granularity.** Each task should be runnable in 5–30 min by one agent. Tasks larger than that should be split; tasks much smaller should be merged into a sibling.
- **Prompts are the product.** The `prompt` field on `create_task` is the only context the executor sees. Write it like a focused task brief: state the goal, name the files, define done, mention any constraints. Bad prompt = wasted executor minutes.
- **Agent choice.** Default to `claude-code` unless the user requested otherwise. Don't get clever.
- **Target spec.** Use the local-worktree shape with the project path the user gave you during spec mode. Use the SSH shape only if the user explicitly asked for SSH.
- **Dependencies.** Use milestone `dependencies` to express ordering between phases. Inside a milestone, tasks run in parallel by default — if two tasks must be sequential, split them across milestones or capture the ordering in the prompt.
- **No preamble, no postamble.** Once you start calling tools on the launch turn, just emit the tool calls. Do not write a "I will now create the following milestones..." paragraph. Do not summarize after. The user is watching the milestones populate live in the UI; a wall of text is noise.

End the launch turn when the plan is in place. Don't wait for confirmation. Don't ask the user to review the plan — they'll see it.

---

## 6. Rules and limits

- **Task ceiling.** 60 tasks total per mission. When you approach it, the dispatcher will rebuff task 61 and tell you to `request_user_approval` first. Don't fight it — file the approval and continue with parallel work that's still under the cap.
- **Replan cap.** 3 replans per task. RateLimit and Network failures are exempt and don't count. After 3 normal failures, escalate via `request_user_approval`.
- **Async approvals.** `request_user_approval` **never blocks**. File the question, keep working, the user's answer arrives later. If you wait for it, you'll stall the entire mission for no reason.
- **Idempotency.** If you somehow receive a second `<wake_trigger kind="launch">` (e.g. the user retried after a UI error), do not wipe the plan. Inspect the mission snapshot in the envelope body — if milestones already exist, assume the user is reconfirming and continue from the current state instead of redoing decomposition.
- **Tool-call budgets.** There are per-turn caps (Decomposition 50, Reactive 25, Replan 25), but the dispatcher enforces them — you don't need to count. Just don't be wasteful.
- **Quota.** On `quota_exhausted`, stop. The runtime will wake you when the rate-limit window resets. Do not retry in a loop; you will only deepen the backoff.

---

## 7. Communication style

- **Spec mode**: conversational, warm, focused. Ask the one or two clarifying questions that actually change the plan; skip the rest. Show genuine interest in what the user wants to build. Propose a rough plan when you have enough signal, and tell them they can hit Launch when ready.
- **Decomposition turn**: terse. Tool calls only. No "Great! I'll now create..." preamble, no "Here's what I built..." postamble. The user can see the milestones populate live.
- **Reactive turns**: brief. A one-sentence acknowledgement is fine ("Task X completed; queueing follow-on Y.") — but it is optional. Often the right reactive turn is just the tool call(s) plus a clean end of turn.
- **Approval questions**: focused. State the choice in one sentence. Provide `options` when the answer is genuinely multiple-choice. Do not lecture.
- **Always**: respect the user's time. They can read the UI. Don't recap.

You own the mission. Act like it.
"#.to_string()
}

/// Build the user-message body for a wake-triggered planner turn.
///
/// Returns **only the body** (trigger payload, journal tail, mission
/// snapshot) — NOT the `<wake_trigger>` envelope. The sidecar's
/// `injectUserTurn` handler owns the wrapper and is the single authority
/// on its shape; wrapping here would double-wrap the envelope.
///
/// Each `WakeTrigger` variant is rendered into a hand-authored block that
/// gives the planner everything it needs to decide what to do next: the
/// relevant payload fields, the current mission state, a tail of recent
/// journal entries on failures, and concrete guidance about which tools to
/// prefer. The renderer reads known fields off `mission_snapshot` (title,
/// objective, milestones, tasks) and falls back to `"(not set)"` /
/// `"(unknown)"` when fields are missing, so a thin snapshot doesn't break
/// the body.
///
/// `journal_tail` is the recent session-log slice; pass empty string when
/// nothing is available.
pub fn wake_user_message(
    trigger: &WakeTrigger,
    journal_tail: &str,
    mission_snapshot: &Value,
) -> String {
    match trigger {
        WakeTrigger::Decomposition => render_decomposition(mission_snapshot),
        WakeTrigger::TaskCompleted(task_id) => {
            render_task_completed(task_id, mission_snapshot)
        }
        WakeTrigger::TaskFailed(task_id) => {
            render_task_failed(task_id, journal_tail, mission_snapshot)
        }
        WakeTrigger::ApprovalGateReached(reason) => {
            render_approval_gate(reason, mission_snapshot)
        }
        WakeTrigger::CollisionDetected(task_ids) => {
            render_collision(task_ids, mission_snapshot)
        }
        WakeTrigger::UserMessageInJournal(text) => {
            render_user_message(text, mission_snapshot)
        }
        WakeTrigger::QuotaExhausted => render_quota_exhausted(),
    }
}

// ---------------------------------------------------------------------------
// Per-trigger body renderers
// ---------------------------------------------------------------------------

fn render_decomposition(snapshot: &Value) -> String {
    let title = str_field(snapshot, "title").unwrap_or_else(|| "(not set)".to_string());
    let objective =
        str_field(snapshot, "objective").unwrap_or_else(|| "(not set)".to_string());
    let project_path =
        str_field(snapshot, "projectPath").unwrap_or_else(|| "(not set)".to_string());
    let workspace_id =
        str_field(snapshot, "workspaceId").unwrap_or_else(|| "(local)".to_string());

    let milestones = milestones_array(snapshot);
    let milestone_count = milestones.map(|m| m.len()).unwrap_or(0);
    let milestone_list = match milestones {
        Some(arr) if !arr.is_empty() => arr
            .iter()
            .filter_map(|m| m.get("title").and_then(|t| t.as_str()))
            .map(|t| format!("  - {}", t))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => "  (none)".to_string(),
    };
    let task_count = count_all_tasks(snapshot);

    format!(
        "User has approved the spec discussion and clicked Launch. Begin\n\
         decomposition now.\n\
         \n\
         Current mission snapshot:\n\
         - Title: {title}\n\
         - Objective: {objective}\n\
         - Existing milestones: {milestone_count}\n\
         {milestone_list}\n\
         - Existing tasks: {task_count}\n\
         \n\
         Decompose into 2-4 milestones and 4-10 tasks total, calling\n\
         create_milestone and create_task as needed. End your turn when the\n\
         plan is in place — the executor will pick it up automatically.\n\
         \n\
         Project path: {project_path}\n\
         Workspace id: {workspace_id}"
    )
}

fn render_task_completed(task_id: &str, snapshot: &Value) -> String {
    let task = find_task_by_id(snapshot, task_id);

    let title = task
        .and_then(|t| t.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)")
        .to_string();
    let agent = task
        .and_then(|t| t.get("agentConfigId").or_else(|| t.get("agent_config_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)")
        .to_string();
    let started_at = task
        .and_then(|t| t.get("startedAt").or_else(|| t.get("started_at")))
        .map(|v| v.to_string())
        .unwrap_or_else(|| "(unknown)".to_string());
    let completed_at = task
        .and_then(|t| t.get("completedAt").or_else(|| t.get("completed_at")))
        .map(|v| v.to_string())
        .unwrap_or_else(|| "(unknown)".to_string());
    let duration = task
        .and_then(|t| t.get("result"))
        .and_then(|r| r.get("durationMs").or_else(|| r.get("duration_ms")))
        .map(|v| v.to_string())
        .unwrap_or_else(|| "(unknown)".to_string());
    let summary = task
        .and_then(|t| t.get("result"))
        .and_then(|r| r.get("summary"))
        .and_then(|v| v.as_str())
        .unwrap_or("(none)")
        .to_string();
    let files_changed = task
        .and_then(|t| t.get("result"))
        .and_then(|r| r.get("filesChanged").or_else(|| r.get("files_changed")))
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "(none reported)".to_string());

    let pending = collect_pending_tasks(snapshot, task_id);
    let pending_count = pending.len();
    let pending_list = if pending.is_empty() {
        "  (none)".to_string()
    } else {
        pending
            .iter()
            .map(|(id, title)| format!("  - {} — {}", id, title))
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        "Task {task_id} completed successfully.\n\
         \n\
         Title: {title}\n\
         Agent: {agent}\n\
         Duration: {duration} ms\n\
         Started: {started_at}\n\
         Ended: {completed_at}\n\
         Result summary: {summary}\n\
         Files changed: {files_changed}\n\
         \n\
         Other pending tasks in this mission: {pending_count}\n\
         {pending_list}\n\
         \n\
         Decide your next step. If this completes a milestone, optionally\n\
         emit a brief acknowledgement. If the mission's final task just\n\
         finished, call complete_mission. Otherwise let the executor pick up\n\
         the next queued task — no tool call required."
    )
}

fn render_task_failed(task_id: &str, journal_tail: &str, snapshot: &Value) -> String {
    let task = find_task_by_id(snapshot, task_id);

    let title = task
        .and_then(|t| t.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)")
        .to_string();
    let agent = task
        .and_then(|t| t.get("agentConfigId").or_else(|| t.get("agent_config_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)")
        .to_string();
    let exit_code = task
        .and_then(|t| t.get("result"))
        .and_then(|r| r.get("exitCode").or_else(|| r.get("exit_code")))
        .map(|v| v.to_string())
        .unwrap_or_else(|| "(unknown)".to_string());
    // Collect up to 3 error strings as a Vec for both the joined display and
    // the category classifier.
    let error_strings: Vec<String> = task
        .and_then(|t| t.get("result"))
        .and_then(|r| r.get("errors"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .take(3)
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let errors = if error_strings.is_empty() {
        "(none captured)".to_string()
    } else {
        error_strings.join("; ")
    };
    let description = task
        .and_then(|t| t.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("(not available)")
        .to_string();

    let log_block = if journal_tail.trim().is_empty() {
        "(no log available)".to_string()
    } else {
        // Tail to 30 lines.
        let lines: Vec<&str> = journal_tail.lines().collect();
        let start = lines.len().saturating_sub(30);
        lines[start..].join("\n")
    };

    let replan_count = task
        .and_then(|t| t.get("replanCount").or_else(|| t.get("replan_count")))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Classify the failure. Prefer a pre-classified field on the snapshot
    // (e.g. `errorCategory` written by the wake dispatcher) so the source of
    // truth stays in one place; fall back to a renderer-local heuristic
    // otherwise.
    let category = task
        .and_then(|t| t.get("errorCategory").or_else(|| t.get("error_category")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| quick_classify(&error_strings).to_string());
    // Prefer the snapshot's explicit `replanExempt` boolean when the wake
    // dispatcher pre-classified the failure — that field is computed via
    // `core::error_classifier::is_replan_exempt`, which is the same function
    // `replan_after_failure.rs` consults when deciding whether to bump the
    // counter. Falling back to a string match keeps the renderer working
    // for un-pre-classified paths (e.g. when the snapshot was assembled
    // outside the wake dispatcher).
    //
    // The string-match fallback accepts both `"network"` (the local
    // `quick_classify` heuristic's label) and `"timeout"` (the snake_case
    // serialization of `AiErrorCategory::Timeout`, which IS the canonical
    // "network bucket" per `core/error_classifier.rs` — see the comment on
    // `is_replan_exempt`). Both represent network-class transient
    // failures; the replan-cap exemption applies to both. Without the
    // `"timeout"` arm, a pre-classified `Timeout` failure would render
    // "WILL count" while the dispatcher actually treats it as free,
    // confusing the planner.
    let exempt = task
        .and_then(|t| t.get("replanExempt").or_else(|| t.get("replan_exempt")))
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| {
            matches!(category.as_str(), "rate_limit" | "network" | "timeout")
        });

    let category_block = if exempt {
        format!(
            "Error category: **{category}** (does NOT count against your\n\
             replan budget — this is treated as a transient failure handled\n\
             by the runtime). Calling replan_after_failure on this task is\n\
             FREE and will not increment the counter."
        )
    } else {
        format!(
            "Error category: **{category}** (this WILL count against your\n\
             replan budget — currently {replan_count}/3 used)."
        )
    };

    format!(
        "Task {task_id} failed.\n\
         \n\
         Title: {title}\n\
         Agent: {agent}\n\
         Exit code: {exit_code}\n\
         Errors: {errors}\n\
         \n\
         {category_block}\n\
         \n\
         Last 30 lines of session log:\n\
         {log_block}\n\
         \n\
         Original prompt that was given:\n\
         {description}\n\
         \n\
         Decide:\n\
         - If the failure suggests a fixable problem (e.g. wrong file path,\n\
           bad assumption about codebase shape), call replan_after_failure\n\
           followed by one or more create_task calls in this same turn with a\n\
           corrected approach.\n\
         - If the failure is fundamental (e.g. the task isn't possible as\n\
           described), call mark_task_blocked with a clear reason and either\n\
           skip or escalate via request_user_approval.\n\
         - If the failure is ambiguous or you need user input, call\n\
           request_user_approval (it returns IMMEDIATELY — keep working).\n\
         \n\
         Replan budget: {replan_count}/3 used (cap = 3). RateLimit and\n\
         Network errors are exempt and don't increment this counter; only\n\
         'other' failures do. {replan_count} failures have counted toward\n\
         the cap on this task. After the cap you MUST escalate via\n\
         request_user_approval."
    )
}

/// Renderer-local heuristic classifier for the last-error string(s).
///
/// Returns one of `"rate_limit" | "network" | "other"`. This is intentionally
/// a renderer-local heuristic (and not a call into
/// `core/error_classifier.rs`) so the renderer doesn't have to reconstruct a
/// `Task` from the JSON snapshot. The real classifier owned by sibling
/// E5-CLASSIFIER may also pre-write `errorCategory` onto the snapshot, in
/// which case `render_task_failed` prefers that and skips this function.
fn quick_classify(errors: &[String]) -> &'static str {
    let combined = errors
        .iter()
        .map(|s| s.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    if combined.contains("rate limit")
        || combined.contains("rate_limit")
        || combined.contains("ratelimit")
        || combined.contains("429")
        || combined.contains("too many requests")
        || combined.contains("quota")
    {
        "rate_limit"
    } else if combined.contains("timeout")
        || combined.contains("timed out")
        || combined.contains("network")
        || combined.contains("connection")
        || combined.contains("dns")
        || combined.contains("socket")
        || combined.contains("econnreset")
        || combined.contains("etimedout")
    {
        "network"
    } else {
        "other"
    }
}

fn render_approval_gate(reason: &str, snapshot: &Value) -> String {
    let task_count = count_all_tasks(snapshot);

    format!(
        "System escalation: an approval gate was reached.\n\
         \n\
         Reason: {reason}\n\
         Mission state: {task_count}/60 tasks created so far.\n\
         \n\
         You should call request_user_approval with a clear question\n\
         explaining what you want to do. It returns immediately — continue\n\
         working on parallel tasks if any are queued; the user's answer\n\
         arrives later as a wake_trigger of kind user_message_in_journal."
    )
}

fn render_collision(task_ids: &[String], snapshot: &Value) -> String {
    let collisions: Vec<String> = task_ids
        .iter()
        .map(|id| {
            let task = find_task_by_id(snapshot, id);
            let title = task
                .and_then(|t| t.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("(unknown)");
            let paths = task
                .and_then(|t| {
                    t.get("claimedPaths")
                        .or_else(|| t.get("claimed_paths"))
                        .or_else(|| t.get("filesChanged"))
                        .or_else(|| t.get("files_changed"))
                })
                .and_then(|v| v.as_array())
                .filter(|a| !a.is_empty())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "(unknown paths)".to_string());
            format!("  - {} — {} (paths: {})", id, title, paths)
        })
        .collect();

    let list = if collisions.is_empty() {
        "  (no task details available)".to_string()
    } else {
        collisions.join("\n")
    };

    format!(
        "File-ownership collision detected between tasks:\n\
         {list}\n\
         \n\
         These tasks can't run in parallel because they'd write the same\n\
         files. Options:\n\
         1. Re-target one or more tasks via update_task(target_spec: ...)\n\
            so they run sequentially or on different files.\n\
         2. Merge into a single task via mark_task_blocked + create_task with\n\
            the combined work.\n\
         3. Escalate via request_user_approval if you can't decide."
    )
}

fn render_user_message(text: &str, snapshot: &Value) -> String {
    // If the snapshot's triggerPayload looks like an approval resolution
    // (has approvalId + choice), surface that as context — the planner can
    // then correlate the answer with the parked work.
    let payload = snapshot.get("triggerPayload");
    let approval_id = payload
        .and_then(|p| p.get("approvalId").or_else(|| p.get("approval_id")))
        .and_then(|v| v.as_str());
    let choice = payload
        .and_then(|p| p.get("choice"))
        .and_then(|v| v.as_str());

    let context = match (approval_id, choice) {
        (Some(id), Some(c)) => format!(
            "Context: (this is the resolution of approval {} — choice: {})",
            id, c
        ),
        _ => "Context: free-form user message — no associated approval gate.".to_string(),
    };

    format!(
        "User sent a follow-up message:\n\
         \n\
         {text}\n\
         \n\
         {context}\n\
         \n\
         Decide your response. If this affects the plan, update tasks /\n\
         create new ones. If it's a clarifying question, answer it. If it's\n\
         an approval resolution, continue from where you parked."
    )
}

fn render_quota_exhausted() -> String {
    "Anthropic rate-limit window hit.\n\
     \n\
     The system has paused this mission's planner. No further work will\n\
     be scheduled until the quota window resets. You should NOT call any\n\
     tools in this turn — just acknowledge briefly. The system will\n\
     re-wake you with the next event once the window has reset."
        .to_string()
}

// ---------------------------------------------------------------------------
// Snapshot helpers — tolerant to thin / missing data
// ---------------------------------------------------------------------------

/// Pull a top-level string field off the snapshot, accepting both camelCase
/// and snake_case spellings (we don't fully control the snapshot shape; E5
/// may pass different serializations through the same renderer).
fn str_field(snapshot: &Value, name: &str) -> Option<String> {
    if let Some(s) = snapshot.get(name).and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    // Try snake_case fallback if the caller used a camelCase name.
    let snake = camel_to_snake(name);
    snapshot
        .get(&snake)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn camel_to_snake(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for (i, ch) in s.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn milestones_array(snapshot: &Value) -> Option<&Vec<Value>> {
    snapshot.get("milestones").and_then(|v| v.as_array())
}

fn count_all_tasks(snapshot: &Value) -> usize {
    milestones_array(snapshot)
        .map(|milestones| {
            milestones
                .iter()
                .map(|m| {
                    m.get("tasks")
                        .and_then(|t| t.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

/// Walk all milestones → tasks looking for `task_id`. Falls back to a
/// top-level `task` field on the snapshot if the planner only passed the
/// focused task (E5 may pre-resolve and include it).
fn find_task_by_id<'a>(snapshot: &'a Value, task_id: &str) -> Option<&'a Value> {
    if let Some(milestones) = milestones_array(snapshot) {
        for milestone in milestones {
            if let Some(tasks) = milestone.get("tasks").and_then(|t| t.as_array()) {
                for task in tasks {
                    if task
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s == task_id)
                        .unwrap_or(false)
                    {
                        return Some(task);
                    }
                }
            }
        }
    }
    // E5 single-task fallback. Accept a top-level `task` whose id matches
    // (or that has no id field at all — handlers can pre-resolve it).
    snapshot.get("task").filter(|t| {
        t.get("id")
            .and_then(|v| v.as_str())
            .map(|s| s == task_id)
            .unwrap_or(true)
    })
}

/// Collect (id, title) pairs for tasks that are still queueable, excluding
/// the just-finished task. Oldest-first by `createdAt` when available.
fn collect_pending_tasks(snapshot: &Value, exclude_task_id: &str) -> Vec<(String, String)> {
    let mut tasks: Vec<(u64, String, String)> = Vec::new();
    if let Some(milestones) = milestones_array(snapshot) {
        for milestone in milestones {
            if let Some(arr) = milestone.get("tasks").and_then(|t| t.as_array()) {
                for task in arr {
                    let id = task
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let status = task
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let id = match id {
                        Some(i) if i != exclude_task_id => i,
                        _ => continue,
                    };
                    if !matches!(
                        status,
                        "pending" | "queued" | "blocked" | "approval_needed" | "running"
                    ) {
                        continue;
                    }
                    let title = task
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(untitled)")
                        .to_string();
                    let created = task
                        .get("createdAt")
                        .or_else(|| task.get("created_at"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    tasks.push((created, id, title));
                }
            }
        }
    }
    tasks.sort_by_key(|t| t.0);
    tasks
        .into_iter()
        .map(|(_, id, title)| (id, title))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spec_mode_system_prompt_is_nonempty() {
        // We don't pin the wording — E4 owns that — but the function must
        // return a non-empty string so callers can pass it straight to the
        // sidecar without conditional handling.
        assert!(!spec_mode_system_prompt().is_empty());
    }

    #[test]
    fn wake_user_message_returns_unwrapped_body() {
        // The sidecar's injectUserTurn handler is the single authority on
        // the `<wake_trigger>` envelope. This builder must return only the
        // body content; wrapping here would double-wrap the envelope.
        let msg = wake_user_message(
            &WakeTrigger::TaskCompleted("task-42".to_string()),
            "(journal)",
            &json!({}),
        );
        assert!(!msg.contains("<wake_trigger"));
        assert!(!msg.contains("</wake_trigger>"));
        // The body surfaces the task id verbatim so E5 can correlate.
        assert!(msg.contains("task-42"));
    }

    #[test]
    fn wake_user_message_for_decomposition_includes_title_and_objective() {
        let snapshot = json!({
            "title": "Add dark-mode toggle",
            "objective": "Ship a working dark mode toggle in the settings pane",
            "projectPath": "/projects/PacketADE",
            "workspaceId": "ws-123",
            "milestones": []
        });
        let msg = wake_user_message(&WakeTrigger::Decomposition, "", &snapshot);
        assert!(
            msg.contains("Add dark-mode toggle"),
            "decomposition body should include the mission title; got: {}",
            msg
        );
        assert!(
            msg.contains("Ship a working dark mode toggle"),
            "decomposition body should include the objective"
        );
        assert!(
            msg.contains("/projects/PacketADE"),
            "decomposition body should include the project path"
        );
        assert!(
            msg.contains("ws-123"),
            "decomposition body should include the workspace id"
        );
        assert!(
            msg.contains("Launch") && msg.contains("decomposition"),
            "decomposition body should mention Launch and decomposition guidance"
        );
        assert!(
            msg.contains("create_milestone") && msg.contains("create_task"),
            "decomposition body should mention the tools to call"
        );
    }

    #[test]
    fn wake_user_message_for_task_failed_includes_log_tail() {
        let snapshot = json!({
            "milestones": [
                {
                    "id": "m1",
                    "tasks": [
                        {
                            "id": "task-99",
                            "title": "Migrate schema",
                            "agentConfigId": "claude-code",
                            "description": "Run the v3 migration against the local db.",
                            "result": {
                                "exitCode": 1,
                                "errors": ["psql: connection refused", "retry hit timeout"]
                            }
                        }
                    ]
                }
            ]
        });
        let journal = "line1\nline2\nERROR: connection refused\nline4";
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-99".to_string()),
            journal,
            &snapshot,
        );
        assert!(msg.contains("task-99"), "should include task id");
        assert!(msg.contains("Migrate schema"), "should include task title");
        assert!(
            msg.contains("ERROR: connection refused"),
            "should include log tail content; got: {}",
            msg
        );
        assert!(
            msg.contains("psql: connection refused"),
            "should include errors from result"
        );
        assert!(
            msg.contains("Run the v3 migration"),
            "should include original prompt (description)"
        );
        assert!(
            msg.contains("replan_after_failure")
                && msg.contains("mark_task_blocked")
                && msg.contains("request_user_approval"),
            "should mention all three failure-handling tools"
        );
        assert!(
            msg.contains("/3"),
            "should mention replan cap of 3"
        );
    }

    #[test]
    fn render_task_failed_surfaces_rate_limit_category() {
        let snapshot = json!({
            "milestones": [
                {
                    "id": "m1",
                    "tasks": [
                        {
                            "id": "task-rl",
                            "title": "Call upstream API",
                            "agentConfigId": "claude-code",
                            "description": "Hit the rate-limited endpoint.",
                            "replanCount": 1,
                            "result": {
                                "exitCode": 1,
                                "errors": ["HTTP 429 Too Many Requests"]
                            }
                        }
                    ]
                }
            ]
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-rl".to_string()),
            "log line\nanother",
            &snapshot,
        );
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("rate_limit"),
            "body should classify as rate_limit; got: {}",
            msg
        );
        assert!(
            msg.contains("does NOT count"),
            "rate_limit body should say the failure does NOT count against the budget; got: {}",
            msg
        );
        assert!(
            msg.contains("FREE") || msg.contains("free"),
            "rate_limit body should explain replan is free; got: {}",
            msg
        );
        // The cap line is still printed and reflects the snapshot value.
        assert!(
            msg.contains("1/3"),
            "should reflect the snapshot's replanCount=1; got: {}",
            msg
        );
    }

    #[test]
    fn render_task_failed_surfaces_network_category() {
        let snapshot = json!({
            "milestones": [
                {
                    "id": "m1",
                    "tasks": [
                        {
                            "id": "task-net",
                            "title": "Pull dependency",
                            "agentConfigId": "claude-code",
                            "description": "Fetch the upstream tarball.",
                            "replanCount": 0,
                            "result": {
                                "exitCode": 1,
                                "errors": ["connection reset by peer"]
                            }
                        }
                    ]
                }
            ]
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-net".to_string()),
            "",
            &snapshot,
        );
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("network"),
            "body should classify as network; got: {}",
            msg
        );
        assert!(
            msg.contains("does NOT count"),
            "network body should say the failure does NOT count against the budget; got: {}",
            msg
        );
        assert!(
            !msg.contains("WILL count"),
            "network body should NOT say the failure WILL count; got: {}",
            msg
        );
    }

    #[test]
    fn render_task_failed_surfaces_other_category_and_count() {
        let snapshot = json!({
            "milestones": [
                {
                    "id": "m1",
                    "tasks": [
                        {
                            "id": "task-oops",
                            "title": "Run the migration",
                            "agentConfigId": "claude-code",
                            "description": "Migrate the schema.",
                            "replanCount": 2,
                            "result": {
                                "exitCode": 101,
                                "errors": ["panicked: index out of bounds"]
                            }
                        }
                    ]
                }
            ]
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-oops".to_string()),
            "",
            &snapshot,
        );
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("other"),
            "body should classify as other; got: {}",
            msg
        );
        assert!(
            msg.contains("2/3"),
            "should reflect replanCount=2 against the cap of 3; got: {}",
            msg
        );
        assert!(
            msg.contains("WILL count"),
            "other-category body should warn that it WILL count against the budget; got: {}",
            msg
        );
    }

    #[test]
    fn render_task_failed_prefers_snapshot_error_category() {
        // If the snapshot pre-classifies the failure (e.g. the wake
        // dispatcher already ran the real classifier), the renderer should
        // honor that and skip the local heuristic.
        let snapshot = json!({
            "milestones": [
                {
                    "id": "m1",
                    "tasks": [
                        {
                            "id": "task-pre",
                            "title": "Pre-classified failure",
                            "agentConfigId": "claude-code",
                            "description": "Whatever.",
                            "replanCount": 0,
                            "errorCategory": "rate_limit",
                            "result": {
                                "exitCode": 1,
                                // Note: error text would heuristically
                                // classify as 'other'; the explicit field
                                // should win.
                                "errors": ["weird internal failure"]
                            }
                        }
                    ]
                }
            ]
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-pre".to_string()),
            "",
            &snapshot,
        );
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("rate_limit"),
            "should honor the snapshot's errorCategory over the heuristic; got: {}",
            msg
        );
        assert!(
            msg.contains("does NOT count"),
            "rate_limit override should still mark the failure as exempt; got: {}",
            msg
        );
    }

    #[test]
    fn render_task_failed_uses_snapshot_replan_exempt_field_when_present() {
        // When the wake dispatcher pre-classifies via
        // `core::error_classifier`, it writes BOTH `errorCategory` and
        // `replanExempt` onto the task. The renderer should honor the
        // explicit boolean rather than re-deriving exemption from the
        // category string — this is the contract that keeps the prompt
        // wording aligned with `replan_after_failure.rs`'s counter
        // behavior.
        let snapshot = json!({
            "task": {
                "id": "task-pre-exempt",
                "title": "Pre-classified exempt failure",
                "agentConfigId": "claude-code",
                "description": "Whatever.",
                "replanCount": 0,
                // Category that the renderer's quick_classify would
                // otherwise call "other" (and therefore NOT exempt).
                "errorCategory": "timeout",
                // Explicit boolean wins.
                "replanExempt": true,
                "result": {
                    "exitCode": 1,
                    "errors": ["weird internal failure"]
                }
            }
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-pre-exempt".to_string()),
            "",
            &snapshot,
        );
        assert!(
            msg.contains("does NOT count"),
            "explicit replanExempt=true should mark the failure as exempt; got: {}",
            msg
        );
        assert!(
            msg.contains("FREE") || msg.contains("free"),
            "exempt body should explain replan is free; got: {}",
            msg
        );
        assert!(
            !msg.contains("WILL count"),
            "exempt body should NOT say WILL count; got: {}",
            msg
        );
    }

    #[test]
    fn render_task_failed_treats_timeout_as_exempt() {
        // `"timeout"` is the snake_case serialization of
        // `AiErrorCategory::Timeout`, which the canonical classifier
        // (`is_replan_exempt`) treats as exempt. The renderer must agree
        // even when the snapshot only carries the category string and no
        // explicit `replanExempt` boolean.
        let snapshot = json!({
            "task": {
                "id": "task-timeout",
                "title": "Timed-out task",
                "agentConfigId": "claude-code",
                "description": "Pull dependency.",
                "replanCount": 0,
                "errorCategory": "timeout",
                "result": {
                    "exitCode": 1,
                    "errors": ["request timed out after 30s"]
                }
            }
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-timeout".to_string()),
            "",
            &snapshot,
        );
        assert!(
            msg.contains("does NOT count"),
            "timeout category should be treated as exempt; got: {}",
            msg
        );
        assert!(
            !msg.contains("WILL count"),
            "timeout category should not say WILL count; got: {}",
            msg
        );
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("timeout"),
            "body should surface the timeout category; got: {}",
            msg
        );
    }

    #[test]
    fn render_task_failed_falls_back_to_quick_classify_when_snapshot_missing_category() {
        // When the snapshot has NO `errorCategory` field, the renderer
        // falls back to its `quick_classify` heuristic over the error
        // strings. A 429 string should map to `"rate_limit"`, which is
        // exempt under the string-match fallback.
        let snapshot = json!({
            "task": {
                "id": "task-fallback",
                "title": "No pre-classification",
                "agentConfigId": "claude-code",
                "description": "Hit the upstream endpoint.",
                "replanCount": 0,
                "result": {
                    "exitCode": 1,
                    "errors": ["HTTP 429 Too Many Requests"]
                }
            }
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-fallback".to_string()),
            "",
            &snapshot,
        );
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("rate_limit"),
            "quick_classify should pick rate_limit from a 429 error; got: {}",
            msg
        );
        assert!(
            msg.contains("does NOT count"),
            "rate_limit fallback should still mark the failure as exempt; got: {}",
            msg
        );
    }

    #[test]
    fn wake_user_message_for_task_failed_handles_empty_log() {
        let msg = wake_user_message(
            &WakeTrigger::TaskFailed("task-7".to_string()),
            "",
            &json!({}),
        );
        assert!(
            msg.contains("(no log available)"),
            "should gracefully degrade when no journal tail is available; got: {}",
            msg
        );
    }

    #[test]
    fn wake_user_message_for_task_completed_lists_pending_tasks() {
        let snapshot = json!({
            "milestones": [
                {
                    "id": "m1",
                    "tasks": [
                        {
                            "id": "task-1",
                            "title": "First task",
                            "agentConfigId": "claude-code",
                            "status": "done",
                            "startedAt": 1000,
                            "completedAt": 5000,
                            "result": {
                                "summary": "Wrote three files.",
                                "filesChanged": ["a.rs", "b.rs"],
                                "durationMs": 4000
                            }
                        },
                        {
                            "id": "task-2",
                            "title": "Pending follow-up",
                            "status": "queued",
                            "createdAt": 2000
                        },
                        {
                            "id": "task-3",
                            "title": "Another waiting task",
                            "status": "pending",
                            "createdAt": 1500
                        }
                    ]
                }
            ]
        });
        let msg = wake_user_message(
            &WakeTrigger::TaskCompleted("task-1".to_string()),
            "",
            &snapshot,
        );
        assert!(msg.contains("task-1"), "should mention completed task id");
        assert!(msg.contains("First task"), "should mention completed task title");
        assert!(msg.contains("Wrote three files."), "should mention result summary");
        assert!(
            msg.contains("a.rs") && msg.contains("b.rs"),
            "should mention files changed"
        );
        assert!(
            msg.contains("Pending follow-up"),
            "should list pending task #1"
        );
        assert!(
            msg.contains("Another waiting task"),
            "should list pending task #2"
        );
        // Pending tasks are ordered oldest-first by createdAt; task-3 has
        // createdAt 1500 (older than task-2's 2000) and should come first.
        let pos3 = msg.find("Another waiting task").unwrap();
        let pos2 = msg.find("Pending follow-up").unwrap();
        assert!(
            pos3 < pos2,
            "pending tasks should be ordered oldest-first by createdAt"
        );
        assert!(
            msg.contains("complete_mission"),
            "should mention complete_mission as a possible next step"
        );
    }

    #[test]
    fn wake_user_message_for_approval_gate_includes_reason() {
        let snapshot = json!({
            "milestones": [
                { "tasks": [ { "id": "t1" }, { "id": "t2" }, { "id": "t3" } ] }
            ]
        });
        let reason = "approaching the 60-task ceiling — currently at 58";
        let msg = wake_user_message(
            &WakeTrigger::ApprovalGateReached(reason.to_string()),
            "",
            &snapshot,
        );
        assert!(
            msg.contains(reason),
            "approval-gate body should include the verbatim reason; got: {}",
            msg
        );
        assert!(
            msg.contains("request_user_approval"),
            "should direct the planner to call request_user_approval"
        );
        assert!(
            msg.contains("3/60") || msg.contains("/60"),
            "should mention task count against the 60 ceiling"
        );
    }

    #[test]
    fn wake_user_message_for_user_message_includes_verbatim_text() {
        let user_text = "Actually, please add a system-preference detection step too.";
        let msg = wake_user_message(
            &WakeTrigger::UserMessageInJournal(user_text.to_string()),
            "",
            &json!({}),
        );
        assert!(
            msg.contains(user_text),
            "user-message body must include the user's text verbatim; got: {}",
            msg
        );
        assert!(
            msg.contains("free-form user message")
                || msg.contains("resolution of approval"),
            "should include a context line"
        );
    }

    #[test]
    fn wake_user_message_for_user_message_surfaces_approval_resolution() {
        let snapshot = json!({
            "triggerPayload": {
                "approvalId": "appr-7",
                "choice": "Option B"
            }
        });
        let msg = wake_user_message(
            &WakeTrigger::UserMessageInJournal("Approval appr-7 resolved: Option B".to_string()),
            "",
            &snapshot,
        );
        assert!(
            msg.contains("resolution of approval appr-7"),
            "should label approval-resolution context; got: {}",
            msg
        );
        assert!(
            msg.contains("Option B"),
            "should include the user's choice"
        );
    }

    #[test]
    fn wake_user_message_for_collision_lists_task_ids() {
        let snapshot = json!({
            "milestones": [
                {
                    "tasks": [
                        {
                            "id": "task-a",
                            "title": "Edit settings",
                            "claimedPaths": ["src/settings.rs"]
                        },
                        {
                            "id": "task-b",
                            "title": "Refactor settings",
                            "claimedPaths": ["src/settings.rs"]
                        }
                    ]
                }
            ]
        });
        let msg = wake_user_message(
            &WakeTrigger::CollisionDetected(vec![
                "task-a".to_string(),
                "task-b".to_string(),
            ]),
            "",
            &snapshot,
        );
        assert!(msg.contains("task-a") && msg.contains("task-b"));
        assert!(
            msg.contains("src/settings.rs"),
            "collision body should include the claimed paths"
        );
        assert!(
            msg.contains("update_task") && msg.contains("mark_task_blocked"),
            "should suggest the resolution tools"
        );
    }

    #[test]
    fn wake_user_message_for_quota_exhausted_tells_planner_to_stop() {
        let msg = wake_user_message(&WakeTrigger::QuotaExhausted, "", &json!({}));
        assert!(
            msg.to_lowercase().contains("rate-limit")
                || msg.to_lowercase().contains("rate limit"),
            "quota body should mention the rate limit"
        );
        assert!(
            msg.contains("NOT call any") || msg.contains("not call"),
            "quota body should tell the planner not to call tools"
        );
    }

    #[test]
    fn wake_user_message_degrades_gracefully_on_empty_snapshot() {
        // None of the renderers should panic on a totally empty snapshot.
        for trigger in [
            WakeTrigger::Decomposition,
            WakeTrigger::TaskCompleted("t".to_string()),
            WakeTrigger::TaskFailed("t".to_string()),
            WakeTrigger::ApprovalGateReached("reason".to_string()),
            WakeTrigger::CollisionDetected(vec!["a".to_string()]),
            WakeTrigger::UserMessageInJournal("hi".to_string()),
            WakeTrigger::QuotaExhausted,
        ] {
            let msg = wake_user_message(&trigger, "", &json!({}));
            assert!(!msg.is_empty(), "body should never be empty for {:?}", trigger);
        }
    }
}

#[cfg(test)]
mod e4_content_tests {
    //! Content assertions for the spec-mode system prompt.
    //!
    //! These tests verify the planner system prompt covers the surface area
    //! the Mission Planner v1 design depends on — tool names, lifecycle
    //! states, wake-trigger kinds, async-approval semantics, replan cap, and
    //! task ceiling. We assert on key tokens (not exact wording) so the
    //! tests survive minor prompt iteration while still catching real
    //! coverage regressions.
    //!
    //! Sibling agent **E4-SYSTEM-PROMPT** owns the prompt body. These tests
    //! are the executable spec for what that body must contain.
    use super::*;

    #[test]
    fn system_prompt_mentions_every_callable_tool() {
        let p = spec_mode_system_prompt();
        for tool in &[
            "create_milestone",
            "create_task",
            "update_task",
            "mark_task_blocked",
            "replan_after_failure",
            "request_user_approval",
            "complete_mission",
        ] {
            assert!(
                p.contains(tool),
                "system prompt missing tool '{}'",
                tool
            );
        }
    }

    #[test]
    fn system_prompt_does_not_advertise_helper_planner() {
        // spawn_helper_planner is deferred to v1.1; the prompt must
        // NOT teach the model to call it.
        let p = spec_mode_system_prompt();
        // Allow a defer-disclaimer mention but reject anything that
        // implies it's currently callable.
        let lower = p.to_lowercase();
        if lower.contains("spawn_helper_planner") {
            assert!(
                lower.contains("deferred")
                    || lower.contains("v1.1")
                    || lower.contains("not available")
                    || lower.contains("unavailable"),
                "system prompt mentions spawn_helper_planner but doesn't mark it as deferred/unavailable"
            );
        }
    }

    #[test]
    fn system_prompt_documents_lifecycle_states() {
        let p = spec_mode_system_prompt().to_lowercase();
        for state in &["spec", "planning", "active", "review", "paused", "done"] {
            assert!(
                p.contains(state),
                "system prompt missing lifecycle state '{}'",
                state
            );
        }
    }

    #[test]
    fn system_prompt_documents_wake_trigger_kinds() {
        let p = spec_mode_system_prompt().to_lowercase();
        for kind in &[
            "launch",
            "task_completed",
            "task_failed",
            "approval_gate_reached",
            "collision_detected",
            "user_message_in_journal",
            "quota_exhausted",
            "compaction_resume", // E10: new wake-kind
        ] {
            assert!(
                p.contains(kind),
                "system prompt missing wake_trigger kind '{}'",
                kind
            );
        }
    }

    #[test]
    fn system_prompt_communicates_async_approval_rule() {
        let p = spec_mode_system_prompt().to_lowercase();
        // The async-return rule for request_user_approval is critical —
        // if the model thinks it should block on the answer, the whole
        // approval gate breaks.
        let has_async_marker = p.contains("async")
            || p.contains("immediate")
            || p.contains("pending_approval");
        let has_dont_block = p.contains("don't block")
            || p.contains("do not block")
            || p.contains("doesn't block")
            || p.contains("continue")
            || p.contains("keep working");
        assert!(
            has_async_marker && has_dont_block,
            "system prompt doesn't clearly communicate the async-return semantics of request_user_approval"
        );
    }

    #[test]
    fn system_prompt_communicates_replan_cap() {
        let p = spec_mode_system_prompt();
        // Replan cap of 3 — model must escalate after that
        assert!(p.contains("3"), "system prompt missing replan cap of 3");
    }

    #[test]
    fn system_prompt_communicates_task_ceiling() {
        let p = spec_mode_system_prompt();
        assert!(p.contains("60"), "system prompt missing task ceiling of 60");
    }

    #[test]
    fn system_prompt_is_substantial() {
        let p = spec_mode_system_prompt();
        // Sanity floor: the placeholder was ~50 chars. The real prompt
        // should be at least 2000 chars (~ 300 tokens, very modest).
        assert!(
            p.len() >= 2000,
            "system prompt is suspiciously short ({} chars)",
            p.len()
        );
    }

    #[test]
    fn system_prompt_marks_complete_mission_as_terminal() {
        let p = spec_mode_system_prompt().to_lowercase();
        let has_complete = p.contains("complete_mission");
        let has_terminal_ish = p.contains("terminal")
            || p.contains("only when all milestones")
            || p.contains("final");
        assert!(
            has_complete && has_terminal_ish,
            "system prompt should mark complete_mission as terminal / final"
        );
    }
}

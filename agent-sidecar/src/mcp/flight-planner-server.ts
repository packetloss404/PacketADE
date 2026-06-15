// Flight Planner — in-process MCP server (E2).
//
// Constructed inside the sidecar (live `McpServer` instances cannot cross
// the stdio wire) and merged into the Claude Agent SDK's `mcpServers` map
// under the pinned key `"planner"`. With that key, the SDK exposes each
// tool as `mcp__planner__<toolName>`, matching the `allowedTools` list the
// Rust supervisor pins for planner sessions.
//
// E1 shipped a single stub tool (`noop`) that proved the wire round-trip.
// E2 layers the seven real Flight Planner tools on top:
//
//   1. create_milestone         — phase-level work bucket
//   2. create_task              — executable unit inside a milestone
//   3. update_task              — mutate task fields (status guarded)
//   4. mark_task_blocked        — soft-stop a task with a reason
//   5. replan_after_failure     — ack a failure and request retry budget
//   6. request_user_approval    — async question (returns pending sentinel)
//   7. complete_flight         — final summary, stops wake-triggers
//
// `noop` is kept for back-compat with the existing E1 smoke harness.
// `spawn_helper_planner` is intentionally NOT exposed in v1 — it is
// deferred to v1.1 per the locked plan.
//
// Every tool body has the SAME shape: emit a `planner_tool` envelope up
// to the Rust supervisor (via the `emit` callback wired in by
// `providers/anthropic.ts`), await the typed `planner_tool_result`, and
// forward the resolved value back to the SDK as a single `text` content
// block. The supervisor is the single source of truth for actual state
// mutation; the sidecar does NOT interpret tool args or results.
//
// See:
//   - dev/flight-planner-plan.md
//   - dev/flight-planner-spike-retro.md
//   - agent-sidecar/test/mcp-inproc-smoke.mjs

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PlannerToolCallEvent } from "../protocol.js";

/**
 * Pinned record key under which the planner server is registered with the
 * SDK. Tool names therefore read `mcp__planner__<toolName>`. Locked per
 * spike #1 findings — do not change without updating the Rust supervisor's
 * `allowedTools` list at the same time.
 */
export const PLANNER_MCP_KEY = "planner";

/**
 * Emit callback contract used by the planner server to surface a
 * `planner_tool` envelope and await a `planner_tool_result` from the Rust
 * supervisor. `args` is whatever the model passed (zod-validated by the
 * SDK before reaching the handler); the resolved value becomes the tool's
 * `content` array. A rejection surfaces as a tool error to the model.
 *
 * Wired up by `providers/anthropic.ts::dispatchPlannerTool`. The sidecar
 * has no opinion on what `result` looks like beyond "JSON-serializable".
 */
export type PlannerToolEmit = (event: PlannerToolCallEvent) => Promise<unknown>;

/**
 * Wrap an in-sidecar planner tool handler so its body is a one-liner:
 * round-trip the call through `emit` (which awaits the Rust dispatcher's
 * `planner_tool_result`) and forward whatever the dispatcher produced as
 * the tool's `content`. The supervisor is the single source of truth for
 * the result payload — the sidecar does NOT interpret it.
 */
function bridgeResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const text =
    typeof result === "string"
      ? result
      : (() => {
          try {
            return JSON.stringify(result ?? null);
          } catch {
            return String(result);
          }
        })();
  return { content: [{ type: "text", text }] };
}

function makeCallId(sessionId: string): string {
  // sessionId scopes the prefix so a sidecar serving multiple planner
  // sessions can't accidentally collide; the random suffix keeps the
  // values unique within a session even under concurrent tool calls.
  const rand = Math.random().toString(36).slice(2, 10);
  const t = Date.now().toString(36);
  return `pl-${sessionId}-${t}-${rand}`;
}

// ---------------------------------------------------------------------------
// Zod schemas for the 7 real planner tools (+ noop). The Rust dispatcher
// re-validates anything it cares about strictly (e.g. status enum, target
// spec shape); these schemas are the first line of defence and what Claude
// sees when picking arguments.
// ---------------------------------------------------------------------------

const createMilestoneSchema = z.object({
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(1000),
  dependencies: z.array(z.string()).optional(),
});

const createTaskSchema = z.object({
  milestone_id: z.string(),
  title: z.string().min(1).max(160),
  prompt: z.string().min(1),
  agent_id: z.string(),
  // AttemptTargetSpec is a tagged union (local worktree vs SSH host) with
  // nested optional fields — too sprawling for a tight zod schema without
  // duplicating the Rust DTO. The Rust dispatcher validates it strictly;
  // we let unknown through and surface the parse error as a tool failure
  // if the model gets it wrong.
  target_spec: z.unknown(),
});

const updateTaskSchema = z.object({
  task_id: z.string(),
  // Zod 4: z.record requires both key and value schemas. Patch keys are
  // model-supplied field names (string), values are arbitrary — the Rust
  // dispatcher validates each accepted key strictly.
  patch: z.record(z.string(), z.unknown()),
});

const markTaskBlockedSchema = z.object({
  task_id: z.string(),
  reason: z.string().min(1).max(500),
});

const replanAfterFailureSchema = z.object({
  task_id: z.string(),
});

const requestUserApprovalSchema = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string()).max(6).optional(),
});

const completeFlightSchema = z.object({
  summary: z.string().min(1).max(2000),
});

const noopSchema = z.object({
  message: z.string().describe("Free-form text echoed via the host."),
});

/**
 * Build the in-process Flight Planner MCP server. Returns a config object
 * shaped for the SDK's `mcpServers` map; the caller plugs it in under
 * `PLANNER_MCP_KEY`.
 *
 * `emit` is invoked once per tool call. The sidecar awaits the returned
 * promise — the supervisor must resolve/reject via a `planner_tool_result`
 * envelope keyed by `callId` for the model's tool call to make progress.
 */
export function createFlightPlannerMcpServer(
  sessionId: string,
  emit: PlannerToolEmit,
): McpSdkServerConfigWithInstance {
  // Every handler below is intentionally identical in shape: build a
  // correlation id, emit the envelope, await the supervisor's typed reply,
  // bridge the result into an SDK content block. The Rust side owns all
  // semantics — status transitions, dependency validation, budget caps,
  // approval id generation, etc.
  async function dispatch(
    toolName: PlannerToolCallEvent["tool"],
    args: unknown,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const callId = makeCallId(sessionId);
    const result = await emit({
      type: "planner_tool",
      sessionId,
      tool: toolName,
      args,
      callId,
    });
    return bridgeResult(result);
  }

  const createMilestone = tool(
    "create_milestone",
    [
      "Create a new milestone on this flight. Use one milestone per coherent",
      "phase of work (for example: 'Schema migration', 'Frontend rewrite',",
      "'Wire e2e tests'). `dependencies` are other milestoneIds that must",
      "complete before tasks in this milestone are eligible to run.",
      "Returns the created milestoneId for use in subsequent create_task calls.",
    ].join(" "),
    createMilestoneSchema.shape,
    async (args) => dispatch("create_milestone", args),
  );

  const createTask = tool(
    "create_task",
    [
      "Create a task within a milestone. The prompt is the verbatim",
      "instruction the executor agent will receive — write it as if you were",
      "the human handing the work off. `agent_id` is one of the installed",
      "agent ids (for example `claude-code`, `claude-oauth`).",
      "`target_spec` describes where the agent runs (local worktree or SSH",
      "host) — pass the AttemptTargetSpec shape the user-configured executors",
      "expect. Returns the created taskId.",
    ].join(" "),
    createTaskSchema.shape,
    async (args) => dispatch("create_task", args),
  );

  const updateTask = tool(
    "update_task",
    [
      "Update fields on an existing task. Patch keys may include: title,",
      "prompt, agent_id, target_spec, status (only set to 'cancelled' or",
      "'queued' — other status transitions are owned by the executor).",
      "target_spec is accepted for forward compatibility but may be returned",
      "in deferred_fields when it could not be persisted; treat that retarget",
      "as not landed. To",
      "mark a task blocked use mark_task_blocked instead. Unknown patch",
      "keys are silently dropped (with a warning) — only whitelisted keys mutate.",
    ].join(" "),
    updateTaskSchema.shape,
    async (args) => dispatch("update_task", args),
  );

  const markTaskBlocked = tool(
    "mark_task_blocked",
    [
      "Block a task that cannot proceed. The reason is shown to the user",
      "and stored on the task. Blocked tasks do NOT consume an executor",
      "slot, so prefer this over leaving a task spinning. Use",
      "replan_after_failure instead when you intend to retry with a new",
      "approach.",
    ].join(" "),
    markTaskBlockedSchema.shape,
    async (args) => dispatch("mark_task_blocked", args),
  );

  const replanAfterFailure = tool(
    "replan_after_failure",
    [
      "Acknowledge a failed task and signal that you'll create replacement",
      "tasks. Returns a parent_milestone_id you should pass to subsequent",
      "create_task calls in the same turn. Replans per task are capped",
      "(see E6 safety rails); RateLimit and Network errors do NOT count",
      "against the cap.",
    ].join(" "),
    replanAfterFailureSchema.shape,
    async (args) => dispatch("replan_after_failure", args),
  );

  const requestUserApproval = tool(
    "request_user_approval",
    [
      "Ask the user for a decision when the planner needs human input.",
      "Returns IMMEDIATELY with a `pending_approval:<id>` sentinel — do NOT",
      "wait or assume an answer in this turn. Continue working on parallel",
      "tasks; the user's answer arrives later as a fresh wake-trigger.",
      "Provide `options` when the answer is multiple-choice (max 6).",
    ].join(" "),
    requestUserApprovalSchema.shape,
    async (args) => dispatch("request_user_approval", args),
  );

  const completeFlight = tool(
    "complete_flight",
    [
      "Mark the flight complete. Use only when all milestones are done and",
      "no further work is planned. Writes a final summary to the journal",
      "and stops further wake-triggers for this flight. Irreversible from",
      "the planner side — the user can reopen via the UI if needed.",
    ].join(" "),
    completeFlightSchema.shape,
    async (args) => dispatch("complete_flight", args),
  );

  // Back-compat smoke tool. Kept so the E1 mcp-inproc-smoke.mjs harness
  // keeps passing across Wave 2 and beyond. The planner system prompt
  // should NOT advertise this tool — the description tells the model not
  // to call it during real work.
  const noop = tool(
    "noop",
    [
      "Internal smoke-test tool. Echoes the message argument back via the",
      "host. You should NOT call this during normal flight work — use the",
      "real planner tools (create_milestone, create_task, etc.) instead.",
    ].join(" "),
    noopSchema.shape,
    async (args) => dispatch("noop", args),
  );

  return createSdkMcpServer({
    name: "flight-planner",
    version: "0.2.0",
    tools: [
      createMilestone,
      createTask,
      updateTask,
      markTaskBlocked,
      replanAfterFailure,
      requestUserApproval,
      completeFlight,
      noop,
    ],
  });
}

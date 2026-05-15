// Mission Planner — in-process MCP server (E1 scaffold).
//
// Constructed inside the sidecar (live `McpServer` instances cannot cross
// the stdio wire) and merged into the Claude Agent SDK's `mcpServers` map
// under the pinned key `"planner"`. With that key, the SDK exposes each
// tool as `mcp__planner__<toolName>`, matching the `allowedTools` list the
// Rust supervisor pins for planner sessions.
//
// E1 ships a single stub tool — `noop` — whose only job is to round-trip
// a `planner_tool` event up to the Rust supervisor, prove the await/correlate
// pipeline works end-to-end, and unblock E2 (which lands the eight real
// planner tools: `create_milestone`, `create_task`, `update_task`,
// `mark_task_blocked`, `replan_after_failure`, `request_user_approval`,
// `spawn_helper_planner`, `complete_mission`).
//
// See:
//   - dev/mission-planner-plan.md
//   - dev/mission-planner-spike-retro.md
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
 * E2 will widen the handlers; the contract stays the same.
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

/**
 * Build the in-process Mission Planner MCP server. Returns a config object
 * shaped for the SDK's `mcpServers` map; the caller plugs it in under
 * `PLANNER_MCP_KEY`.
 *
 * `emit` is invoked once per tool call. The sidecar awaits the returned
 * promise — the supervisor must resolve/reject via a `planner_tool_result`
 * envelope keyed by `callId` for the model's tool call to make progress.
 */
export function createMissionPlannerMcpServer(
  sessionId: string,
  emit: PlannerToolEmit,
): McpSdkServerConfigWithInstance {
  // E1: one stub tool. Just enough to verify the wire round-trip.
  const noop = tool(
    "noop",
    [
      "Stub planner tool used during E1 scaffolding. Calls the host with",
      "the supplied message and returns whatever the host produces. Real",
      "planner tools (create_milestone, create_task, etc.) ship in E2.",
    ].join(" "),
    { message: z.string().describe("Free-form text echoed via the host.") },
    async (args) => {
      const callId = makeCallId(sessionId);
      const result = await emit({
        type: "planner_tool",
        sessionId,
        tool: "noop",
        args,
        callId,
      });
      return bridgeResult(result);
    },
  );

  return createSdkMcpServer({
    name: "mission-planner",
    version: "0.1.0",
    tools: [noop],
  });
}

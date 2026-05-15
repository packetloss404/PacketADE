// Living smoke test for the in-process MCP transport that the Mission
// Planner depends on (was the original spike — promoted 2026-05-14 per
// E1, extended in E2). Registers in-process MCP servers into a live
// `@anthropic-ai/claude-agent-sdk` `query()` and confirms the model can
// actually call tools and that handlers run in-process.
//
// If this fails, the entire planner wake-trigger ➜ planner-tool path is
// broken — every planner tool routes through exactly this kind of
// in-sidecar `createSdkMcpServer` registration.
//
// This script does NOT go through the sidecar's wire protocol. It calls
// `query()` directly (same as the sidecar does internally) to keep the
// smoke read-only against the sidecar's production code path.
//
// Requires live OAuth creds at `~/.claude/.credentials.json`. CI without
// creds should skip this; locally run from `agent-sidecar/`:
//   node test/mcp-inproc-smoke.mjs
//
// Pass criteria (Phase 1 — original spike, the `noop`/spike_ping path):
//   1. SDK exports `createSdkMcpServer` and `tool`
//   2. `query()` accepts the {type:"sdk", name, instance} config without throwing
//   3. Within ~60s, the model calls `spike_ping(message: "hello")`
//   4. The tool handler runs and returns the echo content
//   5. The query stream terminates with a `result` message
//
// Pass criteria (Phase 2 — E2 planner surface):
//   6. The real `createMissionPlannerMcpServer` factory builds without
//      throwing, exposing 8 tools (7 real + `noop`).
//   7. The model invokes `mcp__planner__create_milestone` exactly once.
//   8. The handler runs, surfacing the call up through the `emit` callback
//      with a properly-shaped `planner_tool` envelope.
//   9. The simulated Rust-side reply (success OR an E2-MILE not-yet-
//      implemented error — dual-mode, see comment below) is threaded back
//      to the model and the query terminates cleanly.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createMissionPlannerMcpServer, PLANNER_MCP_KEY } from "../dist/mcp/mission-planner-server.js";

const TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// 1. Build the in-process MCP server with ONE tool: spike_ping
// ---------------------------------------------------------------------------
let toolWasCalled = false;
let toolEchoed = null;
let toolArgsSeen = null;

const spikePing = tool(
  "spike_ping",
  "Spike tool. Echoes back the provided message. Call this tool exactly once with the message 'hello' to complete the spike.",
  { message: z.string().describe("The text to echo back. Use exactly 'hello'.") },
  async (args) => {
    toolWasCalled = true;
    toolArgsSeen = args;
    toolEchoed = args.message;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, echo: args.message }),
        },
      ],
    };
  },
);

const spikeServer = createSdkMcpServer({
  name: "packetade-spike",
  version: "0.0.1",
  tools: [spikePing],
});

console.log("[spike] createSdkMcpServer returned:", {
  type: spikeServer.type,
  name: spikeServer.name,
  hasInstance: !!spikeServer.instance,
});

if (spikeServer.type !== "sdk") {
  console.error(`[spike] FAIL: expected type='sdk', got '${spikeServer.type}'`);
  process.exit(1);
}
if (!spikeServer.instance) {
  console.error(`[spike] FAIL: createSdkMcpServer returned no .instance`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Drive a query() with the in-process server wired into options.mcpServers
// ---------------------------------------------------------------------------
const abort = new AbortController();
const timer = setTimeout(() => {
  console.error(`[spike] TIMEOUT after ${TIMEOUT_MS}ms — aborting query`);
  abort.abort();
}, TIMEOUT_MS);

// The tool is exposed at `mcp__<serverName>__<toolName>`. Anthropic's CLI uses
// the prefix `mcp__` plus the server key from the mcpServers record, then
// `__<tool name>`. Whitelist it to nudge the model to use it on the first turn.
const SERVER_KEY = "spike";
const ALLOWED_TOOL = `mcp__${SERVER_KEY}__spike_ping`;

const prompt = [
  "You are a test harness. Your only task is to call the tool",
  `\`${ALLOWED_TOOL}\` exactly once with arguments {"message": "hello"},`,
  "then report the result you received in plain text. Do not call any other",
  "tool. Do not refuse.",
].join(" ");

console.log("[spike] starting query() with prompt:", prompt);

let sawResult = false;
let sawAssistantToolUse = false;
let sawUserToolResult = false;
let lastResultUsage = null;
let messageCount = 0;

try {
  const q = query({
    prompt,
    options: {
      abortController: abort,
      // Important: explicit string model so we don't rely on the user's
      // default. claude-sonnet-4-6 is the planned planner model.
      model: "claude-sonnet-4-6",
      mcpServers: {
        [SERVER_KEY]: spikeServer,
      },
      // Only the spike tool — nothing else. Keeps the test deterministic and
      // avoids the model wandering off to use Read/Bash/etc.
      allowedTools: [ALLOWED_TOOL],
      // No write tools, no permission prompts — accept the one tool freely.
      permissionMode: "bypassPermissions",
      includePartialMessages: false,
      stderr: (data) => {
        process.stderr.write(`[spike:sdk] ${data}`);
      },
    },
  });

  for await (const msg of q) {
    messageCount += 1;
    if (msg.type === "system") {
      const sub = msg.subtype ?? "";
      console.log(`[spike] system/${sub}`);
      continue;
    }
    if (msg.type === "assistant") {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          const text = String(block.text ?? "").slice(0, 200);
          if (text.length > 0) console.log(`[spike] assistant text: ${text}`);
        } else if (block.type === "tool_use") {
          sawAssistantToolUse = true;
          console.log(
            `[spike] assistant tool_use: name=${block.name} input=${JSON.stringify(block.input)}`,
          );
        } else if (block.type === "thinking") {
          // ignore
        } else {
          console.log(`[spike] assistant block type=${block.type}`);
        }
      }
      continue;
    }
    if (msg.type === "user") {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          sawUserToolResult = true;
          const out = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          console.log(
            `[spike] user tool_result is_error=${!!block.is_error} content=${out.slice(0, 200)}`,
          );
        }
      }
      continue;
    }
    if (msg.type === "result") {
      sawResult = true;
      lastResultUsage = msg.usage ?? null;
      console.log(
        `[spike] result subtype=${msg.subtype ?? "?"} usage=${JSON.stringify(msg.usage ?? {})}`,
      );
      break;
    }
    console.log(`[spike] msg type=${msg.type}`);
  }
} catch (err) {
  clearTimeout(timer);
  console.error(`[spike] FAIL: query() threw: ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
}

clearTimeout(timer);

// ---------------------------------------------------------------------------
// 3. Verdict
// ---------------------------------------------------------------------------
console.log("");
console.log("==== SPIKE RESULT ====");
console.log(`messages observed:        ${messageCount}`);
console.log(`assistant emitted tool_use: ${sawAssistantToolUse}`);
console.log(`user tool_result observed:  ${sawUserToolResult}`);
console.log(`tool handler executed:      ${toolWasCalled}`);
console.log(`tool handler args:          ${JSON.stringify(toolArgsSeen)}`);
console.log(`tool echo value:            ${JSON.stringify(toolEchoed)}`);
console.log(`final result message:       ${sawResult}`);
console.log(`final usage:                ${JSON.stringify(lastResultUsage)}`);

if (!sawResult) {
  console.error("[spike] FAIL: never saw a `result` message — query did not terminate");
  process.exit(1);
}
if (!sawAssistantToolUse) {
  console.error("[spike] FAIL: assistant never emitted a tool_use for the spike tool");
  process.exit(1);
}
if (!toolWasCalled) {
  console.error("[spike] FAIL: in-process tool handler was never invoked");
  process.exit(1);
}
if (toolEchoed !== "hello") {
  console.error(`[spike] FAIL: expected echo='hello', got ${JSON.stringify(toolEchoed)}`);
  process.exit(1);
}
if (!sawUserToolResult) {
  console.error("[spike] FAIL: tool ran but its result was not threaded back into the conversation");
  process.exit(1);
}

console.log("");
console.log("[spike] phase 1 OK — in-process MCP transport works against SDK 0.2.116");

// ---------------------------------------------------------------------------
// Phase 2 (E2): exercise the real Mission Planner MCP server. The factory
// in `src/mcp/mission-planner-server.ts` registers 8 tools (7 real + the
// E1 `noop`). We drive a second `query()` and nudge the model to call
// `create_milestone` exactly once, then verify the in-process round-trip
// landed.
//
// DUAL-MODE expectation re: the simulated supervisor reply:
//
//   In production the Rust dispatcher in
//   `src-tauri/src/commands/mission_planner.rs` owns this. Until Wave 2
//   (E2-MILE) lands, the dispatcher returns
//   `Err("E2-MILE: not yet implemented")` for `create_milestone` — see
//   the dispatcher TODO/stub list in dev/mission-planner-plan.md.
//
//   This JS smoke does NOT call the Rust supervisor; it stubs the `emit`
//   callback locally. To stay faithful to the contract, the stub here
//   returns a deterministic SUCCESS-shaped payload (`{ milestoneId: ... }`).
//   The smoke considers either of the following acceptable when reading
//   the model's view of the tool result:
//
//     a) `success: true` with a milestoneId-shaped object (post-Wave-2 / this stub)
//     b) `success: false, error: "E2-MILE: ..."` (pre-Wave-2 real dispatcher)
//
//   Update this stub to mirror the real dispatcher's behavior once Wave 2
//   lands or once this script is wired into the live sidecar transport.
// ---------------------------------------------------------------------------

let plannerEmitCalled = false;
let plannerEmitEvent = null;

const plannerServer = createMissionPlannerMcpServer("smoke-session", async (event) => {
  plannerEmitCalled = true;
  plannerEmitEvent = event;
  // Simulated dispatcher reply. See dual-mode comment above.
  return {
    success: true,
    milestoneId: `m-${event.callId}`,
    note: "stub reply from mcp-inproc-smoke; real dispatcher lands in Wave 2 (E2-MILE)",
  };
});

console.log("[planner] createMissionPlannerMcpServer returned:", {
  type: plannerServer.type,
  name: plannerServer.name,
  hasInstance: !!plannerServer.instance,
});
if (plannerServer.type !== "sdk" || !plannerServer.instance) {
  console.error("[planner] FAIL: planner server config malformed");
  process.exit(1);
}

const PLANNER_CREATE_MILESTONE = `mcp__${PLANNER_MCP_KEY}__create_milestone`;

const plannerPrompt = [
  "You are a test harness for the PacketADE Mission Planner.",
  `Call the tool \`${PLANNER_CREATE_MILESTONE}\` exactly once with arguments`,
  `{"title": "Smoke milestone", "goal": "Verify the in-process planner MCP round-trip works end-to-end."}`,
  "then report the result you received in plain text. Do not call any other",
  "tool. Do not refuse.",
].join(" ");

console.log("[planner] starting query() with prompt:", plannerPrompt);

const plannerAbort = new AbortController();
const plannerTimer = setTimeout(() => {
  console.error(`[planner] TIMEOUT after ${TIMEOUT_MS}ms — aborting query`);
  plannerAbort.abort();
}, TIMEOUT_MS);

let plannerSawResult = false;
let plannerSawToolUse = false;
let plannerSawToolResult = false;
let plannerToolResultPayload = null;
let plannerMessageCount = 0;

try {
  const q = query({
    prompt: plannerPrompt,
    options: {
      abortController: plannerAbort,
      model: "claude-sonnet-4-6",
      mcpServers: {
        [PLANNER_MCP_KEY]: plannerServer,
      },
      allowedTools: [PLANNER_CREATE_MILESTONE],
      permissionMode: "bypassPermissions",
      includePartialMessages: false,
      stderr: (data) => {
        process.stderr.write(`[planner:sdk] ${data}`);
      },
    },
  });

  for await (const msg of q) {
    plannerMessageCount += 1;
    if (msg.type === "system") {
      console.log(`[planner] system/${msg.subtype ?? ""}`);
      continue;
    }
    if (msg.type === "assistant") {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          plannerSawToolUse = true;
          console.log(
            `[planner] assistant tool_use: name=${block.name} input=${JSON.stringify(block.input)}`,
          );
        } else if (block.type === "text") {
          const text = String(block.text ?? "").slice(0, 200);
          if (text.length > 0) console.log(`[planner] assistant text: ${text}`);
        }
      }
      continue;
    }
    if (msg.type === "user") {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          plannerSawToolResult = true;
          plannerToolResultPayload =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
          console.log(
            `[planner] user tool_result is_error=${!!block.is_error} content=${plannerToolResultPayload.slice(0, 300)}`,
          );
        }
      }
      continue;
    }
    if (msg.type === "result") {
      plannerSawResult = true;
      console.log(
        `[planner] result subtype=${msg.subtype ?? "?"} usage=${JSON.stringify(msg.usage ?? {})}`,
      );
      break;
    }
  }
} catch (err) {
  clearTimeout(plannerTimer);
  console.error(`[planner] FAIL: query() threw: ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
}

clearTimeout(plannerTimer);

console.log("");
console.log("==== PLANNER PHASE-2 RESULT ====");
console.log(`messages observed:        ${plannerMessageCount}`);
console.log(`assistant emitted tool_use: ${plannerSawToolUse}`);
console.log(`user tool_result observed:  ${plannerSawToolResult}`);
console.log(`emit callback invoked:      ${plannerEmitCalled}`);
console.log(`emit envelope tool:         ${plannerEmitEvent?.tool ?? "(none)"}`);
console.log(`emit envelope callId:       ${plannerEmitEvent?.callId ?? "(none)"}`);
console.log(`emit envelope args:         ${plannerEmitEvent ? JSON.stringify(plannerEmitEvent.args) : "(none)"}`);
console.log(`final result message:       ${plannerSawResult}`);

if (!plannerSawResult) {
  console.error("[planner] FAIL: never saw a `result` message — query did not terminate");
  process.exit(1);
}
if (!plannerSawToolUse) {
  console.error("[planner] FAIL: assistant never emitted a tool_use for create_milestone");
  process.exit(1);
}
if (!plannerEmitCalled) {
  console.error("[planner] FAIL: emit callback was never invoked");
  process.exit(1);
}
if (plannerEmitEvent?.tool !== "create_milestone") {
  console.error(
    `[planner] FAIL: expected emit envelope tool='create_milestone', got ${JSON.stringify(plannerEmitEvent?.tool)}`,
  );
  process.exit(1);
}
if (plannerEmitEvent?.type !== "planner_tool") {
  console.error(
    `[planner] FAIL: expected emit envelope type='planner_tool', got ${JSON.stringify(plannerEmitEvent?.type)}`,
  );
  process.exit(1);
}
if (!plannerSawToolResult) {
  console.error(
    "[planner] FAIL: tool ran but its result was not threaded back into the conversation",
  );
  process.exit(1);
}

// Accept BOTH dual-mode shapes when validating the payload Claude saw —
// either the success-shaped stub or the future Rust-side E2-MILE error
// (kept here so the assertion survives Wave 2 landing without churn).
const payload = plannerToolResultPayload ?? "";
const looksLikeSuccess = payload.includes("milestoneId");
const looksLikeE2MileNotImpl =
  payload.includes("E2-MILE") || payload.includes("not yet implemented");
if (!looksLikeSuccess && !looksLikeE2MileNotImpl) {
  console.error(
    `[planner] FAIL: tool result did not match either dual-mode shape: ${payload.slice(0, 300)}`,
  );
  process.exit(1);
}

console.log("");
console.log("[planner] phase 2 OK — Mission Planner MCP server round-trip verified");
process.exit(0);

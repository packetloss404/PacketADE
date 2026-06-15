// Flight Planner wiring smoke test (Task #15 — automated wire-check).
//
// Goal
// ----
// Prove the end-to-end planner wiring is intact without burning Anthropic
// OAuth quota: factory → in-process MCP server → tool handler → emit envelope
// → response-await → bridged SDK content block. No live model call, runs
// fully offline in a few seconds.
//
// What this DOES verify (and why)
// -------------------------------
// 1. The `createFlightPlannerMcpServer` factory builds without throwing and
//    returns an `McpSdkServerConfigWithInstance` with `type === "sdk"` and a
//    live `instance`. (Regression: E1 — mcpKind="planner" path won't merge
//    into the SDK's `mcpServers` map if the factory returns the wrong shape.)
//
// 2. All 8 expected planner tools register with the SDK-wrapped McpServer:
//    create_milestone, create_task, update_task, mark_task_blocked,
//    replan_after_failure, request_user_approval, complete_flight, plus the
//    back-compat `noop`. (Regression: E2-DISP — silent tool-list drift would
//    let a renamed/removed tool ship undetected; the Rust dispatcher's tool
//    name match would then fail at runtime.)
//
// 3. Driving the `create_milestone` handler emits a well-formed `planner_tool`
//    envelope on the supplied `emit` callback with the right `tool` name,
//    `sessionId`, a non-empty `callId`, and the verbatim args. (Regression:
//    E2-DISP — wrong DTO shape would slip past the Rust dispatcher's
//    `serde_json::from_value` and surface as a "create_milestone produces
//    wrong DTO shape" failure once the planner actually fires.)
//
// 4. Driving the `create_task` handler emits a well-formed envelope with the
//    full `target_spec` and `agent_id` fields the Rust dispatcher needs.
//    (Regression: E2-DISP — same as #3, but the larger argument surface here
//    is where shape drift bites hardest.)
//
// 5. Sequential tool calls round-trip cleanly: each call's emit promise
//    resolves to a result, the result is bridged into the SDK content block,
//    and the next call proceeds without deadlock. (Regression: E1 pump-fix —
//    when the SDK message iterator breaks out early on a `result`, planner
//    sessions silently kill multi-turn chat AND the wake-trigger pipeline.
//    The exact symptom in this test would be the second emit promise never
//    resolving / the test timing out.)
//
// 6. An emit rejection surfaces as a thrown error from the handler, exactly
//    as the SDK would surface a `tool_result is_error=true` to the model.
//    (Regression: E2-DISP — silently swallowing Rust-side dispatcher errors
//    would let the planner think a failed `create_task` succeeded and chain
//    follow-up calls against a fictional taskId.)
//
// 7. The MCP key constant `PLANNER_MCP_KEY` exported from the factory equals
//    the pinned literal "planner". The Rust supervisor's `allowedTools` list
//    is built from this key (`mcp__planner__*`); a rename here without a
//    matching Rust edit would silently strip every planner tool from the
//    allowedTools whitelist. (Regression: E1 — mcpKind="planner" doesn't
//    register the in-process MCP server under the pinned key.)
//
// What this does NOT cover (deliberately, see report)
// ---------------------------------------------------
// - Tauri AppHandle / `FlightPlannerRegistry` state mutation. That needs a
//   Rust integration test (Option B), which the task brief explicitly allows
//   us to drop into Option A when the Tauri test mocks aren't usable.
// - The wake-trigger inject path through the Anthropic provider's
//   PushableAsyncIterable. The provider-level test against a real Anthropic
//   session is the existing `mcp-inproc-smoke.mjs` (live-OAuth-gated).
// - The Tauri event emission for `flight-planner:milestone-created:<id>`.
//   Same reason as above — needs a live AppHandle.
//
// We get a CI-runnable, offline, deterministic regression check on the layer
// most likely to silently break: the in-process MCP server contract between
// the sidecar's planner factory and the Rust supervisor's dispatcher.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = "wiring-smoke-session";
const STEP_TIMEOUT_MS = 3000;

const distFactory = resolve(
  __dirname,
  "..",
  "dist",
  "mcp",
  "flight-planner-server.js",
);

if (!existsSync(distFactory)) {
  console.error(
    `[planner-wiring] sidecar dist not found at ${distFactory}`,
  );
  console.error(
    `[planner-wiring] run 'pnpm sidecar:install && pnpm sidecar:build' first`,
  );
  process.exit(1);
}

const { createFlightPlannerMcpServer, PLANNER_MCP_KEY } = await import(
  // file:// URL prevents Windows backslash drama in the dynamic import.
  new URL(`file://${distFactory.replace(/\\/g, "/")}`).href
);

// ---------------------------------------------------------------------------
// Test framework — tiny so we don't need a dep.
// ---------------------------------------------------------------------------

let failed = 0;
const passed = [];
function pass(step) {
  passed.push(step);
  console.log(`[planner-wiring] PASS: ${step}`);
}
function fail(step, reason) {
  failed += 1;
  console.error(`[planner-wiring] FAIL at '${step}': ${reason}`);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => {
      rejectFn(new Error(`timed out after ${ms}ms in '${label}'`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolveFn(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectFn(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Step 1 — pinned key constant.
// Protects against: silent rename that would break the allowedTools pin on
// the Rust side ("mcp__planner__*").
// ---------------------------------------------------------------------------
if (PLANNER_MCP_KEY !== "planner") {
  fail(
    "pinned_key_constant",
    `expected PLANNER_MCP_KEY === "planner", got ${JSON.stringify(PLANNER_MCP_KEY)}`,
  );
} else {
  pass("pinned_key_constant");
}

// ---------------------------------------------------------------------------
// Step 2 — factory shape.
// Protects against: factory returning the wrong shape would cause
// mcpKind="planner" to fail registration with the SDK.
// ---------------------------------------------------------------------------
const recordedEnvelopes = [];
let scriptedReplyForNextEmit = null;
let emitShouldReject = false;

const emit = async (event) => {
  recordedEnvelopes.push(event);
  if (emitShouldReject) {
    throw new Error("scripted dispatcher rejection");
  }
  return scriptedReplyForNextEmit;
};

let plannerServer;
try {
  plannerServer = createFlightPlannerMcpServer(SESSION_ID, emit);
} catch (err) {
  fail("factory_builds", `createFlightPlannerMcpServer threw: ${err?.message ?? err}`);
}

if (plannerServer) {
  if (plannerServer.type !== "sdk") {
    fail(
      "factory_shape_type",
      `expected type === "sdk", got ${JSON.stringify(plannerServer.type)}`,
    );
  } else {
    pass("factory_shape_type");
  }
  if (!plannerServer.instance) {
    fail("factory_shape_instance", "factory returned no .instance");
  } else {
    pass("factory_shape_instance");
  }
  if (plannerServer.name !== "flight-planner") {
    fail(
      "factory_shape_name",
      `expected name === "flight-planner", got ${JSON.stringify(plannerServer.name)}`,
    );
  } else {
    pass("factory_shape_name");
  }
}

// ---------------------------------------------------------------------------
// Step 3 — all 8 expected tools registered.
// Protects against: a tool removed/renamed in the factory would silently break
// the Rust dispatcher's name-match arm.
// ---------------------------------------------------------------------------
const EXPECTED_TOOLS = [
  "create_milestone",
  "create_task",
  "update_task",
  "mark_task_blocked",
  "replan_after_failure",
  "request_user_approval",
  "complete_flight",
  "noop", // back-compat smoke fixture, intentionally kept
];

let registered = null;
if (plannerServer?.instance) {
  registered = plannerServer.instance._registeredTools;
  if (!registered || typeof registered !== "object") {
    fail(
      "tools_registered_map",
      `expected _registeredTools object, got ${typeof registered}`,
    );
  } else {
    pass("tools_registered_map");
  }
}

if (registered) {
  const actualNames = Object.keys(registered).sort();
  const expectedNames = [...EXPECTED_TOOLS].sort();
  const missing = expectedNames.filter((n) => !actualNames.includes(n));
  const extra = actualNames.filter((n) => !expectedNames.includes(n));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      "tools_registered_set",
      `tool set drift — missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    );
  } else {
    pass("tools_registered_set");
  }
}

// ---------------------------------------------------------------------------
// Helper — invoke a registered tool handler directly, the same way the MCP
// SDK does in `executeToolHandler` (mcp.js:211): `handler(args, extra)`.
// We pass a minimal `extra` shape with a non-aborted signal so any
// signal-listening tool body doesn't crash. The Flight Planner handlers
// don't read `extra`, but a future change might.
// ---------------------------------------------------------------------------
async function invokeTool(name, args) {
  const tool = registered[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  const handler = tool.handler;
  const extra = {
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  };
  return await handler(args, extra);
}

// ---------------------------------------------------------------------------
// Step 4 — `create_milestone` emits a well-formed envelope.
// Protects against: E2-DISP regression where the envelope ships with the
// wrong `tool` string, sessionId, or args shape.
// ---------------------------------------------------------------------------
if (registered) {
  recordedEnvelopes.length = 0;
  scriptedReplyForNextEmit = {
    success: true,
    milestoneId: "m-fake-001",
  };
  try {
    const result = await withTimeout(
      invokeTool("create_milestone", {
        title: "Wire-up smoke milestone",
        goal: "Prove the envelope round-trips cleanly without a live model.",
      }),
      STEP_TIMEOUT_MS,
      "create_milestone",
    );
    const env = recordedEnvelopes[0];
    if (recordedEnvelopes.length !== 1) {
      fail(
        "create_milestone_envelope_count",
        `expected exactly 1 envelope, got ${recordedEnvelopes.length}`,
      );
    } else if (env.type !== "planner_tool") {
      fail(
        "create_milestone_envelope_type",
        `expected type==="planner_tool", got ${JSON.stringify(env.type)}`,
      );
    } else if (env.tool !== "create_milestone") {
      fail(
        "create_milestone_envelope_tool",
        `expected tool==="create_milestone", got ${JSON.stringify(env.tool)}`,
      );
    } else if (env.sessionId !== SESSION_ID) {
      fail(
        "create_milestone_envelope_session",
        `expected sessionId===${JSON.stringify(SESSION_ID)}, got ${JSON.stringify(env.sessionId)}`,
      );
    } else if (typeof env.callId !== "string" || env.callId.length === 0) {
      fail(
        "create_milestone_envelope_call_id",
        `expected non-empty callId, got ${JSON.stringify(env.callId)}`,
      );
    } else if (
      !env.args ||
      env.args.title !== "Wire-up smoke milestone" ||
      typeof env.args.goal !== "string"
    ) {
      fail(
        "create_milestone_envelope_args",
        `args did not round-trip verbatim: ${JSON.stringify(env.args)}`,
      );
    } else {
      pass("create_milestone_envelope");
    }
    // The handler should bridge the scripted reply into a `content` block.
    if (
      !result ||
      !Array.isArray(result.content) ||
      result.content.length !== 1 ||
      result.content[0].type !== "text"
    ) {
      fail(
        "create_milestone_bridged_content",
        `expected one text content block, got ${JSON.stringify(result)}`,
      );
    } else {
      const text = result.content[0].text;
      if (!text.includes("m-fake-001")) {
        fail(
          "create_milestone_bridged_content",
          `bridged content lost the milestoneId: ${text}`,
        );
      } else {
        pass("create_milestone_bridged_content");
      }
    }
  } catch (err) {
    fail("create_milestone_envelope", err.message);
  }
}

// ---------------------------------------------------------------------------
// Step 5 — `create_task` emits a well-formed envelope.
// Protects against: E2-DISP regression where target_spec / agent_id drop or
// reshape.
// ---------------------------------------------------------------------------
if (registered) {
  recordedEnvelopes.length = 0;
  scriptedReplyForNextEmit = {
    success: true,
    taskId: "t-fake-001",
  };
  const taskArgs = {
    milestone_id: "m-fake-001",
    title: "Smoke task",
    prompt: "Execute the smoke task.",
    agent_id: "claude-code",
    target_spec: { kind: "local", workspaceId: "ws-1" },
  };
  try {
    const result = await withTimeout(
      invokeTool("create_task", taskArgs),
      STEP_TIMEOUT_MS,
      "create_task",
    );
    const env = recordedEnvelopes[0];
    if (
      !env ||
      env.tool !== "create_task" ||
      !env.args ||
      env.args.milestone_id !== "m-fake-001" ||
      env.args.agent_id !== "claude-code" ||
      !env.args.target_spec ||
      env.args.target_spec.kind !== "local" ||
      env.args.target_spec.workspaceId !== "ws-1"
    ) {
      fail(
        "create_task_envelope",
        `envelope args malformed: ${JSON.stringify(env?.args)}`,
      );
    } else if (env.sessionId !== SESSION_ID) {
      fail(
        "create_task_envelope_session",
        `expected sessionId===${JSON.stringify(SESSION_ID)}, got ${JSON.stringify(env.sessionId)}`,
      );
    } else {
      pass("create_task_envelope");
    }
    if (!result?.content?.[0]?.text?.includes("t-fake-001")) {
      fail(
        "create_task_bridged_content",
        `bridged content lost the taskId: ${JSON.stringify(result)}`,
      );
    } else {
      pass("create_task_bridged_content");
    }
  } catch (err) {
    fail("create_task_envelope", err.message);
  }
}

// ---------------------------------------------------------------------------
// Step 6 — sequential calls work without deadlock.
// Protects against: E1 pump-fix regression (multi-turn round-trip
// deadlocking the planner). If the response-await mechanism races / leaks
// state, the second emit's promise never resolves and this step times out.
// ---------------------------------------------------------------------------
if (registered) {
  recordedEnvelopes.length = 0;
  const ids = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      scriptedReplyForNextEmit = { success: true, milestoneId: `m-seq-${i}` };
      const r = await withTimeout(
        invokeTool("create_milestone", {
          title: `Sequential ${i}`,
          goal: `Round-trip ${i}.`,
        }),
        STEP_TIMEOUT_MS,
        `sequential_${i}`,
      );
      ids.push(r?.content?.[0]?.text ?? "");
    }
    if (recordedEnvelopes.length !== 3) {
      fail(
        "sequential_no_deadlock",
        `expected 3 envelopes, got ${recordedEnvelopes.length}`,
      );
    } else {
      // Each callId must be unique — proves the makeCallId path doesn't
      // collide under fast-fire sequential calls (matters because the Rust
      // side keys its pending-map by callId).
      const callIds = recordedEnvelopes.map((e) => e.callId);
      const unique = new Set(callIds);
      if (unique.size !== callIds.length) {
        fail(
          "sequential_no_deadlock",
          `callId collision across sequential calls: ${JSON.stringify(callIds)}`,
        );
      } else if (!ids.every((t, i) => t.includes(`m-seq-${i}`))) {
        fail(
          "sequential_no_deadlock",
          `bridged content did not match per-call reply: ${JSON.stringify(ids)}`,
        );
      } else {
        pass("sequential_no_deadlock");
      }
    }
  } catch (err) {
    fail("sequential_no_deadlock", err.message);
  }
}

// ---------------------------------------------------------------------------
// Step 7 — emit rejection surfaces as a handler-thrown error.
// Protects against: E2-DISP regression where a dispatcher error is silently
// swallowed and the planner thinks the call succeeded.
// ---------------------------------------------------------------------------
if (registered) {
  recordedEnvelopes.length = 0;
  emitShouldReject = true;
  let threw = false;
  let thrown = null;
  try {
    await withTimeout(
      invokeTool("create_milestone", {
        title: "Should fail",
        goal: "Emit rejects.",
      }),
      STEP_TIMEOUT_MS,
      "rejection_surfaces",
    );
  } catch (err) {
    threw = true;
    thrown = err;
  } finally {
    emitShouldReject = false;
    scriptedReplyForNextEmit = null;
  }
  if (!threw) {
    fail(
      "rejection_surfaces",
      "handler swallowed the emit rejection (planner would think the tool succeeded)",
    );
  } else if (!String(thrown?.message ?? thrown).includes("scripted dispatcher rejection")) {
    fail(
      "rejection_surfaces",
      `unexpected thrown message: ${String(thrown?.message ?? thrown)}`,
    );
  } else {
    pass("rejection_surfaces");
  }
}

// ---------------------------------------------------------------------------
// Step 8 — protocol-version sanity. The sidecar's PROTOCOL_VERSION must be
// >= 5 for the planner_tool / planner_tool_result / inject_user_turn types
// to exist. (Regression: a downgrade of PROTOCOL_VERSION would silently
// break the Rust supervisor's version handshake.)
// ---------------------------------------------------------------------------
const protocolJs = resolve(__dirname, "..", "dist", "protocol.js");
if (existsSync(protocolJs)) {
  const { PROTOCOL_VERSION } = await import(
    new URL(`file://${protocolJs.replace(/\\/g, "/")}`).href
  );
  if (typeof PROTOCOL_VERSION !== "number" || PROTOCOL_VERSION < 5) {
    fail(
      "protocol_version_floor",
      `PROTOCOL_VERSION must be >= 5 (planner wire types landed in v5), got ${PROTOCOL_VERSION}`,
    );
  } else {
    pass(`protocol_version_floor (v${PROTOCOL_VERSION})`);
  }
} else {
  fail("protocol_version_floor", `protocol.js not found at ${protocolJs}`);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log("");
console.log(`[planner-wiring] ${passed.length} pass, ${failed} fail`);
if (failed > 0) {
  process.exit(1);
}
console.log("[planner-wiring] OK");
process.exit(0);

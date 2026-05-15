// Protocol v5 regression smoke test for the PacketADE agent sidecar.
//
// Validates that the protocol v2 request types plus the v4
// `cancel_pending_tools` request and v5 `inject_user_turn` /
// `planner_tool_result` requests route correctly through the dispatcher
// against the echo provider. This is a wiring test only — it does not
// exercise any real provider. The echo provider's v2 handlers emit one
// `chunk` echoing the received field, then `done` with zero tokens. Echo
// does NOT implement v4 `cancel_pending_tools` or the v5 planner methods,
// so for those requests the expected result is the registry's clean
// "not supported" error.
//
// Sequence:
//   1. Spawn the sidecar, wait for `ready` (must advertise protocol v5).
//   2. `start_session` for provider "echo", wait for its `done`.
//   3. `set_permission_mode { mode: "plan" }` → expect chunk echoing "plan"
//      then `done`, within 3s.
//   4. `set_model { model: "test-model" }` → expect chunk echoing
//      "test-model" then `done`, within 3s.
//   5. `retry` → expect chunk containing "retry" then `done`, within 3s.
//   6. `cancel_pending_tools` → expect clean unsupported error, within 3s.
//   7. `inject_user_turn` → expect clean unsupported error, within 3s.
//   8. `planner_tool_result` → expect clean unsupported error, within 3s.
//
// Exits 0 if all steps pass, 1 otherwise — printing which step failed
// and why.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = "protocol-v5-smoke";
const EXPECTED_PROTOCOL_VERSION = 5;
const STEP_TIMEOUT_MS = 3000;
const START_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 3000;

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[protocol-v5-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(
    `[protocol-v5-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const stderrChunks = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

child.on("error", (err) => {
  console.error(`[protocol-v5-smoke] child spawn error: ${err.message}`);
  process.exit(1);
});

// Collected events between request waves.
const chunks = [];
const dones = [];
const errors = [];
let gotReady = false;
let readyProtocolVersion = null;
let readyResolver = null;

// After each request, the test code sets a single waiter that resolves when
// either a `done` or `error` event lands for SESSION_ID.
let terminalResolver = null;

child.stdout.setEncoding("utf8");
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    console.error(`[protocol-v5-smoke] non-JSON stdout line: ${trimmed}`);
    return;
  }

  switch (event.type) {
    case "ready":
      gotReady = true;
      readyProtocolVersion = event.protocolVersion;
      if (readyResolver) {
        const r = readyResolver;
        readyResolver = null;
        r();
      }
      break;
    case "chunk":
      if (event.sessionId === SESSION_ID) chunks.push(event);
      break;
    case "done":
      if (event.sessionId === SESSION_ID) {
        dones.push(event);
        if (terminalResolver) {
          const r = terminalResolver;
          terminalResolver = null;
          r({ kind: "done", event });
        }
      }
      break;
    case "error":
      if (event.sessionId === SESSION_ID) {
        errors.push(event);
        if (terminalResolver) {
          const r = terminalResolver;
          terminalResolver = null;
          r({ kind: "error", event });
        }
      }
      break;
    default:
      // Ignore other event types (thinking, tool_*, permission_request,
      // pending_edit, thinking_stop) — this test only cares about
      // chunk / done / error for SESSION_ID.
      break;
  }
});

function send(req) {
  child.stdin.write(JSON.stringify(req) + "\n");
}

function waitForReady() {
  return new Promise((resolveFn, rejectFn) => {
    if (gotReady) {
      resolveFn();
      return;
    }
    const timer = setTimeout(() => {
      readyResolver = null;
      rejectFn(new Error(`timed out after ${READY_TIMEOUT_MS}ms waiting for 'ready'`));
    }, READY_TIMEOUT_MS);
    readyResolver = () => {
      clearTimeout(timer);
      resolveFn();
    };
  });
}

function waitForTerminal(timeoutMs, label) {
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => {
      terminalResolver = null;
      rejectFn(new Error(`timed out after ${timeoutMs}ms waiting for done/error during '${label}'`));
    }, timeoutMs);
    terminalResolver = (result) => {
      clearTimeout(timer);
      resolveFn(result);
    };
  });
}

function shutdown(code) {
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, 500);
  child.on("exit", () => clearTimeout(killTimer));
  if (code !== 0 && stderrChunks.length > 0) {
    console.error(`[protocol-v5-smoke] sidecar stderr:\n${stderrChunks.join("")}`);
  }
  process.exit(code);
}

function fail(step, reason) {
  console.error(`[protocol-v5-smoke] FAIL at step '${step}': ${reason}`);
  shutdown(1);
}

async function runStep(step, request, { expectSubstring = null, expectErrorSubstring = null }) {
  // Snapshot the chunk index so we only consider chunks emitted after this
  // request was dispatched.
  const chunkStart = chunks.length;
  send(request);
  let term;
  try {
    term = await waitForTerminal(STEP_TIMEOUT_MS, step);
  } catch (err) {
    fail(step, err.message);
    return;
  }
  if (expectErrorSubstring !== null) {
    if (term.kind !== "error") {
      fail(step, `expected error containing ${JSON.stringify(expectErrorSubstring)}, got ${term.kind}`);
      return;
    }
    const message = term.event.message ?? "";
    if (!message.includes(expectErrorSubstring)) {
      fail(
        step,
        `expected error containing ${JSON.stringify(expectErrorSubstring)}, got ${JSON.stringify(message)}`,
      );
      return;
    }
    console.log(`[protocol-v5-smoke] PASS: ${step}`);
    return;
  }
  if (term.kind === "error") {
    fail(step, `received error event: ${term.event.message}`);
    return;
  }
  const stepChunks = chunks.slice(chunkStart);
  if (stepChunks.length < 1) {
    fail(step, `expected at least one 'chunk' event, got 0`);
    return;
  }
  const matched = stepChunks.some(
    (c) => typeof c.text === "string" && c.text.includes(expectSubstring),
  );
  if (!matched) {
    fail(
      step,
      `expected a 'chunk' containing ${JSON.stringify(expectSubstring)}, got ${JSON.stringify(stepChunks.map((c) => c.text))}`,
    );
    return;
  }
  console.log(`[protocol-v5-smoke] PASS: ${step}`);
}

async function run() {
  try {
    await waitForReady();
  } catch (err) {
    fail("ready", err.message);
    return;
  }
  if (readyProtocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    fail(
      "ready",
      `expected protocolVersion ${EXPECTED_PROTOCOL_VERSION}, got ${JSON.stringify(readyProtocolVersion)}`,
    );
    return;
  }

  // 2) start_session for echo and wait for the provider's initial `done`.
  {
    const chunkStart = chunks.length;
    send({
      type: "start_session",
      sessionId: SESSION_ID,
      provider: "echo",
      model: "echo",
      systemPrompt: "",
      allowedTools: [],
      mcpServers: {},
      projectPath: process.cwd(),
      initialMessage: "init",
    });
    let term;
    try {
      term = await waitForTerminal(START_TIMEOUT_MS, "start_session");
    } catch (err) {
      fail("start_session", err.message);
      return;
    }
    if (term.kind === "error") {
      fail("start_session", `received error event: ${term.event.message}`);
      return;
    }
    // Not strictly required, but prove echo actually streamed something.
    void chunks.slice(chunkStart);
    console.log(`[protocol-v5-smoke] PASS: start_session`);
  }

  // 3) set_permission_mode { mode: "plan" }
  await runStep(
    "set_permission_mode",
    { type: "set_permission_mode", sessionId: SESSION_ID, mode: "plan" },
    { expectSubstring: "plan" },
  );

  // 4) set_model { model: "test-model" }
  await runStep(
    "set_model",
    { type: "set_model", sessionId: SESSION_ID, model: "test-model" },
    { expectSubstring: "test-model" },
  );

  // 5) retry
  await runStep(
    "retry",
    { type: "retry", sessionId: SESSION_ID },
    { expectSubstring: "retry" },
  );

  // 6) cancel_pending_tools. Echo intentionally does not implement this
  // method; the registry error proves index.ts dispatches v4 requests into
  // the registry instead of dropping them as unknown request types.
  await runStep(
    "cancel_pending_tools",
    { type: "cancel_pending_tools", sessionId: SESSION_ID },
    { expectErrorSubstring: "does not support cancel_pending_tools" },
  );

  // 7) inject_user_turn. v5 wake-trigger / spec-mode chat path. Echo does
  // not implement it; we want the registry's "not supported" error rather
  // than the parser's "unknown request type" log line (which would mean
  // index.ts dropped it without dispatching).
  await runStep(
    "inject_user_turn",
    {
      type: "inject_user_turn",
      sessionId: SESSION_ID,
      content: "ping",
      source: "user",
    },
    { expectErrorSubstring: "does not support inject_user_turn" },
  );

  // 8) planner_tool_result. v5 in-process MCP correlation reply. Same
  // not-supported expectation as #7.
  await runStep(
    "planner_tool_result",
    {
      type: "planner_tool_result",
      sessionId: SESSION_ID,
      callId: "pl-test-0",
      success: true,
      result: null,
    },
    { expectErrorSubstring: "does not support planner_tool_result" },
  );

  console.log(`[protocol-v5-smoke] OK`);
  shutdown(0);
}

run().catch((err) => {
  console.error(`[protocol-v5-smoke] unexpected error: ${err?.stack ?? err}`);
  shutdown(1);
});

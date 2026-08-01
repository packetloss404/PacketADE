// Multi-turn smoke test for the Anthropic (Claude Agent SDK) provider.
//
// Regression test for the pump-break bug fixed in Mission Planner E1:
// previously `anthropic.ts::pumpMessages` broke out of the SDK message
// iterator on the first `result` message, which silently killed any
// subsequent `send_message` (the SDK kept emitting messages but nothing
// was reading them). See `dev/mission-planner-spike-retro.md` §Spike #2.
//
// What this proves: after the first turn's `done`, a follow-up
// `send_message` actually produces a second `chunk` + `done`, end-to-end
// through the sidecar's stdio protocol.
//
// Requires:
//   - An Anthropic API key in `ANTHROPIC_API_KEY` (the provider is API-key
//     only; it no longer reads the Claude Code OAuth credential store).
//   - `pnpm sidecar:build` has been run.
//
// Run from the repo root:
//   node agent-sidecar/test/anthropic-multi-turn-smoke.mjs
//
// Pass criteria:
//   1. `ready` event with `protocolVersion >= 5`.
//   2. `start_session` for `claude-oauth` with `"reply with the word OK"`
//      yields at least one `chunk` and exactly one `done` for the session.
//   3. After the first `done`, a `send_message` with `"reply with the word
//      AGAIN"` yields at least one new `chunk` and exactly one new `done`.
//   4. Both turns terminate within their per-turn timeout.
//
// Deterministic/offline checks skip unless PACKETADE_LIVE_ANTHROPIC_SMOKE=1.
// A credentials file can exist while its session/network is unavailable, and
// that external state must not make `sidecar:check` nondeterministic.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Live test: explicit opt-in plus an Anthropic API key. The provider is
// API-key only as of 2026-07 — a `~/.claude/.credentials.json` file is
// irrelevant here and no longer counts as auth for this smoke.
if (process.env.PACKETADE_LIVE_ANTHROPIC_SMOKE !== "1") {
  console.log(
    "[multi-turn-smoke] [skip] set PACKETADE_LIVE_ANTHROPIC_SMOKE=1 to run the live provider round-trip",
  );
  process.exit(0);
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!ANTHROPIC_API_KEY) {
  console.log(
    "[multi-turn-smoke] [skip] ANTHROPIC_API_KEY is not set; the Agent SDK provider is API-key only",
  );
  process.exit(0);
}

const SESSION_ID = "anthropic-multi-turn-smoke";
const TURN_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 5_000;
const MODEL = "claude-sonnet-4-6";

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[multi-turn-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(`[multi-turn-smoke] run 'pnpm sidecar:build' first`);
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
  console.error(`[multi-turn-smoke] child spawn error: ${err.message}`);
  process.exit(1);
});

const chunks = [];
const dones = [];
const errors = [];
let readyEvent = null;
let readyResolver = null;
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
    console.error(`[multi-turn-smoke] non-JSON stdout line: ${trimmed}`);
    return;
  }
  switch (event.type) {
    case "ready":
      readyEvent = event;
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
      // Ignore other event types (thinking, tool_*, permission_request, etc.)
      break;
  }
});

function send(req) {
  child.stdin.write(JSON.stringify(req) + "\n");
}

function waitForReady() {
  return new Promise((resolveFn, rejectFn) => {
    if (readyEvent) {
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
    send({ type: "close_session", sessionId: SESSION_ID });
  } catch {
    // ignore
  }
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
  }, 1000);
  child.on("exit", () => clearTimeout(killTimer));
  if (code !== 0 && stderrChunks.length > 0) {
    console.error(`[multi-turn-smoke] sidecar stderr:\n${stderrChunks.join("")}`);
  }
  process.exit(code);
}

async function run() {
  try {
    await waitForReady();
  } catch (err) {
    console.error(`[multi-turn-smoke] FAIL at ready: ${err.message}`);
    shutdown(1);
    return;
  }
  if (!readyEvent || readyEvent.protocolVersion < 5) {
    console.error(
      `[multi-turn-smoke] FAIL: expected protocolVersion >= 5, got ${readyEvent?.protocolVersion}`,
    );
    shutdown(1);
    return;
  }
  console.log(
    `[multi-turn-smoke] ready: pid=${readyEvent.pid} version=${readyEvent.version} protocol=${readyEvent.protocolVersion}`,
  );

  // ---- Turn 1: start_session ------------------------------------------------
  const turn1ChunkStart = chunks.length;
  send({
    type: "start_session",
    sessionId: SESSION_ID,
    provider: "claude-oauth",
    apiKey: ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt:
      "You are a smoke test. Reply with exactly the word the user requests and nothing else. Do not call any tools.",
    allowedTools: [],
    mcpServers: {},
    projectPath: process.cwd(),
    initialMessage: "Reply with exactly the word OK and nothing else.",
  });
  let term;
  try {
    term = await waitForTerminal(TURN_TIMEOUT_MS, "turn 1");
  } catch (err) {
    console.error(`[multi-turn-smoke] FAIL at turn 1: ${err.message}`);
    shutdown(1);
    return;
  }
  if (term.kind === "error") {
    console.error(`[multi-turn-smoke] FAIL at turn 1: ${term.event.message}`);
    shutdown(1);
    return;
  }
  const turn1Chunks = chunks.slice(turn1ChunkStart);
  if (turn1Chunks.length < 1) {
    console.error(`[multi-turn-smoke] FAIL at turn 1: no chunks emitted`);
    shutdown(1);
    return;
  }
  console.log(
    `[multi-turn-smoke] PASS: turn 1 (chunks=${turn1Chunks.length}, dones=${dones.length})`,
  );

  // ---- Turn 2: send_message (the actual regression check) -------------------
  // If the pump-break bug were still present, this turn would silently hang
  // because pumpMessages would have exited on turn 1's `result` and nothing
  // would be reading the second turn's SDK output.
  const turn2ChunkStart = chunks.length;
  const turn2DoneStart = dones.length;
  send({
    type: "send_message",
    sessionId: SESSION_ID,
    content: "Reply with exactly the word AGAIN and nothing else.",
  });
  try {
    term = await waitForTerminal(TURN_TIMEOUT_MS, "turn 2");
  } catch (err) {
    console.error(`[multi-turn-smoke] FAIL at turn 2: ${err.message}`);
    console.error(`[multi-turn-smoke] (this is the pump-break bug regressing)`);
    shutdown(1);
    return;
  }
  if (term.kind === "error") {
    console.error(`[multi-turn-smoke] FAIL at turn 2: ${term.event.message}`);
    shutdown(1);
    return;
  }
  const turn2Chunks = chunks.slice(turn2ChunkStart);
  const turn2Dones = dones.length - turn2DoneStart;
  if (turn2Chunks.length < 1) {
    console.error(`[multi-turn-smoke] FAIL at turn 2: no chunks emitted`);
    shutdown(1);
    return;
  }
  if (turn2Dones !== 1) {
    console.error(
      `[multi-turn-smoke] FAIL at turn 2: expected exactly one 'done', got ${turn2Dones}`,
    );
    shutdown(1);
    return;
  }
  console.log(
    `[multi-turn-smoke] PASS: turn 2 (chunks=${turn2Chunks.length}, dones=${turn2Dones})`,
  );
  console.log(`[multi-turn-smoke] OK — pump survived multi-turn round-trip`);
  shutdown(0);
}

run().catch((err) => {
  console.error(`[multi-turn-smoke] unexpected error: ${err?.stack ?? err}`);
  shutdown(1);
});

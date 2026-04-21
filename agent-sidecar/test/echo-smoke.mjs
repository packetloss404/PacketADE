// End-to-end smoke test for the PacketADE agent sidecar.
//
// Spawns `node agent-sidecar/dist/index.js` directly, sends a single
// `start_session` request for the `echo` provider, and validates the
// emitted NDJSON event stream.
//
// Pass criteria:
//   - >= 1 `ready` event at startup (sessionId not required)
//   - >= 1 `chunk` event for sessionId "smoke-1" whose text is a substring
//     of the initial message "hello world" (the echo provider streams the
//     message in fragments)
//   - exactly 1 `done` event for sessionId "smoke-1"
//   - all this within 5 seconds
//
// Exits 0 and prints "OK" on success, prints diagnostics and exits 1 on
// failure.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = "smoke-1";
const INITIAL_MESSAGE = "hello world";
const TIMEOUT_MS = 5000;

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(`[smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`);
  process.exit(1);
}

const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const readyEvents = [];
const chunkEvents = [];
const doneEvents = [];
const errorEvents = [];
const stderrChunks = [];
const unknownEvents = [];

let finished = false;

function finish(code, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timeoutHandle);
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  // Give the child a moment to exit cleanly, then force-kill if needed.
  const killTimer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, 500);
  child.on("exit", () => {
    clearTimeout(killTimer);
  });

  if (code === 0) {
    console.log("OK");
  } else {
    console.error(`[smoke] FAIL: ${reason}`);
    console.error(`[smoke] ready events:  ${readyEvents.length}`);
    console.error(`[smoke] chunk events:  ${chunkEvents.length}`);
    console.error(`[smoke] done events:   ${doneEvents.length}`);
    console.error(`[smoke] error events:  ${errorEvents.length}`);
    if (chunkEvents.length > 0) {
      console.error(
        `[smoke] chunk texts: ${JSON.stringify(chunkEvents.map((e) => e.text))}`,
      );
    }
    if (errorEvents.length > 0) {
      console.error(`[smoke] errors: ${JSON.stringify(errorEvents)}`);
    }
    if (unknownEvents.length > 0) {
      console.error(
        `[smoke] unexpected events: ${JSON.stringify(unknownEvents.slice(0, 5))}`,
      );
    }
    if (stderrChunks.length > 0) {
      console.error(`[smoke] stderr:\n${stderrChunks.join("")}`);
    }
  }
  process.exit(code);
}

const timeoutHandle = setTimeout(() => {
  finish(1, `timed out after ${TIMEOUT_MS}ms waiting for 'done' event`);
}, TIMEOUT_MS);

child.on("error", (err) => {
  finish(1, `child spawn error: ${err.message}`);
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrChunks.push(chunk);
});

child.stdout.setEncoding("utf8");
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch (err) {
    finish(1, `stdout produced non-JSON line: ${trimmed} (${err.message})`);
    return;
  }

  switch (event.type) {
    case "ready":
      readyEvents.push(event);
      break;
    case "chunk":
      chunkEvents.push(event);
      break;
    case "done":
      doneEvents.push(event);
      // Validate once we see a done for our session.
      if (event.sessionId === SESSION_ID) {
        validateAndFinish();
      }
      break;
    case "error":
      errorEvents.push(event);
      break;
    case "thinking":
    case "thinking_stop":
    case "tool_start":
    case "tool_result":
    case "permission_request":
    case "pending_edit":
      // Allowed but not required for echo provider; ignore.
      break;
    default:
      unknownEvents.push(event);
      break;
  }
});

function validateAndFinish() {
  // ready event at startup
  if (readyEvents.length < 1) {
    finish(1, "expected at least one 'ready' event at startup, got 0");
    return;
  }

  // at least one chunk for our session whose text is a substring of the
  // initial message (echo provider streams fragments)
  const ourChunks = chunkEvents.filter((e) => e.sessionId === SESSION_ID);
  if (ourChunks.length < 1) {
    finish(
      1,
      `expected at least one 'chunk' event for sessionId '${SESSION_ID}', got 0`,
    );
    return;
  }
  const hasEchoedChunk = ourChunks.some((e) => {
    if (typeof e.text !== "string" || e.text.length === 0) return false;
    return INITIAL_MESSAGE.includes(e.text);
  });
  if (!hasEchoedChunk) {
    finish(
      1,
      `expected at least one 'chunk' whose text is a substring of ${JSON.stringify(INITIAL_MESSAGE)}, got ${JSON.stringify(ourChunks.map((e) => e.text))}`,
    );
    return;
  }

  // exactly one done for our session
  const ourDones = doneEvents.filter((e) => e.sessionId === SESSION_ID);
  if (ourDones.length !== 1) {
    finish(
      1,
      `expected exactly one 'done' event for sessionId '${SESSION_ID}', got ${ourDones.length}`,
    );
    return;
  }

  if (errorEvents.length > 0) {
    finish(
      1,
      `received ${errorEvents.length} 'error' event(s): ${JSON.stringify(errorEvents)}`,
    );
    return;
  }

  finish(0, "ok");
}

// Send the start_session request.
const startReq = {
  type: "start_session",
  sessionId: SESSION_ID,
  provider: "echo",
  model: "echo",
  systemPrompt: "",
  allowedTools: [],
  mcpServers: {},
  projectPath: process.cwd(),
  initialMessage: INITIAL_MESSAGE,
};

child.stdin.write(JSON.stringify(startReq) + "\n");

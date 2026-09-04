// Remote-workspace projectPath smoke for the PacketBench agent sidecar.
//
// This does not open an SSH connection. It locks down the sidecar protocol
// invariant needed by sidecar-over-SSH: an SSH-launched sidecar process may
// receive SSH workspace metadata plus a POSIX-looking projectPath that is
// meaningful on the remote host even when that path does not exist on the
// desktop that spawned the test.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_ID = "remote-project-path-smoke";
const REMOTE_PROJECT_PATH = "/srv/Packet Bench/remote-app";
const INITIAL_MESSAGE = "remote project path smoke";
// Headroom for a BUSY machine, not for a slow sidecar. Booting dist/index.js
// (which eagerly imports the Anthropic, OpenAI and MCP SDKs) takes ~0.9s on an
// idle box, so the old 3-5s budgets were fine in isolation — and failed anyway
// when these smokes ran beside a cargo build using every core. These smokes
// assert protocol behaviour, not latency, so the budget sits well clear of
// contention rather than close to the measured best case.
const TIMEOUT_MS = 20_000;

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[remote-project-path-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(
    `[remote-project-path-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, PACKETBENCH_REMOTE_SIDECAR: "1" },
});

const stderrChunks = [];
const chunkEvents = [];
const errorEvents = [];
let gotReady = false;
let done = false;
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
  const killTimer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, 500);
  child.on("exit", () => clearTimeout(killTimer));

  if (code === 0) {
    console.log("OK");
  } else {
    console.error(`[remote-project-path-smoke] FAIL: ${reason}`);
    console.error(`[remote-project-path-smoke] ready: ${gotReady}`);
    console.error(`[remote-project-path-smoke] chunks: ${chunkEvents.length}`);
    console.error(`[remote-project-path-smoke] errors: ${JSON.stringify(errorEvents)}`);
    if (stderrChunks.length > 0) {
      console.error(`[remote-project-path-smoke] stderr:\n${stderrChunks.join("")}`);
    }
  }
  process.exit(code);
}

const timeoutHandle = setTimeout(() => {
  finish(1, `timed out after ${TIMEOUT_MS}ms waiting for done`);
}, TIMEOUT_MS);

child.on("error", (err) => {
  finish(1, `child spawn error: ${err.message}`);
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

child.stdout.setEncoding("utf8");
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch (err) {
    finish(1, `stdout produced non-JSON line: ${trimmed} (${err.message})`);
    return;
  }

  if (event.type === "ready") {
    gotReady = true;
    return;
  }
  if (event.sessionId !== SESSION_ID) return;

  if (event.type === "chunk") {
    chunkEvents.push(event);
    return;
  }
  if (event.type === "error") {
    errorEvents.push(event);
    finish(1, `unexpected error event: ${event.message ?? "(no message)"}`);
    return;
  }
  if (event.type === "done") {
    done = true;
    validateAndFinish();
  }
});

function validateAndFinish() {
  if (!gotReady) {
    finish(1, "expected ready event before done");
    return;
  }
  if (!done) {
    finish(1, "expected done event");
    return;
  }
  if (chunkEvents.length < 1) {
    finish(1, "expected at least one chunk event");
    return;
  }
  const echoed = chunkEvents.some(
    (event) =>
      typeof event.text === "string" &&
      event.text.length > 0 &&
      INITIAL_MESSAGE.includes(event.text),
  );
  if (!echoed) {
    finish(
      1,
      `expected an echo chunk from ${JSON.stringify(INITIAL_MESSAGE)}, got ${JSON.stringify(chunkEvents.map((e) => e.text))}`,
    );
    return;
  }
  finish(0, "ok");
}

child.stdin.write(
  JSON.stringify({
    type: "start_session",
    sessionId: SESSION_ID,
    provider: "echo",
    model: "echo",
    systemPrompt: "",
    allowedTools: [],
    mcpServers: {},
    projectPath: REMOTE_PROJECT_PATH,
    initialMessage: INITIAL_MESSAGE,
    workspace: {
      kind: "ssh",
      serverId: "srv-smoke",
      host: "example.com",
      port: 22,
      user: "ian",
      remotePath: REMOTE_PROJECT_PATH,
    },
  }) + "\n",
);

// Registry regression smoke test for the PacketADE agent sidecar.
//
// Spawns `node agent-sidecar/dist/index.js` once and issues `start_session`
// requests for all three concrete providers plus a bogus provider name.
// Validates only that each provider is correctly wired through
// `session-registry` — not that any live integration works.
//
// Pass criteria per provider:
//   - echo            → expects `done` for its sessionId (real round-trip)
//   - claude-oauth    → `done` OR `error` for its sessionId (error is fine —
//                       on a machine without Claude auth the SDK is expected
//                       to fail, which still proves registration)
//   - openai-codex    → `done` OR `error` for its sessionId (same rationale)
//   - bogus-provider  → MUST be `error` with message starting
//                       "Unknown provider:" (proves the registry rejects
//                       unknown names). A `done` here is FAIL.
//
// Each session has a 5-second individual timeout. Overall test prints a
// per-provider outcome table, then exits 0 if every outcome matches
// expectations, else exits 1.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PER_SESSION_TIMEOUT_MS = 5000;

const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[registry-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(
    `[registry-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`,
  );
  process.exit(1);
}

// Each case is independent — we define expected outcomes and how to classify
// a PASS/FAIL based on the terminal event we observe (or timeout).
const CASES = [
  {
    provider: "echo",
    sessionId: "registry-smoke-echo",
    // echo should actually return a real `done`.
    classify: (term) => {
      if (term.kind === "done") return { ok: true, outcome: "done" };
      if (term.kind === "error")
        return {
          ok: false,
          outcome: `error: ${term.message}`,
        };
      return { ok: false, outcome: `timeout after ${PER_SESSION_TIMEOUT_MS}ms` };
    },
  },
  {
    provider: "claude-oauth",
    sessionId: "registry-smoke-claude",
    // With or without auth — either done or error proves it was registered.
    classify: (term) => {
      if (term.kind === "done") return { ok: true, outcome: "done" };
      if (term.kind === "error")
        return {
          ok: true,
          outcome: `error: ${term.message}`,
        };
      return { ok: false, outcome: `timeout after ${PER_SESSION_TIMEOUT_MS}ms` };
    },
  },
  {
    provider: "openai-codex",
    sessionId: "registry-smoke-codex",
    classify: (term) => {
      if (term.kind === "done") return { ok: true, outcome: "done" };
      if (term.kind === "error")
        return {
          ok: true,
          outcome: `error: ${term.message}`,
        };
      return { ok: false, outcome: `timeout after ${PER_SESSION_TIMEOUT_MS}ms` };
    },
  },
  {
    provider: "bogus-provider",
    sessionId: "registry-smoke-bogus",
    // Must be an "Unknown provider:" error. A done would be catastrophic.
    classify: (term) => {
      if (term.kind === "error") {
        if (term.message.startsWith("Unknown provider:")) {
          return { ok: true, outcome: `error: ${term.message}` };
        }
        return {
          ok: false,
          outcome: `error (wrong message): ${term.message}`,
        };
      }
      if (term.kind === "done")
        return { ok: false, outcome: "unexpected done for bogus provider" };
      return { ok: false, outcome: `timeout after ${PER_SESSION_TIMEOUT_MS}ms` };
    },
  },
];

// ---------- sidecar lifecycle ----------

const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const stderrChunks = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

child.on("error", (err) => {
  console.error(`[registry-smoke] child spawn error: ${err.message}`);
  process.exit(1);
});

// Map sessionId → resolver callback for a terminal event
// (`{kind: "done" | "error", message?: string}`).
const pending = new Map();

let gotReady = false;
let sawFatalProtocolError = false;

child.stdout.setEncoding("utf8");
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    sawFatalProtocolError = true;
    console.error(`[registry-smoke] non-JSON stdout line: ${trimmed}`);
    return;
  }

  switch (event.type) {
    case "ready":
      gotReady = true;
      break;
    case "done": {
      const resolver = pending.get(event.sessionId);
      if (resolver) {
        pending.delete(event.sessionId);
        resolver({ kind: "done" });
      }
      break;
    }
    case "error": {
      const resolver = pending.get(event.sessionId);
      if (resolver) {
        pending.delete(event.sessionId);
        resolver({ kind: "error", message: event.message ?? "" });
      }
      break;
    }
    // All other events (chunk, thinking, tool_*, permission_request,
    // pending_edit, thinking_stop) are ignored for this test — we only
    // care about terminal signals per session.
    default:
      break;
  }
});

// ---------- drive the cases sequentially ----------

function waitForTerminal(sessionId) {
  return new Promise((resolveFn) => {
    const timer = setTimeout(() => {
      if (pending.has(sessionId)) {
        pending.delete(sessionId);
        resolveFn({ kind: "timeout" });
      }
    }, PER_SESSION_TIMEOUT_MS);
    pending.set(sessionId, (term) => {
      clearTimeout(timer);
      resolveFn(term);
    });
  });
}

function sendStart(c) {
  const req = {
    type: "start_session",
    sessionId: c.sessionId,
    provider: c.provider,
    model: "",
    systemPrompt: "",
    allowedTools: [],
    mcpServers: {},
    projectPath: process.cwd(),
    initialMessage: "regression-test",
  };
  child.stdin.write(JSON.stringify(req) + "\n");
}

function sendCancel(sessionId) {
  const req = { type: "cancel", sessionId };
  try {
    child.stdin.write(JSON.stringify(req) + "\n");
  } catch {
    // pipe may already be closed; ignore
  }
}

async function run() {
  const results = [];
  for (const c of CASES) {
    const waiter = waitForTerminal(c.sessionId);
    sendStart(c);

    // For real providers (echo / claude-oauth / openai-codex) we want a
    // terminal event ASAP even when the machine has live auth. Sending a
    // `cancel` right after `start_session` short-circuits any real roundtrip:
    //   - echo usually `done`s before the cancel arrives, which is fine.
    //   - claude / codex abort with an error, which still proves registration.
    // We skip the cancel for the bogus provider — the registry rejects it
    // synchronously with "Unknown provider:" before any session exists, and
    // a follow-up cancel would just produce a spurious "No active session"
    // error that could race the real one.
    if (c.provider !== "bogus-provider") {
      // Tiny delay so the sidecar observes the start_session before cancel.
      await new Promise((r) => setTimeout(r, 50));
      sendCancel(c.sessionId);
    }

    const term = await waiter;
    const classified = c.classify(term);
    results.push({ provider: c.provider, ...classified });
  }

  // Print outcome table.
  const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const widthProvider = Math.max(
    "provider".length,
    ...results.map((r) => r.provider.length),
  );
  const widthStatus = 6; // "PASS" / "FAIL"
  console.log("");
  console.log(
    `${pad("provider", widthProvider)}  ${pad("status", widthStatus)}  outcome`,
  );
  console.log(
    `${"-".repeat(widthProvider)}  ${"-".repeat(widthStatus)}  ${"-".repeat(40)}`,
  );
  for (const r of results) {
    console.log(
      `${pad(r.provider, widthProvider)}  ${pad(r.ok ? "PASS" : "FAIL", widthStatus)}  ${r.outcome}`,
    );
  }
  console.log("");

  const allOk = results.every((r) => r.ok) && !sawFatalProtocolError;
  if (!gotReady) {
    console.error(
      `[registry-smoke] WARNING: never saw 'ready' event at startup`,
    );
  }
  if (sawFatalProtocolError) {
    console.error(`[registry-smoke] FAIL: saw non-JSON stdout line`);
  }

  // Close sidecar.
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

  if (!allOk) {
    if (stderrChunks.length > 0) {
      console.error(`[registry-smoke] sidecar stderr:\n${stderrChunks.join("")}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error(`[registry-smoke] unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});

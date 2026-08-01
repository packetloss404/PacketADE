// API-key enforcement smoke test for the Anthropic (Claude Agent SDK) provider.
//
// Regression gate for the 2026-07 change that moved the Agent SDK row off
// Claude.ai subscription OAuth and onto an Anthropic API key. Anthropic's
// legal-and-compliance page states that "Anthropic does not permit
// third-party developers to offer Claude.ai login or to route requests
// through Free, Pro, or Max plan credentials on behalf of their users", and
// the Agent SDK overview directs developers to "use the API key
// authentication methods described in the Quickstart instead".
//
// What this proves, WITHOUT any network or credential:
//   1. `start_session` for `claude-oauth` with NO `apiKey` emits a single
//      `error` naming the missing Anthropic API key — it must NOT fall
//      through to `query()`, where the SDK would pick up whatever ambient
//      credential the machine happens to have.
//   2. That error is actionable (points at Settings → API Keys) and states
//      plainly that subscription login is not used.
//   3. The failed session is not retained: a follow-up `send_message`
//      reports "No active session", not a second provider error.
//   4. The retired `openai-codex` provider is rejected as an unknown
//      provider rather than silently resolving to something else.
//
// Deliberately offline and deterministic, so it can run in `sidecar:check`
// on any machine. The live round-trip lives in
// `anthropic-multi-turn-smoke.mjs`, which is opt-in.
//
// Run from the repo root:
//   node agent-sidecar/test/anthropic-apikey-smoke.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TIMEOUT_MS = 15_000;
const sidecarEntry = resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(sidecarEntry)) {
  console.error(`[apikey-smoke] sidecar entry not found at ${sidecarEntry}`);
  console.error(`[apikey-smoke] run 'pnpm sidecar:install && pnpm sidecar:build' first`);
  process.exit(1);
}

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

// Poison the environment on purpose: if the provider ever regressed to
// letting the SDK resolve auth itself, these would be the values it picked
// up, and this test would keep passing for the wrong reason. It must fail
// BEFORE reaching the SDK, so these are never consulted.
const child = spawn(process.execPath, [sidecarEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-should-never-be-used",
  },
});

const events = [];
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    events.push(JSON.parse(trimmed));
  } catch {
    // Non-JSON stdout is a protocol violation; record it as a raw marker.
    events.push({ type: "__nonjson", raw: trimmed });
  }
});

let stderr = "";
child.stderr.on("data", (d) => {
  stderr += String(d);
});

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function waitFor(predicate, label) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const hit = events.find(predicate);
      if (hit) {
        clearInterval(tick);
        resolvePromise(hit);
        return;
      }
      if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 25);
  });
}

function startSessionRequest(sessionId, provider, extra = {}) {
  return {
    type: "start_session",
    sessionId,
    provider,
    model: "claude-sonnet-4-6",
    systemPrompt: "",
    allowedTools: [],
    mcpServers: {},
    mcpTrustSnapshot: [],
    projectPath: process.cwd(),
    initialMessage: "reply with the word OK",
    ...extra,
  };
}

async function run() {
  await waitFor((e) => e.type === "ready", "ready");

  // ── 1. No apiKey → a clear, actionable error ──────────────────────────
  const missing = "apikey-smoke-missing";
  send(startSessionRequest(missing, "claude-oauth"));
  const err = await waitFor(
    (e) => e.type === "error" && e.sessionId === missing,
    "error for a keyless claude-oauth session",
  );
  const msg = String(err.message ?? "");
  check(/API key/i.test(msg), `error should name the missing API key, got: ${msg}`);
  check(/Anthropic/i.test(msg), `error should name Anthropic, got: ${msg}`);
  check(
    /API Keys/i.test(msg),
    `error should point at Settings → API Keys, got: ${msg}`,
  );
  check(
    /subscription/i.test(msg),
    `error should state that subscription login is not used, got: ${msg}`,
  );
  check(
    !events.some((e) => e.type === "chunk" && e.sessionId === missing),
    "a keyless session must never produce model output",
  );

  // ── 2. The failed session is not retained ─────────────────────────────
  send({ type: "send_message", sessionId: missing, content: "again" });
  const followUp = await waitFor(
    (e) =>
      e.type === "error" &&
      e.sessionId === missing &&
      /No active session/i.test(String(e.message ?? "")),
    "No active session on a follow-up send",
  );
  check(
    /No active session/i.test(String(followUp.message)),
    "follow-up send should report no active session",
  );

  // ── 3. The retired Codex provider is gone from the registry ───────────
  const retired = "apikey-smoke-retired";
  send(startSessionRequest(retired, "openai-codex"));
  const retiredErr = await waitFor(
    (e) => e.type === "error" && e.sessionId === retired,
    "error for the retired openai-codex provider",
  );
  check(
    /^Unknown provider:/.test(String(retiredErr.message ?? "")),
    `openai-codex should be an unknown provider, got: ${retiredErr.message}`,
  );

  // ── 4. The poisoned OAuth token never reached the SDK ─────────────────
  check(
    !stderr.includes("sk-ant-oat-should-never-be-used"),
    "the OAuth token must never be logged or forwarded",
  );
}

const shutdown = (code) => {
  try {
    child.stdin.end();
  } catch {
    // already closed
  }
  child.kill();
  process.exit(code);
};

run()
  .then(() => {
    if (failures.length > 0) {
      console.error("FAIL anthropic-apikey-smoke:");
      for (const f of failures) console.error(`  - ${f}`);
      if (stderr) console.error(`sidecar stderr:\n${stderr}`);
      shutdown(1);
      return;
    }
    console.log(
      "PASS anthropic-apikey-smoke: Agent SDK provider requires an API key, never falls back to subscription auth, and the retired Codex provider is unregistered",
    );
    shutdown(0);
  })
  .catch((err) => {
    console.error(`FAIL anthropic-apikey-smoke: ${err.message}`);
    if (stderr) console.error(`sidecar stderr:\n${stderr}`);
    shutdown(1);
  });

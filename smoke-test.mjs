#!/usr/bin/env node
// PacketBench smoke test — no dependencies beyond Node 18+ (global fetch) and,
// in fallback mode, the Rust toolchain that already builds this repo.
//
// What it proves (audit 2026-09-04, deliverable 9):
//   1. "login"      — the MCP bearer token is accepted (initialize returns 200).
//   2. auth write   — an authenticated `append_handoff` tool call lands (or is
//                     refused with the exact allow_writes message when writes
//                     are off, which is itself the documented failure path).
//   3. failure path — no token => 401; wrong token => 401.
//   4. origin guard — a non-loopback Origin => 403. PacketBench has no
//                     webhooks; the Origin check is the equivalent boundary for
//                     a loopback HTTP service and is what a browser-based
//                     forgery would hit.
//   5. health       — GET /health => 200 {ok:true, app:"PacketBench"}.
//
// Modes:
//   LIVE     — set PACKETBENCH_MCP_URL (e.g. http://127.0.0.1:3100/mcp) and
//              PACKETBENCH_MCP_TOKEN (both shown in Settings > MCP Provider
//              after clicking Start). Hits the running app.
//   FALLBACK — no env vars: runs the Rust transport tests that start a real
//              127.0.0.1 listener and assert exactly cases 1, 3, 4, 5, plus the
//              allowlist round-trip. Uses `cargo test` from src-tauri/ so the
//              local .cargo/config.toml target-dir redirect applies.
//
// Exit code 0 = every case passed. Any failure prints the case and exits 1.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

// node:http with `agent: false` rather than global fetch: fetch's undici pool
// keeps sockets alive past the last response, and exiting with those handles
// still open aborts Node on Windows ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c") — the script
// would print every PASS and then exit 127. One connection per request, closed
// on response, exits cleanly.
function request(urlStr, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method,
        headers: body ? { ...headers, "content-length": Buffer.byteLength(body) } : headers,
        agent: false,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function live(url, token) {
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "packetbench-smoke", version: "0" },
    },
  };
  const headers = (t) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(t ? { authorization: `Bearer ${t}` } : {}),
  });
  const base = url.replace(/\/mcp\/?$/, "");

  // 5. health
  try {
    const r = await request(`${base}/health`);
    const body = JSON.parse(r.text);
    record("health: GET /health is 200 and names PacketBench", r.status === 200 && body.ok === true && body.app === "PacketBench", `status=${r.status} body=${r.text}`);
  } catch (e) {
    record("health: GET /health is 200 and names PacketBench", false, String(e));
  }

  // 3. failure paths
  let r = await request(url, { method: "POST", headers: headers(null), body: JSON.stringify(init) });
  record("failure: initialize without a token is 401", r.status === 401, `status=${r.status}`);
  r = await request(url, { method: "POST", headers: headers("not-the-token"), body: JSON.stringify(init) });
  record("failure: initialize with a wrong token is 401", r.status === 401, `status=${r.status}`);

  // 4. origin guard (webhook-signature analogue)
  r = await request(url, {
    method: "POST",
    headers: { ...headers(token), origin: "https://evil.example.com" },
    body: JSON.stringify(init),
  });
  record("origin: a non-loopback Origin is 403 even with the right token", r.status === 403, `status=${r.status}`);
  r = await request(`${base}/health`, { headers: { origin: "https://evil.example.com" } });
  record("origin: /health with a non-loopback Origin is 403", r.status === 403, `status=${r.status}`);

  // 1. login
  r = await request(url, { method: "POST", headers: headers(token), body: JSON.stringify(init) });
  const session = r.headers["mcp-session-id"];
  record("login: initialize with the bearer token is 200 and issues a session id", r.status === 200 && !!session, `status=${r.status} session=${session ? "yes" : "no"}`);
  if (!session) return;
  await request(url, {
    method: "POST",
    headers: { ...headers(token), "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const rpc = async (body) => {
    const res = await request(url, {
      method: "POST",
      headers: { ...headers(token), "mcp-session-id": session },
      body: JSON.stringify(body),
    });
    const text = res.text;
    for (const line of text.split("\n")) {
      const rest = line.startsWith("data:") ? line.slice(5).trim() : null;
      if (rest) {
        try { return JSON.parse(rest); } catch { /* keepalive */ }
      }
    }
    try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
  };

  // 2. authenticated write
  const flights = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_active_flight", arguments: {} } });
  let flightId = null;
  try {
    const text = flights?.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    flightId = parsed?.id ?? null;
  } catch { /* no active flight */ }
  if (!flightId) {
    record("write: append_handoff to the active flight", false, "no active Flight selected in the app — select one in Flight Deck and rerun");
    return;
  }
  const write = await rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "append_handoff", arguments: { flightId, summary: `smoke-test ${new Date().toISOString()}`, agentId: "smoke" } },
  });
  const msg = JSON.stringify(write);
  if (write?.error && /writes are disabled/.test(write.error.message ?? "")) {
    record("write: append_handoff refused because Allow writes is off (documented failure path)", true, "enable 'Allow writes' in Settings > MCP Provider to exercise the write itself");
  } else {
    record("write: append_handoff to the active flight lands", !write?.error && /Posted to the flight timeline/.test(msg), msg.slice(0, 200));
  }
}

function fallback() {
  console.log("No PACKETBENCH_MCP_URL/PACKETBENCH_MCP_TOKEN set — running the Rust transport tests against a real 127.0.0.1 listener.");
  const tests = [
    ["login+failure+health+origin", "mcp_server::transport::tests::auth_gates_the_transport"],
    ["allowlist round-trip (denied tool cannot run)", "mcp_server::transport::tests::the_allowlist_is_enforced_over_the_wire"],
    ["resources honour the allowlist", "mcp_server::allowlist_tests::resources_honour_the_tool_allowlist"],
    ["boot check env validation", "core::boot_check::tests"],
    ["project trust fail-closed", "core::project_trust::tests"],
  ];
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  for (const [label, filter] of tests) {
    const r = spawnSync(cargo, ["test", "--lib", "--", filter], {
      cwd: path.join(root, "src-tauri"),
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const summary = (out.match(/test result: .*/g) || []).pop() || "";
    const passed = r.status === 0 && /test result: ok\. [1-9]\d* passed/.test(summary);
    record(`fallback: ${label} [${filter}]`, passed, summary || `exit=${r.status}`);
  }
}

const url = process.env.PACKETBENCH_MCP_URL;
const token = process.env.PACKETBENCH_MCP_TOKEN;
if (url && token) {
  await live(url, token);
} else {
  fallback();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

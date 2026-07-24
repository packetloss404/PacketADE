import assert from "node:assert/strict";
import { SessionRegistry } from "../dist/session-registry.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function startReq(sessionId, provider = "controlled") {
  return {
    type: "start_session",
    sessionId,
    provider,
    model: "",
    systemPrompt: "",
    allowedTools: [],
    mcpServers: {},
    projectPath: process.cwd(),
    initialMessage: "initial",
  };
}

class ControlledProvider {
  constructor(events, gates) {
    this.events = events;
    this.gates = gates;
    this.sessionId = "";
  }

  async start(req, emit) {
    this.sessionId = req.sessionId;
    this.events.push(`${req.sessionId}:start:begin`);
    await this.gates.get(req.sessionId).promise;
    this.events.push(`${req.sessionId}:start:end`);
    emit({
      type: "done",
      sessionId: req.sessionId,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  async sendMessage(req, emit) {
    this.events.push(`${req.sessionId}:send:${req.content}`);
    emit({
      type: "done",
      sessionId: req.sessionId,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  async close() {
    this.events.push(`${this.sessionId}:close`);
  }
}

class RuntimeErrorProvider {
  constructor(events) {
    this.events = events;
    this.sessionId = "";
    this.emit = undefined;
  }

  async start(req, emit) {
    this.sessionId = req.sessionId;
    this.emit = emit;
    this.events.push(`${req.sessionId}:start`);
    emit({
      type: "done",
      sessionId: req.sessionId,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  emitRuntimeError() {
    this.emit?.({
      type: "error",
      sessionId: this.sessionId,
      message: "runtime failure",
    });
  }

  emitLateDone() {
    this.emit?.({
      type: "done",
      sessionId: this.sessionId,
      inputTokens: 10,
      outputTokens: 20,
    });
  }

  async sendMessage(req, emit) {
    this.events.push(`${req.sessionId}:send:${req.content}`);
    emit({
      type: "done",
      sessionId: req.sessionId,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  async cancel() {
    this.events.push(`${this.sessionId}:cancel`);
  }
}

const events = [];
const emitted = [];
const gates = new Map([
  ["a", deferred()],
  ["b", deferred()],
]);

const registry = new SessionRegistry({
  controlled: () => new ControlledProvider(events, gates),
});
const emit = (event) => emitted.push(event);

const aStart = registry.start(startReq("a"), emit);
const aSend = registry.dispatch(
  "a",
  { type: "send_message", sessionId: "a", content: "first" },
  emit,
);
const aClose = registry.close("a");
const bStart = registry.start(startReq("b"), emit);

await nextTurn();

assert.deepEqual(events, ["a:start:begin", "b:start:begin"]);

gates.get("b").resolve();
await bStart;

assert.equal(events.includes("a:send:first"), false);
assert.equal(events.includes("a:close"), false);
assert.ok(
  events.indexOf("b:start:end") > events.indexOf("b:start:begin"),
  "unrelated session should complete while the first session is still starting",
);

gates.get("a").resolve();
await Promise.all([aStart, aSend, aClose]);

assert.deepEqual(
  events.filter((event) => event.startsWith("a:")),
  ["a:start:begin", "a:start:end", "a:send:first", "a:close"],
);
assert.equal(
  emitted.some(
    (event) =>
      event.type === "error" &&
      event.sessionId === "a" &&
      event.message.startsWith("No active session:"),
  ),
  false,
);

const runtimeEvents = [];
const runtimeEmitted = [];
let runtimeProvider;
const runtimeRegistry = new SessionRegistry({
  runtime: () => {
    runtimeProvider = new RuntimeErrorProvider(runtimeEvents);
    return runtimeProvider;
  },
});

await runtimeRegistry.start(startReq("runtime", "runtime"), (event) => runtimeEmitted.push(event));
runtimeProvider.emitRuntimeError();
await runtimeRegistry.dispatch(
  "runtime",
  { type: "send_message", sessionId: "runtime", content: "after-error" },
  (event) => runtimeEmitted.push(event),
);

assert.deepEqual(runtimeEvents, ["runtime:start", "runtime:send:after-error"]);
assert.equal(
  runtimeEmitted.some(
    (event) =>
      event.type === "error" &&
      event.sessionId === "runtime" &&
      event.message.startsWith("No active session:"),
  ),
  false,
);

await runtimeRegistry.dispatch("runtime", { type: "cancel", sessionId: "runtime" }, (event) =>
  runtimeEmitted.push(event),
);
runtimeProvider.emitLateDone();
const cancelledTerminalEvents = runtimeEmitted.filter(
  (event) => event.type === "done" && event.sessionId === "runtime" && event.cancelled === true,
);
assert.equal(
  cancelledTerminalEvents.length,
  1,
  "cancel emits exactly one explicit terminal marker",
);
assert.equal(runtimeEvents.at(-1), "runtime:cancel");

await runtimeRegistry.dispatch(
  "runtime",
  { type: "send_message", sessionId: "runtime", content: "after-cancel" },
  (event) => runtimeEmitted.push(event),
);
assert.equal(
  runtimeEvents.at(-1),
  "runtime:send:after-cancel",
  "turn cancellation retains the reusable conversation",
);
assert.equal(runtimeEmitted.at(-1)?.type, "done");
assert.notEqual(runtimeEmitted.at(-1)?.cancelled, true);

await runtimeRegistry.close("runtime");
await runtimeRegistry.dispatch(
  "runtime",
  { type: "send_message", sessionId: "runtime", content: "after-close" },
  (event) => runtimeEmitted.push(event),
);
assert.match(runtimeEmitted.at(-1)?.message ?? "", /^No active session:/);

console.log("[session-ordering-smoke] PASS");

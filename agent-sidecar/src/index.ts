import { createInterface } from "node:readline";
import type { SidecarEvent, SidecarRequest } from "./protocol.js";
import { SessionRegistry } from "./session-registry.js";

// Stdout is reserved for protocol frames. Any human-readable logging MUST go
// to stderr so the supervisor's JSON line parser stays clean.
const logStderr = (msg: string): void => {
  process.stderr.write(`[sidecar] ${msg}\n`);
};

const emit = (event: SidecarEvent): void => {
  process.stdout.write(JSON.stringify(event) + "\n");
};

const registry = new SessionRegistry();

async function handleRequest(raw: string): Promise<void> {
  const line = raw.trim();
  if (line.length === 0) return;

  let req: SidecarRequest;
  try {
    req = JSON.parse(line) as SidecarRequest;
  } catch (err) {
    logStderr(`failed to parse request: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  switch (req.type) {
    case "start_session":
      await registry.start(req, emit);
      break;
    case "send_message":
    case "permission_response":
    case "edit_response":
    case "cancel":
      await registry.dispatch(req.sessionId, req, emit);
      break;
    case "close_session":
      await registry.close(req.sessionId);
      break;
    default: {
      const unknown = req as { type?: string };
      logStderr(`unknown request type: ${unknown.type ?? "<missing>"}`);
      break;
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  logStderr(`received ${signal}, closing sessions`);
  try {
    await registry.closeAll();
  } catch (err) {
    logStderr(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

function main(): void {
  process.stdin.setEncoding("utf8");
  const rl = createInterface({ input: process.stdin });

  // Serialize line handling so concurrent start/send ordering is predictable.
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue.then(() => handleRequest(line)).catch((err) => {
      logStderr(`handler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  rl.on("close", () => {
    void shutdown("stdin-close");
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  emit({ type: "ready", pid: process.pid });
}

main();

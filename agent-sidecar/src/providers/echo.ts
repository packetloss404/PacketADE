import type { Emit, SendMessageRequest, StartSessionRequest } from "../protocol.js";
import type { ProviderHandler } from "./base.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Splits a string into roughly N pieces for streaming back as chunks.
function splitIntoPieces(text: string, pieces: number): string[] {
  if (text.length === 0) return ["", "", ""];
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  while (out.length < pieces) out.push("");
  return out.slice(0, pieces);
}

async function stream(sessionId: string, text: string, emit: Emit): Promise<void> {
  const pieces = splitIntoPieces(text, 3);
  for (const piece of pieces) {
    emit({ type: "chunk", sessionId, text: piece });
    await delay(50);
  }
  emit({
    type: "done",
    sessionId,
    inputTokens: text.length,
    outputTokens: text.length,
  });
}

// Echo provider — used for validating the stdio protocol end-to-end before
// the real Claude / Codex providers land in Phases 4 and 5.
export class EchoProvider implements ProviderHandler {
  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    await stream(req.sessionId, req.initialMessage, emit);
  }

  async sendMessage(req: SendMessageRequest, emit: Emit): Promise<void> {
    await stream(req.sessionId, req.content, emit);
  }

  async cancel(_emit: Emit): Promise<void> {
    // Echo provider has no long-lived work to cancel; no-op.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

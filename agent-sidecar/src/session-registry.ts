import type {
  CancelRequest,
  EditResponseRequest,
  Emit,
  PermissionResponseRequest,
  SendMessageRequest,
  StartSessionRequest,
} from "./protocol.js";
import type { ProviderHandler } from "./providers/base.js";
import { EchoProvider } from "./providers/echo.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICodexProvider } from "./providers/openai-codex.js";

// Factory map — Phase 4 adds "claude-oauth", Phase 5 adds "openai-codex".
const PROVIDERS: Record<string, () => ProviderHandler> = {
  echo: () => new EchoProvider(),
  "claude-oauth": () => new AnthropicProvider(),
  "openai-codex": () => new OpenAICodexProvider(),
};

export class SessionRegistry {
  private sessions = new Map<string, ProviderHandler>();

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    const factory = PROVIDERS[req.provider];
    if (!factory) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: `Unknown provider: ${req.provider}`,
      });
      return;
    }
    if (this.sessions.has(req.sessionId)) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: `Session already exists: ${req.sessionId}`,
      });
      return;
    }
    const handler = factory();
    this.sessions.set(req.sessionId, handler);
    try {
      await handler.start(req, emit);
    } catch (err) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async dispatch(
    sessionId: string,
    req: SendMessageRequest | PermissionResponseRequest | EditResponseRequest | CancelRequest,
    emit: Emit,
  ): Promise<void> {
    const handler = this.sessions.get(sessionId);
    if (!handler) {
      emit({
        type: "error",
        sessionId,
        message: `No active session: ${sessionId}`,
      });
      return;
    }
    try {
      switch (req.type) {
        case "send_message":
          if (handler.sendMessage) await handler.sendMessage(req, emit);
          break;
        case "permission_response":
          if (handler.respondPermission) await handler.respondPermission(req, emit);
          break;
        case "edit_response":
          if (handler.respondEdit) await handler.respondEdit(req, emit);
          break;
        case "cancel":
          if (handler.cancel) await handler.cancel(emit);
          break;
      }
    } catch (err) {
      emit({
        type: "error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async close(sessionId: string): Promise<void> {
    const handler = this.sessions.get(sessionId);
    if (!handler) return;
    this.sessions.delete(sessionId);
    if (handler.close) {
      try {
        await handler.close();
      } catch (err) {
        process.stderr.write(
          `[sidecar] error closing session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }
}

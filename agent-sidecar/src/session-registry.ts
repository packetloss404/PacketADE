import type {
  CancelRequest,
  EditResponseRequest,
  Emit,
  PermissionResponseRequest,
  RetryRequest,
  SendMessageRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  StartSessionRequest,
} from "./protocol.js";
import type { ProviderHandler } from "./providers/base.js";
import { EchoProvider } from "./providers/echo.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICodexProvider } from "./providers/openai-codex.js";

// Factory map — both subscription providers are wired:
//   - "claude-oauth"  → Anthropic Agent SDK (OAuth / `claude login`)
//   - "openai-codex"  → Codex CLI exec mode (`codex login`)
// Add new providers by importing the handler and extending this record.
const PROVIDERS: Record<string, () => ProviderHandler> = {
  echo: () => new EchoProvider(),
  "claude-oauth": () => new AnthropicProvider(),
  "openai-codex": () => new OpenAICodexProvider(),
};

/**
 * Registry entry: the live handler plus the provider name it was created for.
 * The name is kept so `dispatch()` can produce human-readable error messages
 * like `openai-codex does not support retry` without a reverse lookup.
 */
interface SessionEntry {
  handler: ProviderHandler;
  provider: string;
}

export class SessionRegistry {
  private sessions = new Map<string, SessionEntry>();

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
    this.sessions.set(req.sessionId, { handler, provider: req.provider });
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
    req:
      | SendMessageRequest
      | PermissionResponseRequest
      | EditResponseRequest
      | CancelRequest
      | SetPermissionModeRequest
      | SetModelRequest
      | RetryRequest,
    emit: Emit,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      emit({
        type: "error",
        sessionId,
        message: `No active session: ${sessionId}`,
      });
      return;
    }
    const { handler, provider } = entry;
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
        case "set_permission_mode":
          if (handler.setPermissionMode) {
            await handler.setPermissionMode(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support set_permission_mode`,
            });
          }
          break;
        case "set_model":
          if (handler.setModel) {
            await handler.setModel(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support set_model`,
            });
          }
          break;
        case "retry":
          if (handler.retry) {
            await handler.retry(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support retry`,
            });
          }
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
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    const { handler } = entry;
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

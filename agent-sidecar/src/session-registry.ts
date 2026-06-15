import type {
  CancelPendingToolsRequest,
  CancelRequest,
  EditResponseRequest,
  Emit,
  InjectUserTurnRequest,
  PermissionResponseRequest,
  PlannerToolResultRequest,
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
import { OpenAIAgentsProvider } from "./providers/openai-agents.js";

type ProviderFactories = Record<string, () => ProviderHandler>;

// Factory map — both subscription providers are wired:
//   - "claude-oauth"  → Anthropic Agent SDK (OAuth / `claude login`)
//   - "openai-codex"  → Codex CLI exec mode (`codex login`)
//   - "openai-agents" → OpenAI Agents SDK (OpenAI API key)
// Add new providers by importing the handler and extending this record.
const PROVIDERS: ProviderFactories = {
  echo: () => new EchoProvider(),
  "claude-oauth": () => new AnthropicProvider(),
  "openai-codex": () => new OpenAICodexProvider(),
  "openai-agents": () => new OpenAIAgentsProvider(),
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
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly providers: ProviderFactories = PROVIDERS) {}

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    return this.enqueue(req.sessionId, () => this.startNow(req, emit));
  }

  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.catch(() => undefined);
    this.queues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.queues.get(sessionId) === tail) {
        this.queues.delete(sessionId);
      }
    });
    return next;
  }

  private async startNow(req: StartSessionRequest, emit: Emit): Promise<void> {
    const factory = this.providers[req.provider];
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
    if (req.workspace?.kind === "ssh" && process.env.PACKETADE_REMOTE_SIDECAR !== "1") {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message:
          "Remote SSH workspace metadata reached the local sidecar, but Sidecar-over-SSH transport is not active yet. PacketADE refused to treat the remote path as a local filesystem path.",
      });
      return;
    }
    const handler = factory();
    this.sessions.set(req.sessionId, { handler, provider: req.provider });
    let startFailed = false;
    let starting = true;
    const startEmit: Emit = (event) => {
      if (starting && event.type === "error" && event.sessionId === req.sessionId) {
        startFailed = true;
      }
      emit(event);
    };
    try {
      await handler.start(req, startEmit);
      starting = false;
      if (startFailed) {
        this.sessions.delete(req.sessionId);
      }
    } catch (err) {
      starting = false;
      this.sessions.delete(req.sessionId);
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
      | RetryRequest
      | CancelPendingToolsRequest
      | InjectUserTurnRequest
      | PlannerToolResultRequest,
    emit: Emit,
  ): Promise<void> {
    return this.enqueue(sessionId, () => this.dispatchNow(sessionId, req, emit));
  }

  private async dispatchNow(
    sessionId: string,
    req:
      | SendMessageRequest
      | PermissionResponseRequest
      | EditResponseRequest
      | CancelRequest
      | SetPermissionModeRequest
      | SetModelRequest
      | RetryRequest
      | CancelPendingToolsRequest
      | InjectUserTurnRequest
      | PlannerToolResultRequest,
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
        case "cancel_pending_tools":
          if (handler.cancelPendingTools) {
            await handler.cancelPendingTools(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support cancel_pending_tools`,
            });
          }
          break;
        case "inject_user_turn":
          if (handler.injectUserTurn) {
            await handler.injectUserTurn(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support inject_user_turn`,
            });
          }
          break;
        case "planner_tool_result":
          if (handler.respondPlannerTool) {
            await handler.respondPlannerTool(req, emit);
          } else {
            emit({
              type: "error",
              sessionId,
              message: `${provider} does not support planner_tool_result`,
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
    return this.enqueue(sessionId, () => this.closeNow(sessionId));
  }

  private async closeNow(sessionId: string): Promise<void> {
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
    const ids = Array.from(new Set([...this.sessions.keys(), ...this.queues.keys()]));
    await Promise.all(ids.map((id) => this.close(id)));
  }
}

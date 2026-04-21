// Claude Agent SDK provider (subscription-auth / OAuth).
//
// Wraps `query()` from `@anthropic-ai/claude-agent-sdk` and translates the
// SDK's message stream into the sidecar's wire-protocol events. Uses a
// push-based async-iterable prompt so the single long-lived `query()` call
// serves every turn of the conversation (no resume-per-turn fallback).
//
// OAuth: the SDK picks up `~/.claude/credentials` (or equivalent Claude Code
// credential store) automatically when no API key env var is set. We do not
// wire env overrides here — the supervisor is expected to launch this sidecar
// with an environment that yields OAuth auth.

import type {
  EditResponseRequest,
  Emit,
  PermissionResponseRequest,
  SendMessageRequest,
  StartSessionRequest,
} from "../protocol.js";
import type { ProviderHandler } from "./base.js";
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const logStderr = (msg: string): void => {
  process.stderr.write(`[sidecar:anthropic] ${msg}\n`);
};

/**
 * Push-based async iterable. Callers `push()` items; the iterator resolves
 * them in order. `end()` closes the iterator after any queued items drain.
 * Used as the `prompt` argument to `query()` so we can feed follow-up turns
 * into a single persistent SDK call.
 */
class PushableAsyncIterable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private pending: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.pending = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.closed = true;
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}

/**
 * Map the sidecar's planMode / other flags to an SDK PermissionMode. The
 * Rust side only surfaces `planMode` today; if/when manual/agent modes
 * are added, extend this mapping.
 */
function choosePermissionMode(req: StartSessionRequest): PermissionMode {
  if (req.planMode) return "plan";
  // Default: let the SDK prompt via `canUseTool`. That callback translates
  // to `permission_request` events on our wire protocol.
  return "default";
}

/**
 * Normalize the JSON object the Rust supervisor passes as `mcpServers` into
 * the SDK's `McpServerConfig` map. The Rust side already builds process /
 * HTTP / SSE shapes; we just trust the discriminator and let TS treat the
 * values as `McpServerConfig`. Anything the SDK rejects will surface later
 * as an `auth_status` / `system` message we log and pass through.
 */
function toMcpServers(
  raw: Record<string, unknown>,
): Record<string, McpServerConfig> | undefined {
  const keys = Object.keys(raw);
  if (keys.length === 0) return undefined;
  // Cast-through: the Rust side is the source of truth for shape. If a user
  // misconfigures an entry, the SDK will emit an error message we forward.
  return raw as unknown as Record<string, McpServerConfig>;
}

function stringifyToolResultContent(content: unknown): { output: string; isError: boolean } {
  if (content == null) return { output: "", isError: false };
  if (typeof content === "string") return { output: content, isError: false };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
          continue;
        }
      }
      try {
        parts.push(JSON.stringify(block));
      } catch {
        parts.push(String(block));
      }
    }
    return { output: parts.join("\n"), isError: false };
  }
  try {
    return { output: JSON.stringify(content), isError: false };
  } catch {
    return { output: String(content), isError: false };
  }
}

type PermissionResolver = (result: PermissionResult) => void;

export class AnthropicProvider implements ProviderHandler {
  private prompt: PushableAsyncIterable<SDKUserMessage> | null = null;
  private q: Query | null = null;
  private abort: AbortController | null = null;
  private pendingPermissions = new Map<string, PermissionResolver>();
  private runPromise: Promise<void> | null = null;
  private emitCurrent: Emit | null = null;
  private activeThinkingBlock = false;

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    this.emitCurrent = emit;
    this.abort = new AbortController();

    const prompt = new PushableAsyncIterable<SDKUserMessage>();
    this.prompt = prompt;

    const canUseTool: CanUseTool = async (toolName, input, { toolUseID, signal }) => {
      // Emit a permission_request and park a resolver keyed by toolUseID.
      const currentEmit = this.emitCurrent;
      if (currentEmit) {
        currentEmit({
          type: "permission_request",
          sessionId: req.sessionId,
          toolUseId: toolUseID,
          name: toolName,
          input,
        });
      }
      return await new Promise<PermissionResult>((resolve) => {
        const wrapped: PermissionResolver = (result) => {
          this.pendingPermissions.delete(toolUseID);
          resolve(result);
        };
        this.pendingPermissions.set(toolUseID, wrapped);
        // If the SDK aborts (e.g. from cancel()), deny the pending request so
        // the SDK can shut down cleanly instead of hanging on our promise.
        signal.addEventListener(
          "abort",
          () => {
            const entry = this.pendingPermissions.get(toolUseID);
            if (!entry) return;
            this.pendingPermissions.delete(toolUseID);
            resolve({ behavior: "deny", message: "cancelled", interrupt: true });
          },
          { once: true },
        );
      });
    };

    const options: Options = {
      abortController: this.abort,
      cwd: req.projectPath || undefined,
      model: req.model || undefined,
      systemPrompt: req.systemPrompt && req.systemPrompt.length > 0 ? req.systemPrompt : undefined,
      allowedTools: req.allowedTools && req.allowedTools.length > 0 ? req.allowedTools : undefined,
      mcpServers: toMcpServers(req.mcpServers ?? {}),
      permissionMode: choosePermissionMode(req),
      resume: req.resume,
      canUseTool,
      includePartialMessages: false,
      stderr: (data) => {
        // SDK internal debug/stderr; keep it on our stderr so it never
        // pollutes the NDJSON stdout channel.
        process.stderr.write(`[sidecar:anthropic:sdk] ${data}`);
      },
    };

    // Write-intercept → pending_edit: the SDK does not expose a clean
    // "intercept Write/Edit and surface before+after diff" hook today.
    // Fallback: rely on the SDK's own permissionMode + canUseTool flow so
    // write operations still require approval — just without the diff
    // preview. Tracked separately; not blocking Phase 4.
    logStderr(
      "pending_edit diff preview deferred to SDK permissionMode (write-intercept not implemented)",
    );

    // Push the initial user message onto the pump, then start the query.
    prompt.push({
      type: "user",
      message: { role: "user", content: req.initialMessage },
      parent_tool_use_id: null,
    });

    try {
      this.q = query({ prompt, options });
    } catch (err) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Run the iterator in the background; don't await here — start() must
    // return so the registry can accept further requests (send_message,
    // permission_response, cancel). The message pump emits events as they
    // arrive. We capture the promise so close() can await it if needed.
    this.runPromise = this.pumpMessages(req.sessionId, emit).catch((err) => {
      logStderr(`pump crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Make start() resolve only once the query starts yielding (or fails).
    // Practically that means we return immediately and let send_message /
    // cancel arrive while the pump is running.
  }

  private async pumpMessages(sessionId: string, emit: Emit): Promise<void> {
    if (!this.q) return;
    let sawResult = false;
    try {
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        this.handleMessage(sessionId, msg, emit);
        if (msg.type === "result") {
          sawResult = true;
          break;
        }
      }
    } catch (err) {
      // Abort from cancel() surfaces as an exception in some SDK versions;
      // treat named AbortError as a cancellation, everything else as error.
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || this.abort?.signal.aborted) {
        emit({ type: "done", sessionId, inputTokens: 0, outputTokens: 0 });
      } else {
        emit({ type: "error", sessionId, message });
      }
      return;
    }
    if (!sawResult) {
      emit({ type: "done", sessionId, inputTokens: 0, outputTokens: 0 });
    }
  }

  private handleMessage(sessionId: string, msg: SDKMessage, emit: Emit): void {
    switch (msg.type) {
      case "system": {
        // init / status / hooks — logged below, no wire event emitted yet.
        return;
      }
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as {
            type?: string;
            text?: string;
            thinking?: string;
            id?: string;
            name?: string;
            input?: unknown;
          };
          if (b.type === "text" && typeof b.text === "string") {
            // If we had an open thinking block, close it before text streams.
            if (this.activeThinkingBlock) {
              emit({ type: "thinking_stop", sessionId });
              this.activeThinkingBlock = false;
            }
            if (b.text.length > 0) {
              emit({ type: "chunk", sessionId, text: b.text });
            }
          } else if (b.type === "thinking" && typeof b.thinking === "string") {
            this.activeThinkingBlock = true;
            emit({ type: "thinking", sessionId, text: b.thinking });
          } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            if (this.activeThinkingBlock) {
              emit({ type: "thinking_stop", sessionId });
              this.activeThinkingBlock = false;
            }
            emit({
              type: "tool_start",
              sessionId,
              toolUseId: b.id,
              name: b.name,
              input: b.input ?? {},
            });
          }
          // Other block types (server_tool_use, redacted_thinking, etc.)
          // are intentionally ignored for now.
        }
        // Close any dangling thinking block at end of the assistant message.
        if (this.activeThinkingBlock) {
          emit({ type: "thinking_stop", sessionId });
          this.activeThinkingBlock = false;
        }
        return;
      }
      case "user": {
        // The SDK replays tool results back to us as user messages whose
        // content contains tool_result blocks.
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as {
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            const { output } = stringifyToolResultContent(b.content);
            emit({
              type: "tool_result",
              sessionId,
              toolUseId: b.tool_use_id,
              output,
              isError: Boolean(b.is_error),
            });
          }
        }
        return;
      }
      case "result": {
        const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        emit({
          type: "done",
          sessionId,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        });
        return;
      }
      default: {
        // Status / partial / hooks / task / etc. — log at stderr, don't
        // forward (the protocol doesn't have slots for them yet).
        const sub = (msg as { subtype?: string }).subtype;
        logStderr(`unhandled SDK message: ${msg.type}${sub ? `/${sub}` : ""}`);
        return;
      }
    }
  }

  async sendMessage(req: SendMessageRequest, emit: Emit): Promise<void> {
    this.emitCurrent = emit;
    if (!this.prompt) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "sendMessage before start",
      });
      return;
    }
    this.prompt.push({
      type: "user",
      message: { role: "user", content: req.content },
      parent_tool_use_id: null,
    });
  }

  async respondPermission(req: PermissionResponseRequest, _emit: Emit): Promise<void> {
    const resolver = this.pendingPermissions.get(req.toolUseId);
    if (!resolver) {
      logStderr(`respondPermission: no pending request for toolUseId=${req.toolUseId}`);
      return;
    }
    if (req.decision === "approve") {
      resolver({ behavior: "allow" });
    } else {
      resolver({ behavior: "deny", message: "denied by user" });
    }
  }

  async respondEdit(req: EditResponseRequest, _emit: Emit): Promise<void> {
    // No write-intercept today; pending_edit events are never emitted, so
    // this path is a no-op. Logged for observability.
    logStderr(`respondEdit received (approved=${req.approved}) but no pending edit; ignoring`);
  }

  async cancel(_emit: Emit): Promise<void> {
    // Try the Query.interrupt() control first (cleaner shutdown), then abort.
    try {
      if (this.q && typeof this.q.interrupt === "function") {
        await this.q.interrupt().catch(() => undefined);
      }
    } catch (err) {
      logStderr(`interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.abort?.abort();
    } catch (err) {
      logStderr(`abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Resolve any pending permission requests as denied so the SDK can
    // finish unwinding.
    for (const [id, resolver] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(id);
      resolver({ behavior: "deny", message: "cancelled", interrupt: true });
    }
    // done/error is emitted by the pump when the iterator unwinds.
  }

  async close(): Promise<void> {
    // End the prompt iterable so the SDK sees EOF and the pump exits.
    this.prompt?.end();
    try {
      this.abort?.abort();
    } catch {
      // ignore
    }
    try {
      if (this.q && typeof this.q.close === "function") {
        this.q.close();
      }
    } catch (err) {
      logStderr(`close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const [id, resolver] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(id);
      resolver({ behavior: "deny", message: "closed", interrupt: true });
    }
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined);
    }
  }
}

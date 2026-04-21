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

import { promises as fsPromises } from "node:fs";
import type {
  EditResponseRequest,
  Emit,
  PermissionResponseRequest,
  RetryRequest,
  SendMessageRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  StartSessionRequest,
} from "../protocol.js";
import type { ProviderHandler } from "./base.js";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PreToolUseHookInput,
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
type EditResolver = (result: HookJSONOutput) => void;

/**
 * Tools whose PreToolUse we intercept to surface a before/after diff preview
 * via the `pending_edit` protocol event. Any other tool falls through to the
 * SDK's regular `canUseTool` permission flow.
 */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Read the current contents of `path` for the "before" side of a diff. If the
 * file doesn't exist yet (first-time Write), return an empty string. Any other
 * I/O error is also squashed to "" so the hook never blocks the model on a
 * transient read failure — the user still sees the `after` content and can
 * reject the edit.
 */
async function readBefore(path: string): Promise<string> {
  try {
    return await fsPromises.readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Apply an `Edit` tool's `old_string` → `new_string` replacement to `before`
 * exactly the way the SDK's Edit tool would, so the diff we preview matches
 * what the tool will actually produce if approved.
 */
function applyEditReplacement(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString.length === 0) return before;
  if (replaceAll) {
    // String#split/join is the simplest no-regex "replace all literal" and
    // preserves all of `newString` verbatim (no $& backreferences).
    return before.split(oldString).join(newString);
  }
  const idx = before.indexOf(oldString);
  if (idx < 0) return before;
  return before.slice(0, idx) + newString + before.slice(idx + oldString.length);
}

export class AnthropicProvider implements ProviderHandler {
  private prompt: PushableAsyncIterable<SDKUserMessage> | null = null;
  private q: Query | null = null;
  private abort: AbortController | null = null;
  private pendingPermissions = new Map<string, PermissionResolver>();
  private pendingEdits = new Map<string, EditResolver>();
  private runPromise: Promise<void> | null = null;
  private emitCurrent: Emit | null = null;
  private activeThinkingBlock = false;
  /**
   * Last user message sent this session. `retry()` re-pushes this through the
   * same streaming prompt pipeline so the model takes another pass at it.
   */
  private lastUserMessage: string | null = null;

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

    // PreToolUse hook: intercept Write / Edit / NotebookEdit, read current
    // file contents, compose before+after, and park the hook on a resolver
    // keyed by `tool_use_id`. The supervisor sends `edit_response` which
    // resolves the hook and lets the SDK proceed or abort the tool call.
    //
    // Non-write tools fall straight through with `{ continue: true }`; they
    // still go through `canUseTool` above for the regular permission prompt.
    const preToolUse: HookCallback = async (rawInput, toolUseID, { signal }) => {
      const input = rawInput as PreToolUseHookInput;
      if (!WRITE_TOOLS.has(input.tool_name)) {
        return { continue: true };
      }
      const ti = (input.tool_input ?? {}) as Record<string, unknown>;
      // File path lives under `file_path` for Write/Edit, `notebook_path` for
      // NotebookEdit. If neither is present, bail — we can't build a diff, so
      // we defer to the normal canUseTool permission flow.
      const path =
        typeof ti.file_path === "string"
          ? ti.file_path
          : typeof ti.notebook_path === "string"
            ? (ti.notebook_path as string)
            : null;
      if (!path) return { continue: true };

      let before = "";
      let after = "";
      if (input.tool_name === "Write") {
        before = await readBefore(path);
        after = typeof ti.content === "string" ? (ti.content as string) : "";
      } else if (input.tool_name === "Edit") {
        before = await readBefore(path);
        const oldString = typeof ti.old_string === "string" ? (ti.old_string as string) : "";
        const newString = typeof ti.new_string === "string" ? (ti.new_string as string) : "";
        const replaceAll = ti.replace_all === true;
        after = applyEditReplacement(before, oldString, newString, replaceAll);
      } else {
        // NotebookEdit: we don't parse the .ipynb JSON here; preview the raw
        // new_source as "after" so the user still sees what will be written.
        // Full notebook-cell diffing is a future refinement.
        before = await readBefore(path);
        after = typeof ti.new_source === "string" ? (ti.new_source as string) : "";
      }

      const key = toolUseID ?? input.tool_use_id;
      const currentEmit = this.emitCurrent;
      if (currentEmit) {
        currentEmit({
          type: "pending_edit",
          sessionId: req.sessionId,
          path,
          before,
          after,
        });
      }

      return await new Promise<HookJSONOutput>((resolve) => {
        const wrapped: EditResolver = (result) => {
          this.pendingEdits.delete(key);
          resolve(result);
        };
        this.pendingEdits.set(key, wrapped);
        // If the SDK aborts (cancel/close), deny the pending edit so the
        // hook resolves and the SDK can shut down cleanly.
        signal.addEventListener(
          "abort",
          () => {
            const entry = this.pendingEdits.get(key);
            if (!entry) return;
            this.pendingEdits.delete(key);
            resolve({ continue: false, stopReason: "cancelled" });
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
      hooks: {
        PreToolUse: [{ hooks: [preToolUse] }],
      },
      includePartialMessages: false,
      stderr: (data) => {
        // SDK internal debug/stderr; keep it on our stderr so it never
        // pollutes the NDJSON stdout channel.
        process.stderr.write(`[sidecar:anthropic:sdk] ${data}`);
      },
    };

    // Push the initial user message onto the pump, then start the query.
    prompt.push({
      type: "user",
      message: { role: "user", content: req.initialMessage },
      parent_tool_use_id: null,
    });
    this.lastUserMessage = req.initialMessage;

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
    this.lastUserMessage = req.content;
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
    // Look up the parked PreToolUse hook resolver by tool_use_id. If we find
    // one, approve/deny by resolving the hook's promise — the SDK then
    // either runs the tool or short-circuits it with our stopReason.
    //
    // The wire protocol doesn't (yet) carry `toolUseId` on edit_response, so
    // we operate on the single currently-open pending edit. In practice only
    // one edit is ever in flight per session; if that ever changes, widen
    // the wire type to include a toolUseId and key by it here.
    const entries = Array.from(this.pendingEdits.entries());
    if (entries.length === 0) {
      logStderr(`respondEdit received (approved=${req.approved}) but no pending edit; ignoring`);
      return;
    }
    for (const [id, resolver] of entries) {
      this.pendingEdits.delete(id);
      if (req.approved) {
        resolver({ continue: true });
      } else {
        resolver({ continue: false, stopReason: "User rejected edit" });
      }
    }
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
    // Same for pending PreToolUse edit hooks: resolve them as blocked so
    // the SDK's query iterator unwinds instead of hanging on our promise.
    for (const [id, resolver] of this.pendingEdits.entries()) {
      this.pendingEdits.delete(id);
      resolver({ continue: false, stopReason: "cancelled" });
    }
    // done/error is emitted by the pump when the iterator unwinds.
  }

  /**
   * Protocol v2: change the Claude SDK's permission mode mid-session. The
   * SDK's `setPermissionMode` is only supported in streaming input mode,
   * which is how we always drive the Query, so no mode-check is required.
   */
  async setPermissionMode(req: SetPermissionModeRequest, emit: Emit): Promise<void> {
    if (!this.q) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "No active session",
      });
      return;
    }
    try {
      await this.q.setPermissionMode(req.mode as PermissionMode);
    } catch (err) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: `setPermissionMode failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  /**
   * Protocol v2: change the model the SDK uses for subsequent responses.
   * Forwarded to `Query.setModel` (streaming input only).
   */
  async setModel(req: SetModelRequest, emit: Emit): Promise<void> {
    if (!this.q) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "No active session",
      });
      return;
    }
    try {
      await this.q.setModel(req.model);
    } catch (err) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: `setModel failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Protocol v2: ask the model to take another pass at the last user turn.
   * The Claude Agent SDK's `Query` does not (as of 0.2.x) expose a dedicated
   * retry/continue method; the cleanest equivalent is to re-push the most
   * recent user message through the same streaming prompt pipeline. If no
   * user message has been sent yet, emit an error — there's nothing to redo.
   */
  async retry(req: RetryRequest, emit: Emit): Promise<void> {
    if (!this.prompt) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "No active session",
      });
      return;
    }
    if (!this.lastUserMessage || this.lastUserMessage.length === 0) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "No message to retry",
      });
      return;
    }
    this.emitCurrent = emit;
    this.prompt.push({
      type: "user",
      message: { role: "user", content: this.lastUserMessage },
      parent_tool_use_id: null,
    });
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
    for (const [id, resolver] of this.pendingEdits.entries()) {
      this.pendingEdits.delete(id);
      resolver({ continue: false, stopReason: "closed" });
    }
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined);
    }
  }
}

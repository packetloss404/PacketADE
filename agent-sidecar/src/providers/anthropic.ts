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
  CancelPendingToolsRequest,
  EditResponseRequest,
  Emit,
  ImageAttachment,
  InjectUserTurnRequest,
  PermissionResponseRequest,
  PlanItem,
  PlannerToolResultRequest,
  ResumeMessage,
  RetryRequest,
  SendMessageRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  StartSessionRequest,
} from "../protocol.js";
import type { ProviderHandler } from "./base.js";
import {
  createFlightPlannerMcpServer,
  PLANNER_MCP_KEY,
} from "../mcp/flight-planner-server.js";
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
  if (req.permissionMode === "allow_all") return "bypassPermissions";
  if (req.permissionMode === "ask_for_risky") return "default";
  if (req.permissionMode === "deny_all") return "dontAsk";
  // Default: let the SDK prompt via `canUseTool`. That callback translates
  // to `permission_request` events on our wire protocol.
  return "default";
}

function toClaudePermissionMode(mode: SetPermissionModeRequest["mode"]): PermissionMode {
  switch (mode) {
    case "ask_for_risky":
      return "default";
    case "allow_all":
      return "bypassPermissions";
    case "deny_all":
      return "dontAsk";
    default:
      return mode as PermissionMode;
  }
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

/** Per-edit metadata captured at the PreToolUse hook so a later edit_response
 * carrying `mergedContent` can write the override directly. */
interface PendingEditMeta {
  resolver: EditResolver;
  path: string;
}

/**
 * Tools whose PreToolUse we intercept: with approveWrites on we surface a
 * before/after diff preview via the blocking `pending_edit` protocol event;
 * otherwise we capture the pre-edit file content and emit a non-blocking
 * `edit_baseline` so the host's review surfaces can diff applied edits
 * against the true "before" instead of live disk (P1-7). Any other tool
 * falls through to the SDK's regular `canUseTool` permission flow.
 */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Build the SDK's user-message `content` field. When attachments are present
 * we send a content array with image blocks first, then a text block — that's
 * the shape the Anthropic Messages API expects. With no attachments we keep
 * the simpler string form.
 */
function buildUserContent(
  text: string,
  attachments: ImageAttachment[] | undefined,
):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: { type: "base64"; media_type: string; data: string };
        }
    > {
  if (!attachments || attachments.length === 0) return text;
  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = attachments.map((a) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: a.media_type,
      data: a.data_base64,
    },
  }));
  blocks.push({ type: "text", text });
  return blocks;
}

function buildResumeFallbackPrompt(
  messages: ResumeMessage[] | undefined,
  nextUserMessage: string,
): string {
  if (!messages || messages.length === 0) return nextUserMessage;
  const transcript = messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  if (!transcript) return nextUserMessage;
  return [
    "Continue this PacketADE conversation using the persisted transcript below.",
    "<conversation_history>",
    transcript,
    "</conversation_history>",
    "Next user message:",
    nextUserMessage,
  ].join("\n\n");
}

/**
 * Pull a numeric `<exit_code>` out of the Bash tool's stringified result.
 * Returns null when the tag is missing or unparseable. Tolerates either an
 * `exit_code` or `exitCode` tag name and ignores surrounding whitespace.
 */
function extractBashExitCode(output: string): number | null {
  const m = output.match(/<\s*exit[_-]?code\s*>\s*(-?\d+)\s*<\s*\/\s*exit[_-]?code\s*>/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull `<output>...</output>` and `<stderr>...</stderr>` blocks out of the
 * Bash tool's stringified result. Returns the raw content with no trim so
 * the frontend can render exactly what the shell produced.
 */
function extractBashStreams(output: string): {
  stdout?: string;
  stderr?: string;
} {
  const stdoutMatch = output.match(/<\s*output\s*>([\s\S]*?)<\s*\/\s*output\s*>/i);
  const stderrMatch = output.match(/<\s*stderr\s*>([\s\S]*?)<\s*\/\s*stderr\s*>/i);
  return {
    stdout: stdoutMatch ? stdoutMatch[1] : undefined,
    stderr: stderrMatch ? stderrMatch[1] : undefined,
  };
}

/** Parse the TodoWrite tool's input into a typed PlanItem[]. */
function parseTodoWriteInput(input: unknown): PlanItem[] | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as { todos?: unknown };
  if (!Array.isArray(rec.todos)) return null;
  const items: PlanItem[] = [];
  for (const t of rec.todos) {
    if (!t || typeof t !== "object") continue;
    const r = t as { content?: unknown; status?: unknown; activeForm?: unknown; id?: unknown };
    const content =
      typeof r.content === "string"
        ? r.content
        : typeof r.activeForm === "string"
          ? r.activeForm
          : null;
    if (!content) continue;
    const status: PlanItem["status"] =
      r.status === "completed"
        ? "completed"
        : r.status === "in_progress"
          ? "in_progress"
          : "pending";
    items.push({
      id: typeof r.id === "string" ? r.id : undefined,
      content,
      status,
      activeForm: typeof r.activeForm === "string" ? r.activeForm : undefined,
    });
  }
  return items.length > 0 ? items : null;
}

/**
 * Read the current contents of `path` for the "before" side of a diff. If the
 * file doesn't exist yet (first-time Write), return null. Any other I/O error
 * is also squashed to null so the hook never blocks the model on a transient
 * read failure — the user still sees the `after` content and can reject the
 * edit. Callers that need a string "before" coalesce null to "".
 */
async function readBefore(path: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * v6 (E6-CEILING-RATELIMIT): detect whether an SDK error is a rate-limit
 * (HTTP 429) error. The Claude Agent SDK wraps the underlying Anthropic SDK
 * `RateLimitError`, but its packaging changes across versions — we cannot
 * rely on `instanceof` against a stable import. Match by:
 *
 *   1. `error.name === "RateLimitError"` (the most stable signal), OR
 *   2. `error.status === 429` (the underlying APIError's HTTP status), OR
 *   3. error type tag `"rate_limit_error"` from the API response body.
 *
 * Any of those means we should emit a typed `rate_limited` event in
 * addition to the regular `error` event.
 */
function isLikelyRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; status?: unknown; type?: unknown };
  if (typeof e.name === "string" && e.name === "RateLimitError") return true;
  if (typeof e.status === "number" && e.status === 429) return true;
  if (typeof e.type === "string" && e.type === "rate_limit_error") return true;
  return false;
}

/**
 * v6 (E6-CEILING-RATELIMIT): pull the `retry-after` header value (in
 * seconds) out of an Anthropic SDK error. Anthropic returns a numeric
 * seconds value for this header on 429 responses. Returns `undefined` if
 * the header is missing, unparseable, or the SDK didn't surface it on
 * this error object (the supervisor falls back to a default window in
 * that case).
 *
 * The header object can be either a Web `Headers` instance (the SDK's
 * v0.x.x runtime exposes one) or a plain `Record<string, string>` (older
 * shapes / mocks); we support both.
 */
function parseRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;
  let raw: string | null | undefined;
  // Web Headers instance (case-insensitive `.get`).
  if (
    typeof (headers as { get?: unknown }).get === "function" &&
    typeof headers === "object"
  ) {
    try {
      raw = (headers as { get: (k: string) => string | null }).get(
        "retry-after",
      );
    } catch {
      raw = undefined;
    }
  } else if (typeof headers === "object") {
    // Plain object: try canonical casings.
    const rec = headers as Record<string, unknown>;
    const value =
      (rec["retry-after"] as unknown) ??
      (rec["Retry-After"] as unknown) ??
      (rec["RETRY-AFTER"] as unknown);
    raw = typeof value === "string" ? value : undefined;
  }
  if (!raw) return undefined;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
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
  private pendingEdits = new Map<string, PendingEditMeta>();
  /** F5: tool_use_id → tool name + (for write tools) path. Captured at
   * `tool_use` time so the matching `tool_result` can emit a structured
   * `tool_output_extended` event with exitCode / modifiedPaths. */
  private toolUseMeta = new Map<
    string,
    { name: string; modifiedPaths?: string[] }
  >();
  private runPromise: Promise<void> | null = null;
  private emitCurrent: Emit | null = null;
  private activeThinkingBlock = false;
  /**
   * Last user message sent this session. `retry()` re-pushes this through the
   * same streaming prompt pipeline so the model takes another pass at it.
   */
  private lastUserMessage: string | null = null;
  private approveWrites = false;
  /**
   * Flight Planner (v5): when a planner MCP tool fires, the in-sidecar
   * handler emits a `planner_tool` event and parks a resolver here keyed by
   * `callId`. The Rust supervisor replies with `planner_tool_result`, which
   * `resolvePlannerTool` looks up and either resolves (success) or rejects
   * (failure). The handler then maps the resolved value into the SDK's
   * tool-result content. Only populated for sessions started with
   * `mcpKind === "planner"`.
   */
  private pendingPlannerCalls = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    this.emitCurrent = emit;
    this.abort = new AbortController();
    this.approveWrites = req.approveWrites === true;

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

    // PreToolUse hook: intercept Write / Edit / MultiEdit / NotebookEdit and
    // read the current file contents (the per-tool-call baseline). With
    // approveWrites on, compose before+after and park the hook on a resolver
    // keyed by `tool_use_id` — the supervisor sends `edit_response` which
    // resolves the hook and lets the SDK proceed or abort the tool call.
    // With approveWrites off, emit a non-blocking `edit_baseline` instead so
    // every edit-bearing tool call still records its pre-edit content.
    //
    // Non-write tools fall straight through with `{ continue: true }`; they
    // still go through `canUseTool` above for the regular permission prompt.
    const preToolUse: HookCallback = async (rawInput, toolUseID, { signal }) => {
      const input = rawInput as PreToolUseHookInput;
      if (!WRITE_TOOLS.has(input.tool_name)) {
        return { continue: true };
      }
      const ti = (input.tool_input ?? {}) as Record<string, unknown>;
      // File path lives under `file_path` for Write/Edit/MultiEdit,
      // `notebook_path` for NotebookEdit. If neither is present, bail — we
      // can't build a diff, so we defer to the normal canUseTool flow.
      const path =
        typeof ti.file_path === "string"
          ? ti.file_path
          : typeof ti.notebook_path === "string"
            ? (ti.notebook_path as string)
            : null;
      if (!path) return { continue: true };

      const key = toolUseID ?? input.tool_use_id;
      const beforeOnDisk = await readBefore(path);

      if (!this.approveWrites) {
        // P1-7: baseline capture without blocking. `before` absent = the
        // file did not exist (first-time Write).
        const baselineEmit = this.emitCurrent;
        if (baselineEmit) {
          baselineEmit({
            type: "edit_baseline",
            sessionId: req.sessionId,
            toolUseId: key,
            path,
            before: beforeOnDisk ?? undefined,
          });
        }
        return { continue: true };
      }

      const before = beforeOnDisk ?? "";
      let after: string;
      if (input.tool_name === "Write") {
        after = typeof ti.content === "string" ? (ti.content as string) : "";
      } else if (input.tool_name === "Edit") {
        const oldString = typeof ti.old_string === "string" ? (ti.old_string as string) : "";
        const newString = typeof ti.new_string === "string" ? (ti.new_string as string) : "";
        const replaceAll = ti.replace_all === true;
        after = applyEditReplacement(before, oldString, newString, replaceAll);
      } else if (input.tool_name === "MultiEdit") {
        // Sequential old→new replacements, applied the way the SDK's
        // MultiEdit tool applies them.
        after = before;
        const edits = Array.isArray(ti.edits) ? ti.edits : [];
        for (const e of edits) {
          if (!e || typeof e !== "object") continue;
          const r = e as Record<string, unknown>;
          const oldString = typeof r.old_string === "string" ? r.old_string : "";
          const newString = typeof r.new_string === "string" ? r.new_string : "";
          after = applyEditReplacement(after, oldString, newString, r.replace_all === true);
        }
      } else {
        // NotebookEdit: we don't parse the .ipynb JSON here; preview the raw
        // new_source as "after" so the user still sees what will be written.
        // Full notebook-cell diffing is a future refinement.
        after = typeof ti.new_source === "string" ? (ti.new_source as string) : "";
      }
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
        this.pendingEdits.set(key, { resolver: wrapped, path });
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

    // v5: when the supervisor asks for `mcpKind: "planner"`, construct the
    // in-sidecar Flight Planner MCP server locally and merge it under the
    // pinned `PLANNER_MCP_KEY` so the SDK exposes its tools as
    // `mcp__planner__*`. Live `McpServer` instances cannot cross the stdio
    // wire, so this is the only place planner tools come into existence.
    const wireMcp = toMcpServers(req.mcpServers ?? {});
    let mcpServers: NonNullable<Options["mcpServers"]> | undefined = wireMcp;
    if (req.mcpKind === "planner") {
      const plannerServer = createFlightPlannerMcpServer(
        req.sessionId,
        (event) => this.dispatchPlannerTool(event, emit),
      );
      mcpServers = { ...(wireMcp ?? {}), [PLANNER_MCP_KEY]: plannerServer };
    } else if (req.mcpKind && req.mcpKind.length > 0) {
      logStderr(`unknown mcpKind=${req.mcpKind}; ignoring`);
    }

    const options: Options = {
      abortController: this.abort,
      cwd: req.projectPath || undefined,
      model: req.model || undefined,
      systemPrompt: req.systemPrompt && req.systemPrompt.length > 0 ? req.systemPrompt : undefined,
      allowedTools: req.allowedTools && req.allowedTools.length > 0 ? req.allowedTools : undefined,
      mcpServers,
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
    // v3: when attachments are present, build a content array with image
    // blocks alongside the text so the model can read screenshots / images.
    //
    // Flight-planner sessions start with no human turn (empty
    // `initialMessage`) — the model waits for the user's first spec-mode
    // chat message via `inject_user_turn`. Anthropic's API rejects user
    // blocks with empty content (HTTP 400), so we must NOT push an empty
    // initial turn. Attachments are only meaningful alongside text, so an
    // empty text + no attachments means "no opening turn at all".
    const initialMessage = req.resume
      ? req.initialMessage
      : buildResumeFallbackPrompt(req.resumeMessages, req.initialMessage);
    const hasInitialMessage =
      typeof initialMessage === "string" && initialMessage.length > 0;
    if (hasInitialMessage) {
      prompt.push({
        type: "user",
        message: {
          role: "user",
          content: buildUserContent(initialMessage, req.attachments) as never,
        },
        parent_tool_use_id: null,
      });
    }
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
    // The Claude Agent SDK's `Query` is `AsyncGenerator<SDKMessage, void>` —
    // it stays open across every turn of the conversation. `handleMessage`
    // already emits `done` per `result` message, so we MUST NOT break out
    // here: the prompt iterable is shared across turns, and breaking on the
    // first `result` would silently kill any second-turn `sendMessage` /
    // `injectUserTurn` (flight-planner spike retro #2). Iterate until the
    // prompt iterable closes naturally (via `close_session` calling
    // `this.prompt.end()`) or the abort controller fires.
    try {
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        this.handleMessage(sessionId, msg, emit);
      }
    } catch (err) {
      // Abort from cancel() surfaces as an exception in some SDK versions;
      // treat named AbortError as a cancellation, everything else as error.
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      // v6 (E6-CEILING-RATELIMIT): if the SDK threw `RateLimitError`
      // (HTTP 429), emit a typed `rate_limited` event so the Rust
      // supervisor can transition the owning Flight Planner session into
      // `QuotaPaused` and arm the auto-resume timer. We duck-type on the
      // constructor `name` (and on a 429 `status` fallback) so we don't
      // have to import the SDK's error class — its packaging changes
      // across versions and the `@anthropic-ai/claude-agent-sdk` package
      // does not re-export it from a stable surface. The regular `error`
      // emit below is preserved so non-planner sessions still surface
      // the failure as they did pre-v6.
      if (isLikelyRateLimitError(err)) {
        const retryAfterSeconds = parseRetryAfterSeconds(err);
        emit({
          type: "rate_limited",
          sessionId,
          retryAfterSeconds,
          message,
        });
      }
      if (name === "AbortError" || this.abort?.signal.aborted) {
        emit({ type: "done", sessionId, inputTokens: 0, outputTokens: 0 });
      } else {
        emit({ type: "error", sessionId, message });
      }
      return;
    }
    // Iterator naturally completed (close_session). No extra `done` here —
    // each turn's `result` already emitted its own `done` via handleMessage.
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
            // F5: stash tool name + (for write tools) the modified file path
            // so the matching `tool_result` can emit a `tool_output_extended`
            // event with structured metadata.
            const inputObj = (b.input ?? {}) as Record<string, unknown>;
            const filePath =
              typeof inputObj.file_path === "string"
                ? inputObj.file_path
                : typeof inputObj.notebook_path === "string"
                  ? (inputObj.notebook_path as string)
                  : undefined;
            this.toolUseMeta.set(b.id, {
              name: b.name,
              modifiedPaths:
                WRITE_TOOLS.has(b.name) && filePath ? [filePath] : undefined,
            });
            // v3: TodoWrite tool calls double as a structured plan event so
            // the frontend can pin them in a dedicated panel rather than
            // hunt through the transcript.
            if (b.name === "TodoWrite") {
              const items = parseTodoWriteInput(b.input);
              if (items) {
                emit({ type: "plan_block", sessionId, items });
              }
            }
          }
          // Other block types (server_tool_use, redacted_thinking, etc.)
          // are intentionally ignored for now.
        }
        // Close any dangling thinking block at end of the assistant message.
        if (this.activeThinkingBlock) {
          emit({ type: "thinking_stop", sessionId });
          this.activeThinkingBlock = false;
        }
        // F6: emit a turn_summary with this assistant message's usage so the
        // frontend's SessionHealthBar can show live tokens between turns
        // instead of waiting for the final `done` event.
        const usage = (msg.message as { usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
        }}).usage;
        if (usage) {
          emit({
            type: "turn_summary",
            sessionId,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
          });
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
            // F5: structured metadata follow-up — exit code for Bash,
            // modifiedPaths for Write/Edit/NotebookEdit. Skipped silently
            // if there's nothing extra to add (no point flooding the wire).
            const meta = this.toolUseMeta.get(b.tool_use_id);
            this.toolUseMeta.delete(b.tool_use_id);
            if (meta) {
              const extras: {
                exitCode?: number;
                modifiedPaths?: string[];
                stdout?: string;
                stderr?: string;
              } = {};
              if (meta.name === "Bash") {
                const code = extractBashExitCode(output);
                if (code !== null) extras.exitCode = code;
                const streams = extractBashStreams(output);
                if (streams.stdout !== undefined) extras.stdout = streams.stdout;
                if (streams.stderr !== undefined) extras.stderr = streams.stderr;
              }
              if (meta.modifiedPaths && meta.modifiedPaths.length > 0) {
                extras.modifiedPaths = meta.modifiedPaths;
              }
              if (Object.keys(extras).length > 0) {
                emit({
                  type: "tool_output_extended",
                  sessionId,
                  toolUseId: b.tool_use_id,
                  ...extras,
                });
              }
            }
          }
        }
        return;
      }
      case "result": {
        const result = msg as {
          usage?: { input_tokens?: number; output_tokens?: number };
          session_id?: string;
        };
        const usage = result.usage;
        emit({
          type: "done",
          sessionId,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          resumeToken: result.session_id,
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
      message: {
        role: "user",
        content: buildUserContent(req.content, req.attachments) as never,
      },
      parent_tool_use_id: null,
    });
    this.lastUserMessage = req.content;
  }

  /**
   * v5: inject a new user turn into the long-lived session. Two source kinds:
   *
   *  - `"user"`: pushed verbatim. Lets the spec-mode chat path reuse the same
   *    dispatcher as wake triggers without forcing a synthetic envelope.
   *  - `"wake_trigger"`: wrapped in
   *    `<wake_trigger source="wake_trigger" kind="<kind>">…</wake_trigger>`
   *    so the planner system prompt can distinguish re-entry from a human
   *    turn (flight-planner spec §Transport).
   *
   * Same underlying push as `sendMessage` — the shared `PushableAsyncIterable`
   * serializes bursty injects cleanly, and the SDK iterates the prompt
   * iterable strictly serially (spike retro #2).
   */
  async injectUserTurn(req: InjectUserTurnRequest, emit: Emit): Promise<void> {
    this.emitCurrent = emit;
    if (!this.prompt) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "injectUserTurn before start",
      });
      return;
    }
    let content: string;
    if (req.source === "wake_trigger") {
      const kind = req.trigger?.kind ?? "user";
      // Attributes are quoted; we strip quote characters from the kind to
      // keep the envelope well-formed. Source label is fixed by the brief.
      const safeKind = kind.replace(/["<>]/g, "");
      content = `<wake_trigger source="wake_trigger" kind="${safeKind}">${req.content}</wake_trigger>`;
    } else {
      content = req.content;
    }
    // E6-CAPS: honor the requested per-turn `maxOutputTokens` if the SDK
    // exposes a setter. As of Claude Agent SDK 0.2.116, `Query` only exposes
    // `setMaxThinkingTokens` (deprecated) and `applyFlagSettings` (which
    // doesn't carry an output-tokens field). There is no per-turn
    // `max_tokens` knob — output token budget is set at session start via
    // `Options.taskBudget` and can't be changed mid-session. We log the
    // request once so the planner-side intent is visible in stderr, then
    // proceed with the SDK's defaults. If a future SDK version exposes a
    // setter, this is the hook point.
    if (typeof req.maxOutputTokens === "number" && req.maxOutputTokens > 0) {
      logStderr(
        `injectUserTurn: maxOutputTokens=${req.maxOutputTokens} requested but ` +
          `SDK 0.2.116 has no per-turn max_tokens setter; honoring session-start ` +
          `defaults (sessionId=${req.sessionId})`,
      );
    }
    this.prompt.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    this.lastUserMessage = content;
  }

  /**
   * v5: resolve (or reject) an outstanding planner MCP tool call. Called by
   * the registry when the Rust supervisor returns a `planner_tool_result`.
   * No-op if the callId is unknown (e.g. arrived after a cancel).
   */
  async respondPlannerTool(
    req: PlannerToolResultRequest,
    _emit: Emit,
  ): Promise<void> {
    const pending = this.pendingPlannerCalls.get(req.callId);
    if (!pending) {
      logStderr(
        `respondPlannerTool: unknown callId=${req.callId} (session=${req.sessionId})`,
      );
      return;
    }
    this.pendingPlannerCalls.delete(req.callId);
    if (req.success) {
      pending.resolve(req.result);
    } else {
      pending.reject(new Error(req.error ?? "planner tool failed"));
    }
  }

  /**
   * Internal: emit a `planner_tool` envelope and park a resolver. The
   * planner MCP server in `flight-planner-server.ts` awaits this promise
   * inside the tool's handler, so the SDK's `tool_use → tool_result` round
   * trip stays well-formed.
   */
  private dispatchPlannerTool(
    event: import("../protocol.js").PlannerToolCallEvent,
    emit: Emit,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.pendingPlannerCalls.set(event.callId, { resolve, reject });
      try {
        emit(event);
      } catch (err) {
        this.pendingPlannerCalls.delete(event.callId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async respondPermission(req: PermissionResponseRequest, _emit: Emit): Promise<void> {
    const resolver = this.pendingPermissions.get(req.toolUseId);
    if (!resolver) {
      logStderr(`respondPermission: no pending request for toolUseId=${req.toolUseId}`);
      return;
    }
    if (
      req.decision === "approve" ||
      req.decision === "allow_once" ||
      req.decision === "allow_always"
    ) {
      resolver({ behavior: "allow" });
    } else {
      // Deny-and-continue: no `interrupt`, so the SDK fabricates a tool
      // result and the turn keeps going. The user's reason (when given)
      // becomes that result's message, steering the model's next step.
      const reason =
        typeof req.reason === "string" ? req.reason.trim() : "";
      resolver({
        behavior: "deny",
        message:
          reason.length > 0
            ? `Denied by user. User's guidance: ${reason}`
            : "denied by user",
      });
    }
  }

  async respondEdit(req: EditResponseRequest, _emit: Emit): Promise<void> {
    // Look up the parked PreToolUse hook resolver. The wire protocol doesn't
    // yet carry `toolUseId` on edit_response, so we operate on the single
    // currently-open pending edit. In practice only one edit is ever in
    // flight per session.
    //
    // v3: when `mergedContent` is supplied (per-hunk acceptance), we write
    // the override directly to disk first, then DENY the SDK's tool — the
    // file is already at the desired state, so letting the SDK's Write run
    // would clobber our merged result with the original `after`.
    const entries = Array.from(this.pendingEdits.entries());
    if (entries.length === 0) {
      logStderr(
        `respondEdit received (approved=${req.approved}) but no pending edit; ignoring`,
      );
      return;
    }
    for (const [id, meta] of entries) {
      this.pendingEdits.delete(id);
      if (!req.approved) {
        meta.resolver({ continue: false, stopReason: "User rejected edit" });
        continue;
      }
      if (typeof req.mergedContent === "string" && meta.path) {
        try {
          await fsPromises.writeFile(meta.path, req.mergedContent, "utf8");
          // File is now at the user-merged state; tell the SDK to skip its
          // own write so it doesn't overwrite us with the model's `after`.
          meta.resolver({
            continue: false,
            stopReason: "Edit applied with user-merged hunks",
          });
          continue;
        } catch (err) {
          logStderr(
            `mergedContent write failed for ${meta.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Fall through to a regular approve so the model's full edit lands.
        }
      }
      meta.resolver({ continue: true });
    }
  }

  /**
   * F8: drain every parked permission_request and pending_edit hook as
   * "denied" without aborting the abort controller or interrupting the
   * SDK query. The model receives a synthetic tool_result for each tool
   * ("User cancelled this tool") and keeps generating. Use `cancel()`
   * (not this) when the user wants the whole session to stop.
   */
  async cancelPendingTools(
    _req: CancelPendingToolsRequest,
    _emit: Emit,
  ): Promise<void> {
    // Permissions: deny WITHOUT interrupt — the SDK fabricates a
    // tool_result and feeds it back to the model. interrupt:true would
    // abort the streaming input pipeline.
    for (const [id, resolver] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(id);
      resolver({ behavior: "deny", message: "User cancelled this tool" });
    }
    // PreToolUse edit hooks: continue:true short-circuits the actual write
    // but keeps the iterator alive. The synthetic stopReason becomes the
    // tool's "result" content fed back to the model.
    for (const [id, meta] of this.pendingEdits.entries()) {
      this.pendingEdits.delete(id);
      meta.resolver({
        continue: false,
        stopReason: "User cancelled this tool",
      });
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
    for (const [id, meta] of this.pendingEdits.entries()) {
      this.pendingEdits.delete(id);
      meta.resolver({ continue: false, stopReason: "cancelled" });
    }
    // v5: drain parked planner tool calls so the SDK tool handlers don't
    // hang waiting for a result that will never come.
    for (const [id, pending] of this.pendingPlannerCalls.entries()) {
      this.pendingPlannerCalls.delete(id);
      pending.reject(new Error("cancelled"));
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
      await this.q.setPermissionMode(toClaudePermissionMode(req.mode));
      if (req.mode === "acceptEdits") {
        this.approveWrites = true;
      } else if (req.mode === "default") {
        this.approveWrites = false;
      }
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
    for (const [id, meta] of this.pendingEdits.entries()) {
      this.pendingEdits.delete(id);
      meta.resolver({ continue: false, stopReason: "closed" });
    }
    for (const [id, pending] of this.pendingPlannerCalls.entries()) {
      this.pendingPlannerCalls.delete(id);
      pending.reject(new Error("closed"));
    }
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined);
    }
  }
}

// OpenAI Agents SDK provider (API-key auth).
//
// This provider intentionally lives beside, rather than replacing,
// `openai-codex`. Codex CLI remains the ChatGPT subscription path; this file
// is the BYOK OpenAI Agents SDK path and translates SDK runs into PacketADE's
// existing sidecar protocol.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import {
  Agent,
  MCPServerStdio,
  MemorySession,
  run,
  setDefaultOpenAIKey,
  setTracingDisabled,
  tool,
  type AgentInputItem,
  type MCPServer,
  type RunStreamEvent,
  type RunState,
  type RunToolApprovalItem,
  type Tool,
} from "@openai/agents";
import { z } from "zod";
import type {
  CancelPendingToolsRequest,
  EditResponseRequest,
  Emit,
  ImageAttachment,
  PermissionMode,
  PermissionResponseRequest,
  ResumeMessage,
  RetryRequest,
  SendMessageRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  StartSessionRequest,
} from "../protocol.js";
import type { ProviderHandler } from "./base.js";

const MAX_FILE_SIZE = 2_000_000;
const MAX_OUTPUT_SIZE = 262_144;
const DEFAULT_TIMEOUT_SECS = 30;
const MAX_TIMEOUT_SECS = 120;
const MAX_GREP_RESULTS = 100;
const RISKY_TOOLS = new Set(["bash", "write_file"]);
const PLAN_MODE_ALLOWED = new Set(["read_file", "list_directory", "grep"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".git",
  ".next",
  ".cache",
  ".tauri",
]);

type QueuedTurn = {
  input: string | AgentInputItem[];
  userText: string;
};
type ToolCallDetails = {
  toolCall?: { callId?: string; id?: string };
};
type PendingEdit = {
  resolve: (value: { approved: boolean; content?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

const ReadFileParams = z.object({ path: z.string() });
const WriteFileParams = z.object({
  path: z.string(),
  content: z.string(),
});
const ListDirectoryParams = z.object({ path: z.string().optional() });
const BashParams = z.object({
  command: z.string(),
  timeout: z.number().int().positive().optional(),
});
const GrepParams = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
});

type ReadFileInput = z.infer<typeof ReadFileParams>;
type WriteFileInput = z.infer<typeof WriteFileParams>;
type ListDirectoryInput = z.infer<typeof ListDirectoryParams>;
type BashInput = z.infer<typeof BashParams>;
type GrepInput = z.infer<typeof GrepParams>;

const logStderr = (msg: string): void => {
  process.stderr.write(`[sidecar:openai-agents] ${msg}\n`);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberField(value: unknown, ...keys: string[]): number {
  if (!isRecord(value)) return 0;
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "number" && Number.isFinite(found)) return found;
  }
  return 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Terminate a spawned shell *and its descendants*. A bare `child.kill()` only
 * signals the shell (`shell: true`), leaving the actual command (build, node,
 * etc.) running as an orphan that holds the project dir / ports. On POSIX the
 * child is a process-group leader (spawned `detached: true`), so we signal the
 * whole group via the negative PID. On Windows there are no process groups, so
 * we use `taskkill /T /F` to walk and kill the tree. All paths are wrapped so a
 * race where the child already exited never throws.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  if (process.platform === "win32") {
    try {
      const tk = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
      // A taskkill launch failure (e.g. ENOENT) surfaces asynchronously via the
      // child's `error` event, not as a throw; without a listener Node escalates
      // it to an unhandled exception that would crash the sidecar.
      tk.on("error", (err) => logStderr(`taskkill failed for pid ${pid}: ${errorMessage(err)}`));
    } catch (err) {
      logStderr(`taskkill failed for pid ${pid}: ${errorMessage(err)}`);
    }
    return;
  }
  try {
    // Negative PID => signal the entire process group (child is the leader).
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    logStderr(`group kill failed for pid ${pid}: ${errorMessage(err)}`);
  }
}

function truncateToLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return `${text.slice(0, end)}\n... [output truncated]`;
}

function approvalId(item: RunToolApprovalItem): string {
  const raw = item.rawItem as { callId?: string; id?: string };
  return raw.callId ?? raw.id ?? `${item.name ?? "tool"}-${Date.now()}`;
}

function toolCallId(details: ToolCallDetails | undefined, fallbackName: string): string {
  const call = details?.toolCall as { callId?: string; id?: string } | undefined;
  return call?.callId ?? call?.id ?? `${fallbackName}-${Date.now()}`;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function buildUserInput(
  text: string,
  attachments?: ImageAttachment[],
): string | AgentInputItem[] {
  if (!attachments || attachments.length === 0) return text;
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text },
        ...attachments.map((attachment) => ({
          type: "input_image" as const,
          image: `data:${attachment.media_type};base64,${attachment.data_base64}`,
          detail: "auto",
        })),
      ],
    } as AgentInputItem,
  ];
}

function resumeMessagesToAgentItems(messages: ResumeMessage[] | undefined): AgentInputItem[] {
  if (!messages || messages.length === 0) return [];
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: message.content }],
        } as AgentInputItem;
      }
      if (message.role === "system") {
        return {
          role: "system",
          content: message.content,
        } as AgentInputItem;
      }
      return {
        role: "user",
        content: message.content,
      } as AgentInputItem;
    });
}

export class OpenAIAgentsProvider implements ProviderHandler {
  private sessionId = "";
  private projectPath = "";
  private projectRoot = "";
  private model = "";
  private systemPrompt = "";
  private allowedTools: string[] = [];
  private agent: Agent | null = null;
  private session: MemorySession | null = null;
  private emitCurrent: Emit | null = null;
  private abort: AbortController | null = null;
  private queue: QueuedTurn[] = [];
  private running = false;
  private interruptedState: RunState<unknown, Agent> | null = null;
  private pendingApprovals = new Map<
    string,
    { item: RunToolApprovalItem; name: string }
  >();
  private pendingEdits = new Map<string, PendingEdit>();
  private autoAllowedTools = new Set<string>();
  private emittedToolStarts = new Set<string>();
  private permissionMode: PermissionMode = "auto";
  private planMode = false;
  private approveWrites = false;
  private lastTurn: QueuedTurn | null = null;
  private mcpServers: MCPServer[] = [];
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadInputTokens = 0;
  private cacheCreationInputTokens = 0;

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    this.emitCurrent = emit;
    this.sessionId = req.sessionId;
    this.projectPath = req.projectPath;
    this.projectRoot = await fsPromises.realpath(req.projectPath);
    this.model = req.model;
    this.systemPrompt = req.systemPrompt;
    this.allowedTools = req.allowedTools ?? [];
    this.planMode = req.planMode === true;
    this.permissionMode = req.permissionMode ?? "auto";
    this.approveWrites = req.approveWrites === true;

    if (!req.apiKey || req.apiKey.trim().length === 0) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "No OpenAI API key was provided to the OpenAI Agents SDK provider.",
      });
      return;
    }

    setDefaultOpenAIKey(req.apiKey);
    setTracingDisabled(true);

    this.mcpServers = this.buildMcpServers(req.mcpServers ?? {});
    this.session = new MemorySession({
      sessionId: req.sessionId,
      initialItems: resumeMessagesToAgentItems(req.resumeMessages),
    });
    this.agent = this.buildAgent();
    this.enqueue(
      buildUserInput(req.initialMessage, req.attachments),
      req.initialMessage,
      emit,
    );
  }

  async sendMessage(req: SendMessageRequest, emit: Emit): Promise<void> {
    this.enqueue(buildUserInput(req.content, req.attachments), req.content, emit);
  }

  async respondPermission(req: PermissionResponseRequest, emit: Emit): Promise<void> {
    this.emitCurrent = emit;
    const pending = this.pendingApprovals.get(req.toolUseId);
    if (!pending || !this.interruptedState) {
      logStderr(`respondPermission: no pending request for ${req.toolUseId}`);
      return;
    }

    this.pendingApprovals.delete(req.toolUseId);
    if (
      req.decision === "approve" ||
      req.decision === "allow_once" ||
      req.decision === "allow_always"
    ) {
      if (req.decision === "allow_always") {
        this.autoAllowedTools.add(pending.name);
      }
      this.interruptedState.approve(pending.item, {
        alwaysApprove: req.decision === "allow_always",
      });
    } else {
      this.interruptedState.reject(pending.item, {
        message: "User denied permission for this tool call.",
      });
    }

    if (this.pendingApprovals.size === 0) {
      const state = this.interruptedState;
      this.interruptedState = null;
      this.runState(state, emit);
    }
  }

  async respondEdit(req: EditResponseRequest, _emit: Emit): Promise<void> {
    const entries = Array.from(this.pendingEdits.entries());
    if (entries.length === 0) {
      logStderr(`respondEdit: no pending edit (approved=${req.approved})`);
      return;
    }

    for (const [id, pending] of entries) {
      clearTimeout(pending.timer);
      this.pendingEdits.delete(id);
      pending.resolve({
        approved: req.approved,
        content: typeof req.mergedContent === "string" ? req.mergedContent : undefined,
      });
    }
  }

  async cancelPendingTools(
    _req: CancelPendingToolsRequest,
    emit: Emit,
  ): Promise<void> {
    this.emitCurrent = emit;
    for (const [id, pending] of this.pendingEdits.entries()) {
      clearTimeout(pending.timer);
      this.pendingEdits.delete(id);
      pending.resolve({ approved: false });
    }
    if (this.interruptedState) {
      for (const pending of this.pendingApprovals.values()) {
        this.interruptedState.reject(pending.item, {
          message: "User cancelled this tool.",
        });
      }
      this.pendingApprovals.clear();
      const state = this.interruptedState;
      this.interruptedState = null;
      this.runState(state, emit);
    }
  }

  async cancel(emit: Emit): Promise<void> {
    this.emitCurrent = emit;
    this.queue = [];
    this.pendingApprovals.clear();
    this.interruptedState = null;
    for (const [id, pending] of this.pendingEdits.entries()) {
      clearTimeout(pending.timer);
      this.pendingEdits.delete(id);
      pending.resolve({ approved: false });
    }
    this.abort?.abort();
    if (!this.running) this.emitDone();
  }

  async close(): Promise<void> {
    this.abort?.abort();
    for (const server of this.mcpServers) {
      await server.close().catch((err) => {
        logStderr(`MCP close failed for ${server.name}: ${errorMessage(err)}`);
      });
    }
  }

  async setPermissionMode(
    req: SetPermissionModeRequest,
    _emit: Emit,
  ): Promise<void> {
    switch (req.mode) {
      case "plan":
        this.planMode = true;
        break;
      case "default":
        this.planMode = false;
        this.approveWrites = false;
        this.permissionMode = "auto";
        break;
      case "acceptEdits":
        this.planMode = false;
        this.approveWrites = true;
        break;
      case "bypassPermissions":
        this.planMode = false;
        this.permissionMode = "allow_all";
        break;
      case "dontAsk":
        this.planMode = false;
        this.permissionMode = "deny_all";
        break;
      case "auto":
      case "ask_for_risky":
      case "allow_all":
      case "deny_all":
        this.planMode = false;
        this.permissionMode = req.mode;
        break;
      default:
        logStderr(`Unknown permission mode: ${req.mode}`);
        break;
    }
  }

  async setModel(req: SetModelRequest, _emit: Emit): Promise<void> {
    this.model = req.model;
    this.agent = this.buildAgent();
  }

  async retry(_req: RetryRequest, emit: Emit): Promise<void> {
    if (!this.lastTurn) {
      emit({
        type: "error",
        sessionId: this.sessionId,
        message: "No message to retry",
      });
      return;
    }
    this.enqueue(this.lastTurn.input, this.lastTurn.userText, emit);
  }

  private buildAgent(): Agent {
    return new Agent({
      name: "PacketADE OpenAI Agent",
      instructions: this.systemPrompt || undefined,
      model: this.model || undefined,
      tools: this.buildTools(),
      mcpServers: this.mcpServers,
      mcpConfig: { includeServerInToolNames: false },
    });
  }

  private buildTools(): Tool[] {
    const all: Record<string, Tool> = {
      read_file: tool({
        name: "read_file",
        description:
          "Read the contents of a file. Returns the file text. Use this to understand existing code before making changes.",
        parameters: ReadFileParams,
        execute: async (input, _context, details) =>
          this.executeWithEvents(
            "read_file",
            input,
            details,
            () => this.readFile(input),
          ),
      }),
      write_file: tool({
        name: "write_file",
        description:
          "Write content to a file. Creates the file if it doesn't exist, or overwrites it. Creates parent directories as needed.",
        parameters: WriteFileParams,
        needsApproval: async (_context, input) =>
          this.needsPermission("write_file", input),
        execute: async (input, _context, details) =>
          this.executeWithEvents(
            "write_file",
            input,
            details,
            () => this.writeFile(input, toolCallId(details, "write_file")),
          ),
      }),
      list_directory: tool({
        name: "list_directory",
        description:
          "List files and directories in a given path. Returns names with [DIR] prefix for directories.",
        parameters: ListDirectoryParams,
        execute: async (input, _context, details) =>
          this.executeWithEvents(
            "list_directory",
            input,
            details,
            () => this.listDirectory(input),
          ),
      }),
      bash: tool({
        name: "bash",
        description:
          "Execute a shell command in the project directory. Returns stdout and stderr. Use for running tests, builds, git commands, etc.",
        parameters: BashParams,
        needsApproval: async (_context, input) => this.needsPermission("bash", input),
        execute: async (input, _context, details) =>
          this.executeWithEvents("bash", input, details, () =>
            this.bash(input, toolCallId(details, "bash")),
          ),
      }),
      grep: tool({
        name: "grep",
        description:
          "Search for a pattern in files. Returns matching lines with file paths and line numbers.",
        parameters: GrepParams,
        execute: async (input, _context, details) =>
          this.executeWithEvents("grep", input, details, () => this.grep(input)),
      }),
    };

    if (this.allowedTools.length === 0) return Object.values(all);
    const allowed = new Set(this.allowedTools);
    return Object.entries(all)
      .filter(([name]) => allowed.has(name))
      .map(([, value]) => value);
  }

  private buildMcpServers(raw: Record<string, unknown>): MCPServer[] {
    const servers: MCPServer[] = [];
    for (const [name, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      if (value.type !== "stdio") continue;
      if (typeof value.command !== "string") continue;
      const args = Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      const env = isRecord(value.env)
        ? Object.fromEntries(
            Object.entries(value.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
      servers.push(
        new MCPServerStdio({
          name,
          command: value.command,
          args,
          env,
          cwd: this.projectPath,
          cacheToolsList: true,
        }),
      );
    }
    return servers;
  }

  private enqueue(
    input: string | AgentInputItem[],
    userText: string,
    emit: Emit,
  ): void {
    this.emitCurrent = emit;
    const turn = { input, userText };
    this.queue.push(turn);
    this.lastTurn = turn;
    this.kickQueue();
  }

  private kickQueue(): void {
    if (this.running || this.interruptedState || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    void this.runInput(next.input).finally(() => {
      this.running = false;
      if (!this.interruptedState) this.kickQueue();
    });
  }

  private runState(state: RunState<unknown, Agent>, emit: Emit): void {
    this.emitCurrent = emit;
    if (this.running) return;
    this.running = true;
    void this.runInput(state).finally(() => {
      this.running = false;
      if (!this.interruptedState) this.kickQueue();
    });
  }

  private async runInput(
    input: string | AgentInputItem[] | RunState<unknown, Agent>,
  ): Promise<void> {
    if (!this.agent) {
      this.emitError("OpenAI Agents SDK provider started without an agent");
      return;
    }

    this.abort = new AbortController();
    this.emittedToolStarts.clear();
    try {
      const fromInterruptedState = typeof input !== "string" && !Array.isArray(input);
      const result = await run(this.agent, input, {
        stream: true,
        signal: this.abort.signal,
        maxTurns: 25,
        session: fromInterruptedState ? undefined : this.session ?? undefined,
      });

      for await (const event of result) {
        this.handleStreamEvent(event);
      }
      await result.completed;

      const interruptions = result.interruptions;
      if (interruptions.length > 0) {
        this.interruptedState = result.state;
        for (const item of interruptions) this.emitApproval(item);
        return;
      }

      this.emitDone();
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.emitDone();
      } else {
        this.emitError(errorMessage(err));
      }
    }
  }

  private handleStreamEvent(event: RunStreamEvent): void {
    if (event.type !== "raw_model_stream_event") {
      if (
        event.type === "run_item_stream_event" &&
        event.name === "tool_approval_requested" &&
        event.item.type === "tool_approval_item"
      ) {
        this.emitApproval(event.item);
      }
      return;
    }

    const data = event.data as unknown;
    if (!isRecord(data)) return;
    if (data.type === "output_text_delta" && typeof data.delta === "string") {
      this.emitCurrent?.({
        type: "chunk",
        sessionId: this.sessionId,
        text: data.delta,
      });
      return;
    }
    if (data.type === "response_done" && isRecord(data.response)) {
      this.recordUsage(data.response.usage);
    }
    if (
      data.type === "reasoning_text_delta" &&
      typeof data.delta === "string"
    ) {
      this.emitCurrent?.({
        type: "thinking",
        sessionId: this.sessionId,
        text: data.delta,
      });
    }
  }

  private emitApproval(item: RunToolApprovalItem): void {
    const id = approvalId(item);
    if (this.pendingApprovals.has(id)) return;
    const name = item.name ?? "tool";
    const input = parseMaybeJson(item.arguments);
    this.pendingApprovals.set(id, { item, name });
    this.emitCurrent?.({
      type: "permission_request",
      sessionId: this.sessionId,
      toolUseId: id,
      name,
      input,
    });
  }

  private recordUsage(usage: unknown): void {
    if (!isRecord(usage)) return;
    this.inputTokens += numberField(usage, "inputTokens", "input_tokens");
    this.outputTokens += numberField(usage, "outputTokens", "output_tokens");
    const inputDetails = usage.inputTokensDetails ?? usage.input_tokens_details;
    this.cacheReadInputTokens += numberField(
      inputDetails,
      "cachedTokens",
      "cached_tokens",
      "cacheReadInputTokens",
      "cache_read_input_tokens",
    );
    this.cacheCreationInputTokens += numberField(
      inputDetails,
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    );
  }

  private emitDone(): void {
    this.emitCurrent?.({
      type: "done",
      sessionId: this.sessionId,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadInputTokens: this.cacheReadInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
    });
  }

  private emitError(message: string): void {
    this.emitCurrent?.({
      type: "error",
      sessionId: this.sessionId,
      message,
    });
  }

  private emitToolStart(id: string, name: string): void {
    if (this.emittedToolStarts.has(id)) return;
    this.emittedToolStarts.add(id);
    this.emitCurrent?.({
      type: "tool_start",
      sessionId: this.sessionId,
      toolUseId: id,
      name,
    });
  }

  private emitToolResult(
    id: string,
    name: string,
    input: unknown,
    output: string,
    isError: boolean,
  ): void {
    this.emitCurrent?.({
      type: "tool_result",
      sessionId: this.sessionId,
      toolUseId: id,
      name,
      input,
      output,
      isError,
    });
  }

  private async executeWithEvents<TInput>(
    name: string,
    input: TInput,
    details: ToolCallDetails | undefined,
    execute: () => Promise<string>,
  ): Promise<string> {
    const id = toolCallId(details, name);
    this.emitToolStart(id, name);
    try {
      this.assertToolAllowed(name);
      const output = await execute();
      this.emitToolResult(id, name, input, output, false);
      return output;
    } catch (err) {
      const output = `Error: ${errorMessage(err)}`;
      this.emitToolResult(id, name, input, output, true);
      return output;
    }
  }

  private assertToolAllowed(name: string): void {
    if (this.planMode && !PLAN_MODE_ALLOWED.has(name)) {
      throw new Error(
        `Plan mode is active; '${name}' is disabled. Ask the user to exit plan mode first.`,
      );
    }
    if (RISKY_TOOLS.has(name) && this.permissionMode === "deny_all") {
      throw new Error("Permissions: all risky tools are denied.");
    }
  }

  private needsPermission(name: string, _input: unknown): boolean {
    if (!RISKY_TOOLS.has(name)) return false;
    if (this.planMode || this.permissionMode === "deny_all") return false;
    if (this.permissionMode === "allow_all") return false;
    if (this.autoAllowedTools.has(name)) return false;
    // When approveWrites is on, write_file runs its own pending_edit diff
    // round-trip (see writeFile / waitForEdit) which is the single approval
    // gate for that tool. Suppress the SDK-level permission prompt here so the
    // user isn't prompted twice for the same write. Mirrors anthropic.ts, where
    // the PreToolUse diff hook owns approval for write tools under approveWrites
    // and non-write tools still flow through the normal permission prompt.
    if (name === "write_file" && this.approveWrites) return false;
    // 'auto' (the default mode) now gates risky tools the same as
    // 'ask_for_risky': pause for an explicit approval before running.
    return (
      this.permissionMode === "ask_for_risky" || this.permissionMode === "auto"
    );
  }

  private async resolveInsideProject(
    requestedPath: string,
    mustExist: boolean,
  ): Promise<string> {
    const candidate = path.resolve(
      path.isAbsolute(requestedPath)
        ? requestedPath
        : path.join(this.projectPath, requestedPath),
    );

    if (mustExist || (await exists(candidate))) {
      const real = await fsPromises.realpath(candidate);
      this.assertInsideProject(real, requestedPath);
      return real;
    }

    let existing = path.dirname(candidate);
    while (!(await exists(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error(`Cannot resolve path '${requestedPath}'`);
      }
      existing = parent;
    }
    const realExisting = await fsPromises.realpath(existing);
    this.assertInsideProject(realExisting, requestedPath);
    const suffix = path.relative(existing, candidate);
    const resolved = path.join(realExisting, suffix);
    this.assertInsideProject(resolved, requestedPath);
    return resolved;
  }

  private assertInsideProject(candidate: string, requestedPath: string): void {
    const relative = path.relative(this.projectRoot, candidate);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return;
    }
    throw new Error(`Path '${requestedPath}' is outside the project`);
  }

  private async readFile(input: ReadFileInput): Promise<string> {
    const filePath = await this.resolveInsideProject(input.path, true);
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) throw new Error(`'${input.path}' is not a file`);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${stat.size} bytes, limit ${MAX_FILE_SIZE} bytes)`,
      );
    }
    return fsPromises.readFile(filePath, "utf8");
  }

  private async writeFile(input: WriteFileInput, toolUseId: string): Promise<string> {
    const filePath = await this.resolveInsideProject(input.path, false);
    let content = input.content;

    if (this.approveWrites) {
      const before = (await fsPromises.readFile(filePath, "utf8").catch(() => null)) ?? null;
      this.emitCurrent?.({
        type: "pending_edit",
        sessionId: this.sessionId,
        toolUseId,
        path: input.path,
        before: before ?? undefined,
        after: input.content,
      });
      const decision = await this.waitForEdit(toolUseId);
      if (!decision.approved) throw new Error("User rejected this edit.");
      if (typeof decision.content === "string") {
        content = decision.content;
      }
    }

    const parent = path.dirname(filePath);
    await fsPromises.mkdir(parent, { recursive: true });
    const realParent = await fsPromises.realpath(parent);
    this.assertInsideProject(realParent, input.path);
    await fsPromises.writeFile(filePath, content, "utf8");
    this.emitCurrent?.({
      type: "tool_output_extended",
      sessionId: this.sessionId,
      toolUseId,
      modifiedPaths: [filePath],
    });
    return `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${input.path}`;
  }

  private waitForEdit(toolUseId: string): Promise<{ approved: boolean; content?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingEdits.delete(toolUseId);
        resolve({ approved: false });
      }, 600_000);
      this.pendingEdits.set(toolUseId, { resolve, timer });
    });
  }

  private async listDirectory(input: ListDirectoryInput): Promise<string> {
    const requestedPath = input.path ?? ".";
    const dirPath = await this.resolveInsideProject(requestedPath, true);
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    const lines = entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
      .map((entry) => (entry.isDirectory() ? `[DIR] ${entry.name}` : entry.name))
      .sort((a, b) => a.localeCompare(b));
    return lines.join("\n");
  }

  private async bash(input: BashInput, toolUseId: string): Promise<string> {
    const timeoutSecs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_SECS, MAX_TIMEOUT_SECS);
    const output = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn(input.command, {
        cwd: this.projectPath,
        shell: true,
        windowsHide: true,
        // POSIX: make the shell a process-group leader so killTree can signal
        // the whole group (the shell + the command it spawned). No-op semantics
        // on Windows, where killTree falls back to `taskkill /T`.
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutSecs * 1000);
      // If the run is cancelled/closed, tear down the shell + descendants too —
      // otherwise the orphaned command keeps holding the project dir / ports.
      const onAbort = (): void => {
        killTree(child);
      };
      this.abort?.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > MAX_OUTPUT_SIZE * 2) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE * 2);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_OUTPUT_SIZE * 2) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE * 2);
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        this.abort?.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.abort?.signal.removeEventListener("abort", onAbort);
        resolve({ code, stdout, stderr, timedOut });
      });
    });

    let result = output.stdout;
    if (output.stderr.length > 0) {
      if (result.length > 0) result += "\n--- stderr ---\n";
      result += output.stderr;
    }
    result = truncateToLimit(result, MAX_OUTPUT_SIZE);
    this.emitCurrent?.({
      type: "tool_output_extended",
      sessionId: this.sessionId,
      toolUseId,
      exitCode: output.timedOut ? undefined : (output.code ?? -1),
      stdout: output.stdout,
      stderr: output.stderr,
    });
    if (output.timedOut) {
      throw new Error(`Command timed out after ${timeoutSecs} seconds`);
    }
    if ((output.code ?? 0) !== 0) {
      throw new Error(`${result}\n[exit code: ${output.code ?? -1}]`);
    }
    return result;
  }

  private async grep(input: GrepInput): Promise<string> {
    const pattern = new RegExp(input.pattern);
    const requestedPath = input.path ?? ".";
    const searchPath = await this.resolveInsideProject(requestedPath, true);
    const include = input.include ? wildcardToRegExp(input.include) : null;
    const stat = await fsPromises.stat(searchPath);
    const results: string[] = [];
    const basePath = stat.isDirectory() ? searchPath : path.dirname(searchPath);

    const visitFile = async (filePath: string): Promise<void> => {
      if (results.length >= MAX_GREP_RESULTS) return;
      const name = path.basename(filePath);
      if (include && !include.test(name)) return;
      const content = await fsPromises.readFile(filePath, "utf8").catch(() => null);
      if (content == null) return;
      const rel = path.relative(basePath, filePath) || name;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < MAX_GREP_RESULTS; i += 1) {
        if (pattern.test(lines[i])) {
          results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    };

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= MAX_GREP_RESULTS) return;
      const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= MAX_GREP_RESULTS) return;
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(fullPath);
        } else if (entry.isFile()) {
          await visitFile(fullPath);
        }
      }
    };

    if (stat.isDirectory()) {
      await walk(searchPath);
    } else {
      await visitFile(searchPath);
    }

    if (results.length === 0) return `No matches found for pattern '${input.pattern}'`;
    let output = results.join("\n");
    if (results.length >= MAX_GREP_RESULTS) {
      output += `\n... [limited to ${MAX_GREP_RESULTS} results]`;
    }
    return output;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseMaybeJson(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

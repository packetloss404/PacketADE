// OpenAI Codex CLI provider (ChatGPT Plus/Pro subscription auth).
//
// Wraps `codex exec --json` as a subprocess per turn and translates its JSONL
// event stream into the sidecar's wire-protocol events. Unlike the Anthropic
// SDK provider, Codex is a CLI tool with no long-lived library API — every
// conversation turn is a fresh `codex exec` invocation, optionally resumed
// via `codex exec resume <session-id>` to continue a prior context.
//
// Discovery performed against codex-cli 0.121.0 (Windows, Apr 2026):
//   - JSON flag: `--json` (emits JSONL to stdout)
//   - Prompt delivery: positional arg (stdin also supported if `-` is used)
//   - Auth file: ~/.codex/auth.json (OAuth token from `codex login`)
//   - Sandbox flags: -s read-only|workspace-write|danger-full-access
//   - Approval flags: -a untrusted|on-request|never
//   - Model flag: -m / --model
//   - Resume: `codex exec resume <SESSION_ID> [PROMPT]` with --json
//
// Known limitations / design decisions:
//   * MCP servers in `req.mcpServers` are IGNORED in v1 — Codex manages its
//     own MCP config via `codex mcp`, and wiring PacketADE's shape through
//     `-c mcp_servers.*` is out of scope. A one-time stderr warning is logged
//     if the supervisor passes any.
//   * planMode is translated to `-a on-request --sandbox read-only` as a
//     best-effort proxy (Codex has no literal "plan mode"). Write tools will
//     still block; the user has to explicitly approve them.
//   * allowedTools is LOGGED-ONLY and not enforced. Codex has no equivalent
//     CLI flag; fine-grained tool gating is handled via its sandbox policy.
//   * Thinking tokens: Codex's `--json` stream may or may not expose chain-
//     of-thought deltas depending on model and config. We forward any
//     `reasoning`/`thinking` events as `thinking` chunks on a best-effort
//     basis; absence is not an error.
//   * Tool events: Codex's JSON shape is flatter than the Claude SDK's
//     tool_use / tool_result blocks. We synthesize a stable toolUseId from
//     the event's `id` / `call_id` / `sub_id` (whichever is present) or a
//     UUID when none is provided. Input/output payloads are passed through
//     as-is when structured, or stringified when not.
//   * Permission approvals: Codex surfaces approval requests in-band as
//     JSONL events when `-a on-request` is active. We emit those as
//     `permission_request`; the `respondPermission` handler writes a
//     response line to the child's stdin (format documented inline below).
//     If Codex is spawned with `--full-auto` or `-a never`, no approval
//     events fire and respondPermission is a no-op.
//   * Pending edit diffs: Codex does NOT emit a pre-apply diff event in
//     `--json` mode today (patches are applied inside the sandbox). We rely
//     on the sandbox + approval policy instead; `respondEdit` is routed
//     through the same approval mechanism for symmetry.
//   * Each `sendMessage` spawns a FRESH `codex exec resume` if a prior
//     session-id was captured, or a fresh `codex exec` otherwise. Codex's
//     exec mode is a one-shot turn; mid-stream follow-ups aren't supported.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type {
  EditResponseRequest,
  Emit,
  PermissionResponseRequest,
  SendMessageRequest,
  StartSessionRequest,
} from "../protocol.js";
import type { ProviderHandler } from "./base.js";

const logStderr = (msg: string): void => {
  process.stderr.write(`[sidecar:openai-codex] ${msg}\n`);
};

/** Windows requires the .cmd shim when invoking npm-installed CLIs via spawn. */
const CODEX_BIN = process.platform === "win32" ? "codex.cmd" : "codex";

/**
 * Best-effort extraction of string fields from an unknown-shaped JSON object.
 * Codex's event schema is not formally pinned in public docs, so we navigate
 * defensively rather than asserting a strict type.
 */
function pickString(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNested(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function stringifyUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextBlock(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown; content?: unknown };
        if (typeof b.text === "string") {
          parts.push(b.text);
          continue;
        }
        if (b.type === "text" && typeof b.content === "string") {
          parts.push(b.content);
          continue;
        }
      }
    }
    return parts.join("");
  }
  return "";
}

/** Translate plan mode / allowedTools into Codex CLI flags. */
function buildExecArgs(req: StartSessionRequest): string[] {
  const args: string[] = ["exec", "--json", "--skip-git-repo-check"];
  if (req.model && req.model.length > 0) {
    args.push("--model", req.model);
  }
  if (req.projectPath && req.projectPath.length > 0) {
    args.push("--cd", req.projectPath);
  }
  if (req.planMode) {
    // Best-effort plan-mode proxy: read-only sandbox + on-request approvals
    // so Codex asks before doing anything that touches disk.
    args.push("--sandbox", "read-only", "-a", "on-request");
  } else {
    // Default to workspace-write + on-request so approvals flow through our
    // permission_request pipeline.
    args.push("--sandbox", "workspace-write", "-a", "on-request");
  }
  return args;
}

function buildResumeArgs(
  sessionId: string,
  req: StartSessionRequest,
): string[] {
  const args: string[] = ["exec", "resume", sessionId, "--json", "--skip-git-repo-check"];
  if (req.model && req.model.length > 0) {
    args.push("--model", req.model);
  }
  if (req.planMode) {
    args.push("--sandbox", "read-only");
  } else {
    args.push("--sandbox", "workspace-write");
  }
  return args;
}

export class OpenAICodexProvider implements ProviderHandler {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: ReadlineInterface | null = null;
  private stderrReader: ReadlineInterface | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  /** The Codex-assigned session UUID captured from session_start events. */
  private codexSessionId: string | null = null;
  private doneEmitted = false;
  /** Track the last request snapshot so sendMessage can reuse model/planMode. */
  private lastReq: StartSessionRequest | null = null;
  /**
   * Pending approval events keyed by whatever id Codex uses for its
   * approval request. We need the id later when respondPermission fires so
   * we can route the response to the right in-flight ask.
   */
  private pendingApprovals = new Map<string, string>();
  /** Last-seen token counts from the most recent token_count event. */
  private lastInputTokens = 0;
  private lastOutputTokens = 0;

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    this.sessionId = req.sessionId;
    this.lastReq = req;
    this.doneEmitted = false;

    if (req.mcpServers && Object.keys(req.mcpServers).length > 0) {
      logStderr(
        "MCP servers ignored in openai-codex provider (v1 limitation); configure via `codex mcp` instead",
      );
    }

    if (req.allowedTools && req.allowedTools.length > 0) {
      logStderr(
        `allowedTools ignored (no Codex CLI equivalent); relying on sandbox policy. tools=${req.allowedTools.join(",")}`,
      );
    }

    if (req.systemPrompt && req.systemPrompt.length > 0) {
      // Codex exec does not expose a direct system-prompt flag in 0.121.0.
      // Prepend to the initial message so the model still sees the intent.
      logStderr(
        "systemPrompt prepended to initialMessage (codex exec has no --system-prompt flag)",
      );
    }

    const args = req.resume ? buildResumeArgs(req.resume, req) : buildExecArgs(req);

    // Prompt delivery: positional arg for the initial turn. If a systemPrompt
    // was provided, fold it in as a fenced preamble. Resume takes an optional
    // prompt positional after SESSION_ID.
    const promptParts: string[] = [];
    if (req.systemPrompt && req.systemPrompt.length > 0) {
      promptParts.push(`<system>\n${req.systemPrompt}\n</system>`);
    }
    if (req.initialMessage && req.initialMessage.length > 0) {
      promptParts.push(req.initialMessage);
    }
    const prompt = promptParts.join("\n\n");
    if (prompt.length > 0) {
      args.push(prompt);
    }

    this.spawnCodex(args, emit);
  }

  private spawnCodex(args: string[], emit: Emit): void {
    const sessionId = this.sessionId;
    if (!sessionId) {
      emit({
        type: "error",
        sessionId: "",
        message: "spawnCodex called before sessionId set",
      });
      return;
    }
    const cwd = this.lastReq?.projectPath || undefined;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(CODEX_BIN, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // `shell: true` is needed on Windows for .cmd shims with argv arrays,
        // but it also requires us to quote arguments. We rely on the .cmd
        // suffix in CODEX_BIN instead, which works with shell:false on win32.
      });
    } catch (err) {
      emit({
        type: "error",
        sessionId,
        message: `failed to spawn codex: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    this.child = child;
    this.doneEmitted = false;

    child.on("error", (err) => {
      logStderr(`child process error: ${err.message}`);
      if (!this.doneEmitted) {
        this.doneEmitted = true;
        emit({
          type: "error",
          sessionId,
          message: `codex process error: ${err.message}`,
        });
      }
    });

    child.on("exit", (code, signal) => {
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      logStderr(`child exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (this.doneEmitted) return;
      this.doneEmitted = true;
      if (code === 0 || code === null) {
        emit({
          type: "done",
          sessionId,
          inputTokens: this.lastInputTokens,
          outputTokens: this.lastOutputTokens,
        });
      } else {
        emit({
          type: "error",
          sessionId,
          message: `codex exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
        });
      }
    });

    // Stdout: JSONL event stream.
    child.stdout.setEncoding("utf8");
    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // Some lines may be non-JSON preamble (banner / progress) before the
        // model starts emitting structured events. Forward to stderr for
        // visibility but do not crash the session.
        logStderr(`non-JSON stdout line: ${trimmed}`);
        return;
      }
      this.handleEvent(event, emit);
    });

    // Stderr: forward to our own stderr with a prefix. Codex may write
    // progress/banner text here; users debugging will want to see it.
    child.stderr.setEncoding("utf8");
    this.stderrReader = createInterface({ input: child.stderr });
    this.stderrReader.on("line", (line) => {
      if (line.length === 0) return;
      process.stderr.write(`[codex:stderr] ${line}\n`);
    });
  }

  /**
   * Translate a single JSONL event from Codex into sidecar protocol events.
   * Codex's event schema is not formally documented; we match on `type`
   * (or `msg.type` for envelope-wrapped variants) and handle the common
   * families: agent text, reasoning, tool/exec calls, approval asks,
   * token counts, task lifecycle, and errors.
   */
  private handleEvent(event: unknown, emit: Emit): void {
    if (!event || typeof event !== "object") return;
    const sessionId = this.sessionId;
    if (!sessionId) return;

    const envelope = event as Record<string, unknown>;
    // Codex sometimes wraps the real payload in { id, msg: { type, ... } }.
    const payload =
      envelope.msg && typeof envelope.msg === "object"
        ? (envelope.msg as Record<string, unknown>)
        : envelope;
    const typeStr =
      pickString(payload, "type") ?? pickString(envelope, "type") ?? "";

    // Capture Codex session-id as soon as it shows up so we can resume later.
    const maybeSession =
      pickString(envelope, "session_id", "sessionId") ??
      pickString(payload, "session_id", "sessionId") ??
      (pickNested(payload, ["session", "id"]) as string | undefined);
    if (typeof maybeSession === "string" && maybeSession.length > 0) {
      this.codexSessionId = maybeSession;
    }

    // Agent text: a few observed/likely type names. Match broadly.
    // - "agent_message" / "agent_message_delta" (from codex-rs event types)
    // - "message" / "assistant_message"
    if (
      typeStr === "agent_message" ||
      typeStr === "agent_message_delta" ||
      typeStr === "message" ||
      typeStr === "assistant_message"
    ) {
      const text =
        pickString(payload, "message", "text", "delta", "content") ??
        extractTextBlock(payload.content) ??
        extractTextBlock((payload as { message?: unknown }).message);
      if (text && text.length > 0) {
        emit({ type: "chunk", sessionId, text });
      }
      return;
    }

    // Reasoning / thinking — best-effort. Codex may emit "agent_reasoning",
    // "reasoning", "reasoning_delta" depending on the model.
    if (
      typeStr === "agent_reasoning" ||
      typeStr === "agent_reasoning_delta" ||
      typeStr === "reasoning" ||
      typeStr === "reasoning_delta" ||
      typeStr === "thinking"
    ) {
      const text =
        pickString(payload, "text", "delta", "reasoning", "content") ??
        extractTextBlock(payload.content);
      if (text && text.length > 0) {
        emit({ type: "thinking", sessionId, text });
      }
      return;
    }

    if (typeStr === "agent_reasoning_done" || typeStr === "reasoning_done") {
      emit({ type: "thinking_stop", sessionId });
      return;
    }

    // Tool / shell-exec begin events. Codex exposes shell invocations via
    // "exec_command_begin" and function calls via "tool_call" / "mcp_tool_call".
    if (
      typeStr === "exec_command_begin" ||
      typeStr === "tool_call" ||
      typeStr === "mcp_tool_call" ||
      typeStr === "function_call" ||
      typeStr === "tool_use"
    ) {
      const toolUseId =
        pickString(payload, "id", "call_id", "sub_id", "tool_call_id") ??
        pickString(envelope, "id") ??
        randomUUID();
      const name =
        pickString(payload, "name", "command", "tool") ??
        (Array.isArray((payload as { command?: unknown }).command)
          ? ((payload as { command?: unknown[] }).command as unknown[]).join(" ")
          : undefined) ??
        "unknown";
      const input =
        payload.arguments ??
        payload.args ??
        payload.input ??
        payload.parameters ??
        payload.command ??
        payload;
      emit({ type: "tool_start", sessionId, toolUseId, name, input });
      return;
    }

    // Tool / shell-exec completion.
    if (
      typeStr === "exec_command_end" ||
      typeStr === "tool_call_result" ||
      typeStr === "mcp_tool_call_result" ||
      typeStr === "function_call_output" ||
      typeStr === "tool_result"
    ) {
      const toolUseId =
        pickString(payload, "id", "call_id", "sub_id", "tool_call_id") ??
        pickString(envelope, "id") ??
        "";
      const stdout = pickString(payload, "stdout", "output", "text") ?? "";
      const stderr = pickString(payload, "stderr") ?? "";
      const output =
        stdout.length > 0 || stderr.length > 0
          ? [stdout, stderr].filter((s) => s.length > 0).join("\n")
          : stringifyUnknown(payload.result ?? payload.content ?? payload);
      const exitCode =
        typeof payload.exit_code === "number"
          ? (payload.exit_code as number)
          : typeof payload.exitCode === "number"
            ? (payload.exitCode as number)
            : undefined;
      const isError =
        Boolean(payload.is_error) ||
        Boolean(payload.isError) ||
        (typeof exitCode === "number" && exitCode !== 0);
      emit({ type: "tool_result", sessionId, toolUseId, output, isError });
      return;
    }

    // Approval / permission prompt. Codex emits these when `-a on-request`
    // is active and the model wants to run a gated command.
    if (
      typeStr === "exec_approval_request" ||
      typeStr === "apply_patch_approval_request" ||
      typeStr === "approval_request" ||
      typeStr === "user_approval_request"
    ) {
      const toolUseId =
        pickString(payload, "id", "call_id", "sub_id", "approval_id") ??
        pickString(envelope, "id") ??
        randomUUID();
      const name =
        pickString(payload, "name", "command", "reason") ??
        (typeStr === "apply_patch_approval_request" ? "apply_patch" : "exec");
      const input =
        payload.arguments ??
        payload.command ??
        payload.patch ??
        payload.input ??
        payload;
      this.pendingApprovals.set(toolUseId, typeStr);
      emit({
        type: "permission_request",
        sessionId,
        toolUseId,
        name,
        input,
      });
      return;
    }

    // Token usage — Codex emits a "token_count" event with a usage dict.
    if (typeStr === "token_count" || typeStr === "usage") {
      const usage =
        (payload.usage as Record<string, unknown> | undefined) ??
        (payload.info as Record<string, unknown> | undefined) ??
        payload;
      const input =
        (usage?.input_tokens as number | undefined) ??
        (usage?.prompt_tokens as number | undefined) ??
        0;
      const output =
        (usage?.output_tokens as number | undefined) ??
        (usage?.completion_tokens as number | undefined) ??
        0;
      if (typeof input === "number") this.lastInputTokens = input;
      if (typeof output === "number") this.lastOutputTokens = output;
      return;
    }

    // Task complete / turn ended.
    if (
      typeStr === "task_complete" ||
      typeStr === "turn_complete" ||
      typeStr === "agent_turn_complete" ||
      typeStr === "session_complete"
    ) {
      if (!this.doneEmitted) {
        this.doneEmitted = true;
        emit({
          type: "done",
          sessionId,
          inputTokens: this.lastInputTokens,
          outputTokens: this.lastOutputTokens,
        });
      }
      return;
    }

    // Task started / session configured / etc. — log and ignore.
    if (
      typeStr === "task_started" ||
      typeStr === "session_configured" ||
      typeStr === "session_start" ||
      typeStr === "stream_error"
    ) {
      logStderr(`codex lifecycle event: ${typeStr}`);
      return;
    }

    // Explicit error event from Codex.
    if (typeStr === "error" || typeStr === "stream_error") {
      const message =
        pickString(payload, "message", "error", "reason") ??
        stringifyUnknown(payload);
      if (!this.doneEmitted) {
        this.doneEmitted = true;
        emit({ type: "error", sessionId, message: `codex error: ${message}` });
      }
      return;
    }

    // Unknown event — log type and move on.
    if (typeStr) {
      logStderr(`unhandled codex event type: ${typeStr}`);
    }
  }

  async sendMessage(req: SendMessageRequest, emit: Emit): Promise<void> {
    if (!this.lastReq) {
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "sendMessage before start",
      });
      return;
    }
    // Codex exec is one-shot per invocation; spawn a fresh exec (or exec
    // resume) for every follow-up turn. If the first turn captured a Codex
    // session-id, use resume so context carries. Otherwise warn and start
    // fresh — the model will lose prior turn context.
    if (this.child && this.child.exitCode === null) {
      // Prior turn still running; let it finish before queuing a new one.
      // For v1 we refuse overlapping turns rather than building a queue.
      logStderr("sendMessage received while prior codex turn is still running; ignoring");
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "previous codex turn is still running; wait for 'done' before sending again",
      });
      return;
    }

    this.doneEmitted = false;
    this.pendingApprovals.clear();

    const nextReq: StartSessionRequest = {
      ...this.lastReq,
      initialMessage: req.content,
      // After the first turn, systemPrompt was already applied; don't re-prepend.
      systemPrompt: "",
    };

    let args: string[];
    if (this.codexSessionId) {
      args = buildResumeArgs(this.codexSessionId, nextReq);
      if (req.content.length > 0) args.push(req.content);
    } else {
      logStderr(
        "no codex session_id captured from prior turn; sending as a fresh exec (context lost)",
      );
      args = buildExecArgs(nextReq);
      if (req.content.length > 0) args.push(req.content);
    }

    this.spawnCodex(args, emit);
  }

  async respondPermission(req: PermissionResponseRequest, _emit: Emit): Promise<void> {
    const kind = this.pendingApprovals.get(req.toolUseId);
    if (!kind) {
      logStderr(`respondPermission: no pending approval for toolUseId=${req.toolUseId}`);
      return;
    }
    this.pendingApprovals.delete(req.toolUseId);

    if (!this.child || this.child.exitCode !== null) {
      logStderr(
        `respondPermission: child not running (exitCode=${this.child?.exitCode ?? "null"}); dropping response`,
      );
      return;
    }

    // Codex reads approval responses from stdin as JSONL envelopes. The exact
    // shape is driven by codex-rs's Submission schema; the common form is:
    //   { "id": "<approval_id>", "op": { "type": "exec_approval", "decision": "approved"|"denied" } }
    // We emit a shape that matches both exec and patch approvals by setting
    // the op type based on the tracked request kind. If Codex doesn't
    // recognize it, the process will emit an error event and we surface it.
    const opType = kind === "apply_patch_approval_request"
      ? "patch_approval"
      : "exec_approval";
    const decision = req.decision === "approve" ? "approved" : "denied";
    const submission = {
      id: req.toolUseId,
      op: { type: opType, decision },
    };
    try {
      this.child.stdin.write(JSON.stringify(submission) + "\n");
    } catch (err) {
      logStderr(
        `respondPermission: stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async respondEdit(req: EditResponseRequest, emit: Emit): Promise<void> {
    // Codex does not emit pending_edit today, so there's no separate edit
    // response channel. If an approval for apply_patch is open, route
    // through it; otherwise no-op.
    const pendingPatch = Array.from(this.pendingApprovals.entries()).find(
      ([, kind]) => kind === "apply_patch_approval_request",
    );
    if (!pendingPatch) {
      logStderr(`respondEdit received (approved=${req.approved}) but no pending patch; ignoring`);
      return;
    }
    const [toolUseId] = pendingPatch;
    await this.respondPermission(
      {
        type: "permission_response",
        sessionId: req.sessionId,
        toolUseId,
        decision: req.approved ? "approve" : "deny",
      },
      emit,
    );
  }

  async cancel(_emit: Emit): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      // Prefer graceful shutdown first, then SIGKILL after 2s.
      child.kill("SIGTERM");
    } catch (err) {
      logStderr(`SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.killTimer = setTimeout(() => {
      try {
        if (this.child && this.child.exitCode === null) {
          this.child.kill("SIGKILL");
        }
      } catch (err) {
        logStderr(`SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 2000);
    // `done` is emitted by the child 'exit' handler once the process unwinds.
  }

  async close(): Promise<void> {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch (err) {
      logStderr(`close SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.stdoutReader?.close();
    } catch {
      // ignore
    }
    try {
      this.stderrReader?.close();
    } catch {
      // ignore
    }
  }
}

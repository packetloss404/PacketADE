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
import { promises as fsPromises } from "node:fs";
import * as nodePath from "node:path";
import type {
  EditResponseRequest,
  Emit,
  PermissionResponseRequest,
  ResumeMessage,
  RetryRequest,
  SendMessageRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  StartSessionRequest,
} from "../protocol.js";
import type { ProviderHandler } from "./base.js";

/**
 * Sandbox + approval flag tuple derived from an SDK-style PermissionMode.
 * Returned by `modeToCodexFlags` and used verbatim inside the exec / resume
 * arg builders — keeping the translation in one place keeps the two builders
 * from drifting.
 */
interface CodexSandboxFlags {
  args: string[];
  /**
   * When true the `-a on-request` approval flag was passed, so approvals flow
   * through our `permission_request` pipeline. Informational — not inspected
   * today, but kept for future visibility into what the child was launched
   * with (e.g. for status-line hover tooltips).
   */
  hasApprovals: boolean;
}

/**
 * Translate an SDK-style `PermissionMode` (set via the protocol v2
 * `set_permission_mode` request) onto Codex's sandbox + approval flags.
 *
 * Mapping (codex-cli 0.121.0):
 *   - plan                → `--sandbox read-only -a on-request`
 *   - bypassPermissions   → `--dangerously-bypass-approvals-and-sandbox`
 *   - acceptEdits         → `--sandbox workspace-write -a never`
 *                           (writes allowed, no per-call prompt)
 *   - allow_all           → same as bypassPermissions
 *   - deny_all            → read-only with no approval prompts
 *   - ask_for_risky       → same as default
 *   - dontAsk / auto      → same as bypassPermissions (closest Codex equivalent;
 *                           those SDK modes don't prompt the user)
 *   - default / <unset>   → `--sandbox workspace-write -a on-request`
 */
// NOTE: `codex exec` runs non-interactively — we deliver the prompt as a
// positional arg and CLOSE stdin (otherwise codex 0.135+ blocks reading stdin).
// That means Codex's `-a on-request` interactive approval flow can't work here
// (there's no open channel to write the approval response back), and would
// leave the turn stalled waiting for input. So we never use `-a on-request`;
// the sandbox mode is the safety boundary instead (read-only can't write/exec;
// workspace-write is confined to the project dir). Per-command approval prompts
// aren't supported for Codex in this surface.
function modeToCodexFlags(mode: string | null | undefined): CodexSandboxFlags {
  switch (mode) {
    case "plan":
      return {
        // Plan/investigate only — read-only, no writes or command execution.
        args: ["--sandbox", "read-only", "-a", "never"],
        hasApprovals: false,
      };
    case "bypassPermissions":
    case "allow_all":
    case "dontAsk":
    case "auto":
      return {
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        hasApprovals: false,
      };
    case "deny_all":
      return {
        args: ["--sandbox", "read-only", "-a", "never"],
        hasApprovals: false,
      };
    case "acceptEdits":
      return {
        args: ["--sandbox", "workspace-write", "-a", "never"],
        hasApprovals: false,
      };
    case "ask_for_risky":
    case "default":
    case null:
    case undefined:
    default:
      // Confined to the project dir via the sandbox; no interactive approval
      // (unsupported for exec — see note above), so `-a never` to avoid a stall.
      return {
        args: ["--sandbox", "workspace-write", "-a", "never"],
        hasApprovals: false,
      };
  }
}

const logStderr = (msg: string): void => {
  process.stderr.write(`[sidecar:openai-codex] ${msg}\n`);
};

/** Windows requires the .cmd shim when invoking npm-installed CLIs via spawn. */
const CODEX_BIN = process.platform === "win32" ? "codex.cmd" : "codex";

function resolveCodexCommand(req: StartSessionRequest): string {
  const aliases = req as StartSessionRequest & {
    manualPath?: unknown;
    cliPath?: unknown;
    codexCommandPath?: unknown;
  };
  const raw = req.commandPath ?? aliases.codexCommandPath ?? aliases.cliPath ?? aliases.manualPath;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return CODEX_BIN;
}

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
 * Build the argv for a fresh `codex exec` invocation. The provider owns the
 * effective model + sandbox flags (overridable mid-session via protocol v2's
 * `set_model` / `set_permission_mode`), and passes them in explicitly rather
 * than re-reading the original `StartSessionRequest` so an override takes
 * effect on the *next* spawn.
 */
function buildExecArgs(
  req: StartSessionRequest,
  model: string,
  sandbox: CodexSandboxFlags,
): string[] {
  const args: string[] = ["exec", "--json", "--skip-git-repo-check"];
  if (model.length > 0) {
    args.push("--model", model);
  }
  if (req.projectPath && req.projectPath.length > 0) {
    args.push("--cd", req.projectPath);
  }
  args.push(...sandbox.args);
  return args;
}

function buildResumeArgs(
  sessionId: string,
  _req: StartSessionRequest,
  model: string,
  sandbox: CodexSandboxFlags,
): string[] {
  const args: string[] = ["exec", "resume", sessionId, "--json", "--skip-git-repo-check"];
  if (model.length > 0) {
    args.push("--model", model);
  }
  // `codex exec resume` accepts the sandbox flags but not `-a` in 0.121.0 —
  // approval policy is inherited from the resumed session. Strip any `-a N`
  // pair from the sandbox tuple so we don't confuse the CLI.
  for (let i = 0; i < sandbox.args.length; i++) {
    const flag = sandbox.args[i];
    if (flag === "-a" || flag === "--ask-for-approval") {
      i += 1; // skip the value too
      continue;
    }
    args.push(flag);
  }
  return args;
}

export class OpenAICodexProvider implements ProviderHandler {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: ReadlineInterface | null = null;
  private stderrReader: ReadlineInterface | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private codexCommand = CODEX_BIN;
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
  /** Last-seen token counts from the most recent token_count event.
   * `reasoning` and `cachedInput` were added in Codex CLI 0.125 (Apr 2026)
   * — capturing them lets PacketADE's CostDashboard report GPT-5.5 spend
   * accurately (otherwise we under-report by the reasoning slice).
   * A3 keyed-by-address: empty string = root thread, `/root/agent_a` =
   * MultiAgentV2 sub-agent. Without per-address tracking we'd inflate the
   * root's totals by every sub-agent's spend. */
  private tokensByAddress = new Map<
    string,
    { input: number; output: number; reasoning: number; cachedInput: number }
  >();
  /** Mirror of the root entry, kept for the legacy `done` payload contract
   * which only carries inputTokens/outputTokens (sub-agent rollup happens
   * frontend-side via per-address turn_summary events). */
  private lastInputTokens = 0;
  private lastOutputTokens = 0;
  /**
   * Effective model for the *next* spawn. Seeded from `req.model` on start,
   * overridable mid-session via the protocol v2 `set_model` request. Codex
   * exec is one-shot per turn, so overrides queue until the next spawn.
   */
  private effectiveModel = "";
  /**
   * Effective SDK-style permission mode for the *next* spawn. `null` means
   * "derive from req.planMode" (the pre-v2 behavior). Set via `set_permission_mode`.
   */
  private effectivePermissionMode: string | null = null;
  /**
   * Last user message dispatched this session. `retry()` re-spawns
   * `codex exec resume` with it so the model takes another pass. Null when
   * no turn has been sent yet — retry() errors in that case.
   */
  private lastUserMessage: string | null = null;
  /**
   * Codex CLI 0.135+ emits an "item"-based JSONL schema (`item.started` /
   * `item.completed` carrying `{ item: { type, text, ... } }`) instead of the
   * flat `agent_message` / `agent_message_delta` events of 0.121. An
   * `agent_message` (or `reasoning`) item may arrive as a completed block OR as
   * incremental `item.updated`s; track how many chars we've already emitted per
   * item id so we forward only the newly-added suffix and never double-print.
   */
  private itemTextEmitted = new Map<string, number>();

  async start(req: StartSessionRequest, emit: Emit): Promise<void> {
    this.sessionId = req.sessionId;
    this.lastReq = req;
    this.codexCommand = resolveCodexCommand(req);
    if (this.codexCommand !== CODEX_BIN) {
      logStderr(`using manual codex command path: ${this.codexCommand}`);
    }
    this.doneEmitted = false;
    // Seed effective overrides from the initial request. `set_model` /
    // `set_permission_mode` can override these for subsequent spawns.
    this.effectiveModel = req.model ?? "";
    this.effectivePermissionMode = req.planMode
      ? null
      : req.approveWrites
        ? "acceptEdits"
        : (req.permissionMode ?? null);
    this.lastUserMessage = req.initialMessage ?? null;

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

    const sandbox = this.currentSandbox(req);
    const args = req.resume
      ? buildResumeArgs(req.resume, req, this.effectiveModel, sandbox)
      : buildExecArgs(req, this.effectiveModel, sandbox);

    // Prompt delivery: positional arg for the initial turn. If a systemPrompt
    // was provided, fold it in as a fenced preamble. Resume takes an optional
    // prompt positional after SESSION_ID.
    const promptParts: string[] = [];
    if (req.systemPrompt && req.systemPrompt.length > 0) {
      promptParts.push(`<system>\n${req.systemPrompt}\n</system>`);
    }
    const initialMessage = req.resume
      ? req.initialMessage
      : buildResumeFallbackPrompt(req.resumeMessages, req.initialMessage);
    if (initialMessage && initialMessage.length > 0) {
      promptParts.push(initialMessage);
    }
    const prompt = promptParts.join("\n\n");
    if (prompt.length > 0) {
      args.push(prompt);
    }

    this.spawnCodex(args, emit);
  }

  /**
   * Resolve the effective sandbox flags for the next spawn. If an explicit
   * permission-mode override is active, that wins. Otherwise fall back to the
   * legacy `req.planMode` path: `plan` when set, else `default`.
   */
  private currentSandbox(req: StartSessionRequest): CodexSandboxFlags {
    if (this.effectivePermissionMode !== null) {
      return modeToCodexFlags(this.effectivePermissionMode);
    }
    return modeToCodexFlags(req.planMode ? "plan" : "default");
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
      child = spawn(this.codexCommand, args, {
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
        message: `failed to spawn codex (${this.codexCommand}): ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    this.child = child;
    this.doneEmitted = false;
    // Each `codex exec` restarts item ids at item_0, so clear the per-item
    // emitted-length tracker or turn 2's item_0 would be seen as "already sent".
    this.itemTextEmitted.clear();

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
          resumeToken: this.codexSessionId ?? undefined,
        });
      } else {
        emit({
          type: "error",
          sessionId,
          message: `codex exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
        });
        // (reasoning + cached tokens are surfaced live via turn_summary;
        // we keep `done` payload backwards-compatible with v3 consumers.)
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

    // CRITICAL (codex-cli 0.135+): `codex exec` treats an open, piped stdin as
    // "additional input" and BLOCKS reading it to EOF ("Reading additional
    // input from stdin...") before running the turn — so a spawn that never
    // closes stdin hangs forever and emits nothing. We deliver the prompt as a
    // positional arg, so close stdin now to let the turn proceed. A side effect
    // is that stdin-based approval responses (respondPermission) can't be
    // written; non-interactive exec relies on the sandbox/approval *flags*
    // (`--dangerously-bypass-approvals-and-sandbox` / `-a never`) instead.
    try {
      child.stdin.end();
    } catch (err) {
      logStderr(
        `failed to close codex stdin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * P1-7: read the pre-edit content for every path a Codex `file_change`
   * item names and emit a non-blocking `edit_baseline` per path, so the
   * host's review surfaces can diff the applied patch against the true
   * "before" instead of live disk. Best-effort: unreadable paths emit a
   * "file did not exist" baseline (before absent), and Codex applying the
   * patch before `item.started` lands is tolerated because the host store
   * is first-wins per path.
   */
  private async captureFileChangeBaselines(
    item: Record<string, unknown>,
    sessionId: string,
    itemId: string,
    emit: Emit,
  ): Promise<void> {
    const changes = item.changes;
    if (!Array.isArray(changes)) return;
    const projectPath = this.lastReq?.projectPath ?? "";
    for (const change of changes) {
      let rawPath: string | undefined;
      if (typeof change === "string") {
        rawPath = change;
      } else if (change && typeof change === "object") {
        const c = change as Record<string, unknown>;
        rawPath = typeof c.path === "string" ? c.path : undefined;
      }
      if (!rawPath) continue;
      const resolved = nodePath.isAbsolute(rawPath)
        ? rawPath
        : nodePath.join(projectPath, rawPath);
      const before = await fsPromises
        .readFile(resolved, "utf8")
        .catch(() => null);
      emit({
        type: "edit_baseline",
        sessionId,
        toolUseId: itemId,
        // Emit the path exactly as Codex reported it so it matches the
        // tool call's `changes` list in the transcript.
        path: rawPath,
        before: before ?? undefined,
      });
    }
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
    const typeStr = pickString(payload, "type") ?? pickString(envelope, "type") ?? "";

    // Capture Codex session-id as soon as it shows up so we can resume later.
    // 0.135+ reports it as `thread_id` on the `thread.started` event; older
    // builds used `session_id` / `session.id`.
    const maybeSession =
      pickString(envelope, "thread_id", "session_id", "sessionId") ??
      pickString(payload, "thread_id", "session_id", "sessionId") ??
      (pickNested(payload, ["session", "id"]) as string | undefined);
    if (typeof maybeSession === "string" && maybeSession.length > 0) {
      this.codexSessionId = maybeSession;
    }

    // ─── Codex CLI 0.135+ "item"-based schema ────────────────────────────
    // thread.started (session id captured above) and turn.started are
    // informational; turn.completed carries the final token usage; content
    // arrives as item.started/updated/completed envelopes dispatched on
    // item.type. This block is matched first; the flat handlers below remain
    // as a fallback for the 0.121 schema.
    if (typeStr === "thread.started" || typeStr === "turn.started") {
      logStderr(`codex lifecycle event: ${typeStr}`);
      return;
    }
    if (typeStr === "turn.completed") {
      const usage = (payload.usage as Record<string, unknown> | undefined) ?? {};
      const input = (usage.input_tokens as number | undefined) ?? this.lastInputTokens;
      const output = (usage.output_tokens as number | undefined) ?? this.lastOutputTokens;
      const reasoning = (usage.reasoning_output_tokens as number | undefined) ?? 0;
      const cachedInput = (usage.cached_input_tokens as number | undefined) ?? 0;
      const bucket = this.tokensByAddress.get("") ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cachedInput: 0,
      };
      bucket.input = typeof input === "number" ? input : bucket.input;
      bucket.output = typeof output === "number" ? output : bucket.output;
      bucket.reasoning = typeof reasoning === "number" ? reasoning : bucket.reasoning;
      bucket.cachedInput = typeof cachedInput === "number" ? cachedInput : bucket.cachedInput;
      this.tokensByAddress.set("", bucket);
      this.lastInputTokens = bucket.input;
      this.lastOutputTokens = bucket.output;
      emit({
        type: "turn_summary",
        sessionId,
        inputTokens: bucket.input,
        outputTokens: bucket.output,
        cacheReadInputTokens: bucket.cachedInput,
        reasoningTokens: bucket.reasoning,
      });
      // `done` is emitted by the child 'exit' handler — `codex exec` is
      // one-shot and exits right after turn.completed, carrying these totals.
      return;
    }
    if (typeStr === "turn.failed" || typeStr === "thread.error") {
      const errObj = payload.error ?? payload;
      const message =
        pickString(errObj, "message", "error", "reason") ?? stringifyUnknown(errObj);
      if (!this.doneEmitted) {
        this.doneEmitted = true;
        emit({ type: "error", sessionId, message: `codex error: ${message}` });
      }
      return;
    }
    if (
      typeStr === "item.started" ||
      typeStr === "item.updated" ||
      typeStr === "item.completed"
    ) {
      const item = (payload.item ?? envelope.item) as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") return;
      const itemType = pickString(item, "type") ?? "";
      const itemId = pickString(item, "id") ?? randomUUID();

      // Assistant text — forward only the newly-added suffix so a streamed
      // item.updated sequence plus the final item.completed can't double-print.
      if (itemType === "agent_message" || itemType === "assistant_message") {
        const full =
          pickString(item, "text", "message", "content") ??
          extractTextBlock(item.content) ??
          "";
        const already = this.itemTextEmitted.get(itemId) ?? 0;
        if (full.length > already) {
          emit({ type: "chunk", sessionId, text: full.slice(already) });
          this.itemTextEmitted.set(itemId, full.length);
        }
        return;
      }

      // Reasoning / chain-of-thought — same suffix-forwarding as text.
      if (itemType === "reasoning" || itemType === "agent_reasoning") {
        const full =
          pickString(item, "text", "content") ?? extractTextBlock(item.content) ?? "";
        const already = this.itemTextEmitted.get(itemId) ?? 0;
        if (full.length > already) {
          emit({ type: "thinking", sessionId, text: full.slice(already) });
          this.itemTextEmitted.set(itemId, full.length);
        }
        if (typeStr === "item.completed") emit({ type: "thinking_stop", sessionId });
        return;
      }

      // Shell / command / tool execution — started → tool_start, completed → result.
      if (
        itemType === "command_execution" ||
        itemType === "local_shell_call" ||
        itemType === "mcp_tool_call" ||
        itemType === "tool_call"
      ) {
        const name = pickString(item, "command", "name", "tool") ?? "shell";
        if (typeStr === "item.started") {
          emit({ type: "tool_start", sessionId, toolUseId: itemId, name, input: item });
        } else if (typeStr === "item.completed") {
          const output =
            pickString(item, "aggregated_output", "output", "stdout", "result") ??
            stringifyUnknown(item.result ?? item.content ?? "");
          const exitCode =
            typeof item.exit_code === "number" ? (item.exit_code as number) : undefined;
          const isError =
            Boolean(item.is_error) ||
            (typeof exitCode === "number" && exitCode !== 0) ||
            pickString(item, "status") === "failed";
          emit({ type: "tool_result", sessionId, toolUseId: itemId, output, isError });
        }
        return;
      }

      // File change / patch — surface for visibility as a tool call.
      if (itemType === "file_change" || itemType === "patch" || itemType === "apply_patch") {
        if (typeStr === "item.completed") {
          emit({
            type: "tool_result",
            sessionId,
            toolUseId: itemId,
            output: stringifyUnknown(item),
            isError: pickString(item, "status") === "failed",
          });
        } else {
          if (typeStr === "item.started") {
            // P1-7: best-effort pre-edit baseline capture — Codex applies
            // patches inside its own sandbox, so this is the only moment we
            // can read the "before" content. Fire-and-forget; the host store
            // is first-wins per path, so a late/post-apply read never
            // overwrites a real baseline.
            void this.captureFileChangeBaselines(item, sessionId, itemId, emit);
          }
          emit({ type: "tool_start", sessionId, toolUseId: itemId, name: "apply_patch", input: item });
        }
        return;
      }

      // Todo list — reuse the plan_block channel so PlanPanel renders it.
      if (itemType === "todo_list") {
        const rawItems = item.items;
        if (Array.isArray(rawItems)) {
          const items = rawItems
            .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
            .map((r) => {
              const text = pickString(r, "text", "title", "content") ?? "";
              const completed = Boolean(r.completed ?? r.done ?? r.status === "completed");
              return {
                content: text,
                status: (completed
                  ? "completed"
                  : pickString(r, "status") === "in_progress"
                    ? "in_progress"
                    : "pending") as "completed" | "in_progress" | "pending",
              };
            })
            .filter((p) => p.content.length > 0);
          if (items.length > 0) emit({ type: "plan_block", sessionId, items });
        }
        return;
      }

      logStderr(`unhandled codex item.type: ${itemType} (${typeStr})`);
      return;
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
        payload.arguments ?? payload.command ?? payload.patch ?? payload.input ?? payload;
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
    // 0.125 added `reasoning_tokens`; `cached_input_tokens` has been there
    // for a while but is more relevant now that permission profiles affect
    // cache hit rates. Capture both so done/turn_summary can forward them.
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
      const reasoning =
        (usage?.reasoning_tokens as number | undefined) ??
        (usage?.reasoning as number | undefined) ??
        0;
      const cachedInput =
        (usage?.cached_input_tokens as number | undefined) ??
        (usage?.cache_read_input_tokens as number | undefined) ??
        0;

      // A3: extract the sub-agent address. Codex CLI's exact field name
      // isn't guaranteed across versions, so check several known shapes.
      // Empty string = root thread (legacy behavior preserved).
      const address =
        pickString(envelope, "thread_address", "agent_path", "address") ??
        pickString(payload, "thread_address", "agent_path", "address") ??
        "";

      const bucket = this.tokensByAddress.get(address) ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cachedInput: 0,
      };
      // Codex emits cumulative running totals — replace, not accumulate.
      bucket.input = typeof input === "number" ? input : bucket.input;
      bucket.output = typeof output === "number" ? output : bucket.output;
      bucket.reasoning = typeof reasoning === "number" ? reasoning : bucket.reasoning;
      bucket.cachedInput = typeof cachedInput === "number" ? cachedInput : bucket.cachedInput;
      this.tokensByAddress.set(address, bucket);

      // Mirror root totals into the legacy scalars so the `done` payload
      // (which doesn't carry sub-agent breakdown) stays accurate for the
      // root thread. Sub-agent totals never touch the legacy scalars.
      if (address === "") {
        this.lastInputTokens = bucket.input;
        this.lastOutputTokens = bucket.output;
      } else {
        // Trace once per never-seen address so the prompt's "verify Codex
        // field name" risk shows up loudly in the sidecar log.
        process.stderr.write(`[sidecar:codex] sub-agent token attribution: ${address}\n`);
      }

      // Live mid-stream HUD: emit a turn_summary every time tokens update so
      // SessionHealthBar / CostDashboard reflect Codex spend in real time
      // (matching what the Anthropic provider does). Per-address, so the
      // frontend can attribute correctly.
      emit({
        type: "turn_summary",
        sessionId,
        inputTokens: bucket.input,
        outputTokens: bucket.output,
        cacheReadInputTokens: bucket.cachedInput,
        reasoningTokens: bucket.reasoning,
        address: address.length > 0 ? address : undefined,
      });
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
          resumeToken: this.codexSessionId ?? undefined,
        });
      }
      return;
    }

    // `stream_error` is a transient mid-stream event: Codex's own upstream SSE
    // request dropped and it retries internally within the SAME running child,
    // then continues and ends normally with `task_complete` / exit 0. It is NOT
    // terminal — the authoritative completion is the `child.on("exit")` handler
    // above (done on exit 0/null, error on non-zero). Treating it as a hard
    // error here would latch `doneEmitted` and suppress the real result,
    // surfacing a spurious failure on a turn that actually recovered.
    if (typeStr === "stream_error") {
      logStderr(`codex transient stream_error (retrying): ${stringifyUnknown(payload)}`);
      return;
    }

    // Task started / session configured / etc. — log and ignore.
    if (
      typeStr === "task_started" ||
      typeStr === "session_configured" ||
      typeStr === "session_start"
    ) {
      logStderr(`codex lifecycle event: ${typeStr}`);
      return;
    }

    // Explicit, terminal error event from Codex.
    if (typeStr === "error") {
      const message =
        pickString(payload, "message", "error", "reason") ?? stringifyUnknown(payload);
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
    this.lastUserMessage = req.content;

    const nextReq: StartSessionRequest = {
      ...this.lastReq,
      initialMessage: req.content,
      // After the first turn, systemPrompt was already applied; don't re-prepend.
      systemPrompt: "",
    };

    const sandbox = this.currentSandbox(nextReq);
    let args: string[];
    if (this.codexSessionId) {
      args = buildResumeArgs(this.codexSessionId, nextReq, this.effectiveModel, sandbox);
      if (req.content.length > 0) args.push(req.content);
    } else {
      logStderr(
        "no codex session_id captured from prior turn; sending as a fresh exec (context lost)",
      );
      args = buildExecArgs(nextReq, this.effectiveModel, sandbox);
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
    const opType = kind === "apply_patch_approval_request" ? "patch_approval" : "exec_approval";
    const decision = req.decision === "deny" ? "denied" : "approved";
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

  /**
   * Protocol v2: Codex's exec is one-shot per turn, so a permission-mode
   * change can't apply mid-run. Update the stored mode; the *next* spawn
   * (via `sendMessage` or `retry`) will use the new sandbox flags. Silent on
   * success — no event emitted.
   */
  async setPermissionMode(req: SetPermissionModeRequest, _emit: Emit): Promise<void> {
    this.effectivePermissionMode = req.mode;
    logStderr(
      `permission mode override queued for next spawn: mode=${req.mode} (codex exec is one-shot)`,
    );
  }

  /**
   * Protocol v2: update the stored model; the next spawn will pass
   * `--model <value>`. Silent on success.
   */
  async setModel(req: SetModelRequest, _emit: Emit): Promise<void> {
    this.effectiveModel = req.model;
    logStderr(`model override queued for next spawn: model=${req.model} (codex exec is one-shot)`);
  }

  /**
   * Protocol v2: retry the last user message by spawning a fresh
   * `codex exec resume` with it. If no previous user message has been
   * captured, emit an error.
   */
  async retry(req: RetryRequest, emit: Emit): Promise<void> {
    if (!this.lastReq) {
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
    if (this.child && this.child.exitCode === null) {
      logStderr("retry received while prior codex turn is still running; ignoring");
      emit({
        type: "error",
        sessionId: req.sessionId,
        message: "previous codex turn is still running; wait for 'done' before retrying",
      });
      return;
    }

    // Drive retry through the same pipeline sendMessage uses so model /
    // sandbox overrides, approval-queue resets, and done-emitter bookkeeping
    // all stay in one place.
    await this.sendMessage(
      {
        type: "send_message",
        sessionId: req.sessionId,
        content: this.lastUserMessage,
      },
      emit,
    );
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

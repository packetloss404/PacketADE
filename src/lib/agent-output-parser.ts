import type { AgentMessage, AgentToolCall } from "@/types/agent-conversation";
import type { AgentStatusPatterns } from "@/types/agent";
import { stripAnsi } from "@/agents/types";
import { generateId } from "@/lib/storage";

// Default patterns — same as Claude Code patterns from usePtyStateDetector / claude-code adapter
const DEFAULT_PATTERNS: AgentStatusPatterns = {
  approval: [
    "Allow\\s+\\w+.*\\?",
    "\\(y\\/n\\)",
    "Do you want to (?:proceed|continue|allow)",
    "Press\\s+y\\s+to\\s+(?:approve|allow|confirm)",
    "\\[Y\\/n\\]",
    "\\[y\\/N\\]",
    "Allow once|Allow always|Deny",
  ],
  thinking: ["⏺\\s*Thinking", "thinking\\.\\.\\."],
  toolUse: [
    { pattern: "⏺\\s*Read\\(([^)]+)\\)", tool: "Read", fileGroup: 1 },
    { pattern: "⏺\\s*Edit\\(([^)]+)\\)", tool: "Edit", fileGroup: 1 },
    { pattern: "⏺\\s*Write\\(([^)]+)\\)", tool: "Write", fileGroup: 1 },
    { pattern: "⏺\\s*Bash\\(([^)]*)\\)", tool: "Bash", fileGroup: 1 },
    { pattern: "⏺\\s*Glob\\(([^)]*)\\)", tool: "Glob", fileGroup: 1 },
    { pattern: "⏺\\s*Grep\\(([^)]*)\\)", tool: "Grep", fileGroup: 1 },
    { pattern: "⏺\\s*Task\\(([^)]*)\\)", tool: "Task", fileGroup: 1 },
    { pattern: "Reading\\s+(.+)", tool: "Read", fileGroup: 1 },
    { pattern: "Editing\\s+(.+)", tool: "Edit", fileGroup: 1 },
    { pattern: "Writing\\s+(.+)", tool: "Write", fileGroup: 1 },
    { pattern: "Running\\s+(.+)", tool: "Bash", fileGroup: 1 },
  ],
  idle: ["^\\s*[>❯]\\s*$"],
};

interface CompiledPatterns {
  approval: RegExp[];
  thinking: RegExp[];
  toolUse: { pattern: RegExp; tool: string; fileGroup?: number }[];
  idle: RegExp[];
}

function compilePatterns(patterns: AgentStatusPatterns): CompiledPatterns {
  return {
    approval: patterns.approval.map((p) => new RegExp(p, "i")),
    thinking: patterns.thinking.map((p) => new RegExp(p, "i")),
    toolUse: patterns.toolUse.map((t) => ({
      pattern: new RegExp(t.pattern, "i"),
      tool: t.tool,
      fileGroup: t.fileGroup,
    })),
    idle: patterns.idle.map((p) => new RegExp(p, "im")),
  };
}

export type ParsedUpdateType =
  | "assistant_text"
  | "tool_start"
  | "tool_end"
  | "thinking"
  | "idle"
  | "approval";

export interface ParsedUpdate {
  type: ParsedUpdateType;
  content?: string;
  toolName?: string;
  toolFile?: string;
}

type ParserState = "idle" | "text" | "tool" | "thinking";

/**
 * Stateful parser that converts raw PTY output chunks into structured AgentMessages.
 *
 * Usage:
 *   const parser = new AgentOutputParser();
 *   // on each PTY output event:
 *   const newOrUpdated = parser.processChunk(rawText);
 *   // newOrUpdated contains messages that were created or modified by this chunk
 */
export class AgentOutputParser {
  private compiled: CompiledPatterns;
  private state: ParserState = "idle";
  private currentMessage: AgentMessage | null = null;
  private messages: AgentMessage[] = [];
  private lineBuffer: string = "";

  constructor(patterns?: AgentStatusPatterns) {
    this.compiled = compilePatterns(patterns ?? DEFAULT_PATTERNS);
  }

  /**
   * Process a chunk of raw PTY output. Returns any messages that were
   * created or updated during this chunk (caller can use these to do
   * incremental UI updates).
   */
  processChunk(rawText: string): AgentMessage[] {
    const stripped = stripAnsi(rawText);
    // Accumulate partial lines — PTY chunks can split mid-line
    this.lineBuffer += stripped;
    const parts = this.lineBuffer.split("\n");
    // Keep last element as partial line buffer (may be incomplete)
    this.lineBuffer = parts.pop() ?? "";
    const lines = parts; // all complete lines

    const touched = new Set<string>();

    for (const line of lines) {
      const updates = this.classifyLine(line);
      for (const update of updates) {
        const msg = this.applyUpdate(update);
        if (msg) touched.add(msg.id);
      }
    }

    return this.messages.filter((m) => touched.has(m.id));
  }

  /**
   * Flush any remaining buffered content (call when conversation ends
   * or session closes). Returns messages that were finalized.
   */
  flush(): AgentMessage[] {
    const touched = new Set<string>();

    // Process remaining partial line
    if (this.lineBuffer.trim()) {
      const updates = this.classifyLine(this.lineBuffer);
      this.lineBuffer = "";
      for (const update of updates) {
        const msg = this.applyUpdate(update);
        if (msg) touched.add(msg.id);
      }
    }

    // Finalize current message
    if (this.currentMessage?.isStreaming) {
      this.currentMessage.isStreaming = false;
      touched.add(this.currentMessage.id);
    }

    this.state = "idle";
    return this.messages.filter((m) => touched.has(m.id));
  }

  /** Get all accumulated messages. */
  getMessages(): AgentMessage[] {
    return [...this.messages];
  }

  /** Reset parser state entirely. */
  reset(): void {
    this.messages = [];
    this.currentMessage = null;
    this.state = "idle";
    this.lineBuffer = "";
  }

  // ---- internal ----

  private classifyLine(line: string): ParsedUpdate[] {
    const trimmed = line.trim();

    // Skip empty lines (but keep them as content if we're mid-text)
    if (!trimmed) {
      if (this.state === "text" && this.currentMessage) {
        return [{ type: "assistant_text", content: "" }];
      }
      return [];
    }

    // 1. Check approval patterns
    for (const pat of this.compiled.approval) {
      if (pat.test(trimmed)) {
        return [{ type: "approval", content: trimmed }];
      }
    }

    // 2. Check tool use patterns
    for (const { pattern, tool, fileGroup } of this.compiled.toolUse) {
      const m = trimmed.match(pattern);
      if (m) {
        const file = fileGroup && m[fileGroup] ? m[fileGroup].trim() : undefined;
        return [{ type: "tool_start", toolName: tool, toolFile: file }];
      }
    }

    // 3. Check thinking patterns
    for (const pat of this.compiled.thinking) {
      if (pat.test(trimmed)) {
        return [{ type: "thinking" }];
      }
    }

    // 4. Check idle patterns
    for (const pat of this.compiled.idle) {
      if (pat.test(trimmed)) {
        return [{ type: "idle" }];
      }
    }

    // 5. Regular text — skip lines that look like pure decoration
    if (/^[─━═╌╍┄┅┈┉⎯]{3,}$/.test(trimmed)) {
      return [];
    }

    return [{ type: "assistant_text", content: line }];
  }

  private applyUpdate(update: ParsedUpdate): AgentMessage | null {
    switch (update.type) {
      case "thinking": {
        // Finalize any current text message
        this.finalizeCurrentMessage();
        this.state = "thinking";
        // Create a system message for thinking indicator
        const msg = this.createMessage("system", "Thinking...");
        msg.isStreaming = true;
        return msg;
      }

      case "tool_start": {
        // If we had a thinking message, finalize it
        if (this.state === "thinking" && this.currentMessage?.role === "system") {
          this.currentMessage.isStreaming = false;
        }
        // Finalize any current text message before starting tool
        if (this.state === "text") {
          this.finalizeCurrentMessage();
        }

        this.state = "tool";

        // Try to add tool call to existing assistant message, or create one
        const target = this.getOrCreateAssistantMessage();
        const toolCall: AgentToolCall = {
          id: generateId("tc"),
          name: update.toolName ?? "unknown",
          file: update.toolFile,
          status: "running",
        };

        // Mark previous tool calls on this message as done
        if (target.toolCalls) {
          for (const tc of target.toolCalls) {
            if (tc.status === "running") {
              tc.status = "done";
            }
          }
        }

        target.toolCalls = [...(target.toolCalls ?? []), toolCall];
        target.isStreaming = true;
        return target;
      }

      case "approval": {
        this.finalizeCurrentMessage();
        this.state = "idle";
        const msg = this.createMessage("system", update.content ?? "Approval needed");
        msg.isStreaming = false;
        return msg;
      }

      case "idle": {
        this.finalizeCurrentMessage();
        this.state = "idle";
        return null;
      }

      case "assistant_text": {
        // If we were in thinking state, finalize the thinking indicator
        if (this.state === "thinking" && this.currentMessage?.role === "system") {
          this.currentMessage.isStreaming = false;
          this.currentMessage = null;
        }

        // If we were in tool state, the tool output is supplementary text
        // — fold it into the current assistant message
        if (this.state === "tool") {
          // Mark running tools as done when text appears (tool produced output)
          if (this.currentMessage?.toolCalls) {
            for (const tc of this.currentMessage.toolCalls) {
              if (tc.status === "running") tc.status = "done";
            }
          }
          this.state = "text";
        }

        if (this.state !== "text" || !this.currentMessage || this.currentMessage.role !== "assistant") {
          // Start a new assistant text message
          this.state = "text";
          const msg = this.createMessage("assistant", update.content ?? "");
          msg.isStreaming = true;
          return msg;
        }

        // Append to existing assistant message
        const content = update.content ?? "";
        this.currentMessage.content += (this.currentMessage.content ? "\n" : "") + content;
        this.currentMessage.timestamp = Date.now();
        return this.currentMessage;
      }

      default:
        return null;
    }
  }

  private finalizeCurrentMessage(): void {
    if (!this.currentMessage) return;
    this.currentMessage.isStreaming = false;

    // Trim trailing whitespace from content
    this.currentMessage.content = this.currentMessage.content.trimEnd();

    // Mark any still-running tool calls as done
    if (this.currentMessage.toolCalls) {
      for (const tc of this.currentMessage.toolCalls) {
        if (tc.status === "running") tc.status = "done";
      }
    }

    this.currentMessage = null;
  }

  private createMessage(role: AgentMessage["role"], content: string): AgentMessage {
    this.finalizeCurrentMessage();
    const msg: AgentMessage = {
      id: generateId("msg"),
      role,
      content,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.currentMessage = msg;
    return msg;
  }

  private getOrCreateAssistantMessage(): AgentMessage {
    // Reuse current assistant message if it exists and is still streaming
    if (
      this.currentMessage &&
      this.currentMessage.role === "assistant" &&
      this.currentMessage.isStreaming
    ) {
      return this.currentMessage;
    }
    return this.createMessage("assistant", "");
  }
}

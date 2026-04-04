import { useEffect, useRef, useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentStatusPatterns } from "@/types/agent";
import { stripAnsi } from "@/agents/types";

// Default patterns (Claude Code style) — used when no agent config is provided
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

export interface PtyDetectorState {
  needsApproval: boolean;
  currentTool: string | null;
  currentFile: string | null;
  approvalText: string | null;
  agentState: "idle" | "thinking" | "tool_use" | "responding" | "approval_needed";
  lastActivityAt: number;
}

const INITIAL_STATE: PtyDetectorState = {
  needsApproval: false,
  currentTool: null,
  currentFile: null,
  approvalText: null,
  agentState: "idle",
  lastActivityAt: 0,
};

const MAX_BUFFER_SIZE = 4096;

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

function extractApprovalText(lines: string[], approvalPatterns: RegExp[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    if (approvalPatterns.some((pattern) => pattern.test(line))) {
      const context = lines
        .slice(Math.max(0, i - 1), Math.min(lines.length, i + 2))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join("\n");
      return context || line;
    }
  }

  const fallback = lines
    .slice(-3)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return fallback || null;
}

interface UsePtyStateDetectorOpts {
  sessionId: string | null;
  /** Agent-specific patterns. Falls back to Claude Code defaults if not provided. */
  statusPatterns?: AgentStatusPatterns;
  onStateChange?: (prev: PtyDetectorState, next: PtyDetectorState) => void;
}

export function usePtyStateDetector({
  sessionId,
  statusPatterns,
  onStateChange,
}: UsePtyStateDetectorOpts) {
  const stateRef = useRef<PtyDetectorState>({ ...INITIAL_STATE });
  const bufferRef = useRef("");
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // Compile patterns once and cache via ref
  const patternsRef = useRef<CompiledPatterns>(compilePatterns(statusPatterns || DEFAULT_PATTERNS));
  // Update compiled patterns when statusPatterns changes
  useEffect(() => {
    patternsRef.current = compilePatterns(statusPatterns || DEFAULT_PATTERNS);
  }, [statusPatterns]);

  const updateState = useCallback((partial: Partial<PtyDetectorState>) => {
    const prev = { ...stateRef.current };
    const next = { ...stateRef.current, ...partial };

    if (
      prev.needsApproval !== next.needsApproval ||
      prev.currentTool !== next.currentTool ||
      prev.currentFile !== next.currentFile ||
      prev.approvalText !== next.approvalText ||
      prev.agentState !== next.agentState
    ) {
      stateRef.current = next;
      onStateChangeRef.current?.(prev, next);
    } else {
      stateRef.current = next;
    }
  }, []);

  const processData = useCallback(
    (data: string) => {
      const stripped = stripAnsi(data);
      bufferRef.current += stripped;
      if (bufferRef.current.length > MAX_BUFFER_SIZE) {
        bufferRef.current = bufferRef.current.slice(-MAX_BUFFER_SIZE);
      }

      const now = Date.now();
      const recent = bufferRef.current.slice(-1024);
      const lines = recent.split("\n");
      const lastLines = lines.slice(-8);
      const lastChunk = lastLines.join("\n");

      const compiled = patternsRef.current;

      // 1. Approval detection
      let needsApproval = false;
      let approvalText: string | null = null;
      for (const pat of compiled.approval) {
        if (pat.test(lastChunk)) {
          needsApproval = true;
          approvalText = extractApprovalText(lastLines, compiled.approval);
          break;
        }
      }

      // 2. Tool use detection
      let currentTool: string | null = null;
      let currentFile: string | null = null;
      for (let i = lastLines.length - 1; i >= 0; i--) {
        const line = lastLines[i];
        for (const { pattern, tool, fileGroup } of compiled.toolUse) {
          const m = line.match(pattern);
          if (m) {
            currentTool = tool;
            currentFile = fileGroup && m[fileGroup] ? m[fileGroup].trim() : null;
            break;
          }
        }
        if (currentTool) break;
      }

      // 3. Agent state
      let agentState: PtyDetectorState["agentState"] = "responding";
      if (needsApproval) {
        agentState = "approval_needed";
      } else if (currentTool) {
        agentState = "tool_use";
      } else {
        // Check thinking
        for (const pat of compiled.thinking) {
          if (pat.test(lastChunk)) {
            agentState = "thinking";
            break;
          }
        }
        // Check idle
        if (agentState === "responding") {
          for (const pat of compiled.idle) {
            if (pat.test(lastChunk)) {
              agentState = "idle";
              break;
            }
          }
        }
      }

      updateState({
        needsApproval,
        currentTool,
        currentFile,
        approvalText,
        agentState,
        lastActivityAt: now,
      });
    },
    [updateState],
  );

  const clearApproval = useCallback(() => {
    if (stateRef.current.needsApproval) {
      updateState({ needsApproval: false, approvalText: null, agentState: "responding" });
    }
  }, [updateState]);

  const reset = useCallback(() => {
    bufferRef.current = "";
    stateRef.current = { ...INITIAL_STATE };
  }, []);

  // Listen to PTY output
  useEffect(() => {
    if (!sessionId) return;

    let unlisten: UnlistenFn | null = null;
    let mounted = true;

    listen<{ session_id: string; data: string }>("pty:output", (event) => {
      if (!mounted) return;
      if (event.payload.session_id === sessionId) {
        processData(event.payload.data);
      }
    }).then((fn) => {
      if (mounted) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      mounted = false;
      unlisten?.();
      reset();
    };
  }, [sessionId, processData, reset]);

  // Auto-clear idle after 10s of no activity
  useEffect(() => {
    const interval = setInterval(() => {
      const st = stateRef.current;
      if (
        st.lastActivityAt > 0 &&
        Date.now() - st.lastActivityAt > 10_000 &&
        st.agentState !== "idle" &&
        !st.needsApproval
      ) {
        updateState({
          currentTool: null,
          currentFile: null,
          agentState: "idle",
        });
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [updateState]);

  return { stateRef, clearApproval, reset, ingestData: processData };
}

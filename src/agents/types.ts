import type { AgentConfig, AgentAdapter, AgentStateUpdate } from "@/types/agent";

// Re-export for convenience
export type { AgentConfig, AgentAdapter, AgentStateUpdate };

// ANSI strip helper shared across adapters
const ANSI_RE = new RegExp(
  [
    "\\x1B\\[[0-9;]*[A-Za-z]",
    "\\x1B\\].*?\\x07",
    "\\x1B[()][A-Z0-9]",
    "\\x1B[>=<]",
    "\\x0F",
    "\\x0E",
  ].join("|"),
  "g",
);

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

/**
 * Creates a parseOutput function from AgentStatusPatterns.
 * Compiles string patterns into RegExp objects for runtime matching.
 */
export function createPatternParser(config: AgentConfig) {
  const approvalRegexes = config.statusPatterns.approval.map((p) => new RegExp(p, "i"));
  const thinkingRegexes = config.statusPatterns.thinking.map((p) => new RegExp(p, "i"));
  const idleRegexes = config.statusPatterns.idle.map((p) => new RegExp(p, "im"));
  const toolRegexes = config.statusPatterns.toolUse.map((t) => ({
    pattern: new RegExp(t.pattern, "i"),
    tool: t.tool,
    fileGroup: t.fileGroup,
  }));

  return function parseOutput(rawData: string): AgentStateUpdate | null {
    const data = stripAnsi(rawData);
    const lines = data.split("\n");
    const lastLines = lines.slice(-8);
    const lastChunk = lastLines.join("\n");

    // 1. Approval detection
    for (const pat of approvalRegexes) {
      if (pat.test(lastChunk)) {
        const approvalLine = [...lastLines]
          .reverse()
          .find((line) => pat.test(line) || line.trim().length > 0)
          ?.trim();
        return {
          agentState: "approval_needed",
          approvalText: approvalLine || lastChunk.trim() || null,
        };
      }
    }

    // 2. Tool use detection
    for (let i = lastLines.length - 1; i >= 0; i--) {
      for (const { pattern, tool, fileGroup } of toolRegexes) {
        const m = lastLines[i].match(pattern);
        if (m) {
          return {
            agentState: "tool_use",
            currentTool: tool,
            currentFile: fileGroup && m[fileGroup] ? m[fileGroup].trim() : null,
          };
        }
      }
    }

    // 3. Thinking detection
    for (const pat of thinkingRegexes) {
      if (pat.test(lastChunk)) {
        return { agentState: "thinking" };
      }
    }

    // 4. Idle detection
    for (const pat of idleRegexes) {
      if (pat.test(lastChunk)) {
        return { agentState: "idle" };
      }
    }

    // Default — still responding
    return { agentState: "responding" };
  };
}

/**
 * Base adapter factory — creates an adapter from an AgentConfig.
 * Agent-specific adapters can override individual methods.
 */
export function createBaseAdapter(config: AgentConfig): AgentAdapter {
  const parseOutput = createPatternParser(config);

  return {
    config,

    buildLaunchArgs(_taskDescription: string, model?: string) {
      const args = [...config.defaultArgs];
      if (model) {
        args.push("--model", model);
      }
      return { command: config.command, args };
    },

    formatPrompt(taskDescription: string, context?: string) {
      let prompt = taskDescription;
      if (context) {
        prompt = `${context}\n\n${taskDescription}`;
      }
      return prompt;
    },

    parseOutput,

    approveAction() {
      return config.approvalActions?.approve ?? "y\n";
    },

    denyAction() {
      return config.approvalActions?.deny ?? "n\n";
    },

    abortAction() {
      return config.approvalActions?.abort ?? "\x03";
    },
  };
}

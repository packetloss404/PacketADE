import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RotateCw,
  Terminal,
  XCircle,
} from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { useAgentTaskStore } from "@/stores/agentTaskStore";

interface BashInput {
  command: string;
  cwd?: string;
}

interface BashToolCallCardProps {
  toolCall: AgentToolCall;
  conversationId: string;
  verbosity?: "summary" | "normal" | "verbose";
}

function parseBashInput(raw: string | undefined): BashInput {
  if (!raw) return { command: "" };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const command =
      typeof parsed.command === "string" ? parsed.command : "";
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
    return { command, cwd };
  } catch {
    return { command: raw };
  }
}

function ExitCodePill({ status }: { status: AgentToolCall["status"] }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-bg-primary text-text-muted text-[10px] font-mono">
        <Loader2 size={10} className="animate-spin" />
        running
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-accent-red/10 text-accent-red text-[10px] font-mono">
        <XCircle size={10} />
        exit 1
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-accent-green/10 text-accent-green text-[10px] font-mono">
      <CheckCircle2 size={10} />
      exit 0
    </span>
  );
}

export function BashToolCallCard({
  toolCall,
  conversationId,
  verbosity = "normal",
}: BashToolCallCardProps) {
  const { command, cwd } = useMemo(
    () => parseBashInput(toolCall.input),
    [toolCall.input],
  );

  const [expanded, setExpanded] = useState(verbosity === "verbose");
  const [copied, setCopied] = useState(false);

  const body = toolCall.fullContent ?? toolCall.summary ?? "";
  const hasBody = body.trim().length > 0;
  const showBody = verbosity !== "summary" && expanded && hasBody;

  const handleCopy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable in some webviews; silently ignore
    }
  };

  const handleRerun = () => {
    if (!command) return;
    useAgentTaskStore
      .getState()
      .sendMessage(conversationId, `Re-run \`${command}\``);
  };

  const canToggle = verbosity !== "summary" && hasBody;

  return (
    <div className="bg-bg-hover rounded text-[10px] text-text-muted border border-bg-border/50">
      <div className="flex items-center gap-1.5 px-2 py-1">
        {canToggle ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label={expanded ? "Collapse output" : "Expand output"}
          >
            {expanded ? (
              <ChevronDown size={10} />
            ) : (
              <ChevronRight size={10} />
            )}
          </button>
        ) : (
          <span className="w-[10px]" />
        )}
        <Terminal size={11} className="text-text-muted shrink-0" />
        <span
          className="font-mono text-text-primary truncate flex-1 min-w-0"
          title={command}
        >
          {command || "(no command)"}
        </span>
        <ExitCodePill status={toolCall.status} />
        <button
          type="button"
          onClick={handleCopy}
          className="text-text-muted hover:text-text-primary transition-colors p-0.5 rounded hover:bg-bg-border/50"
          title={copied ? "Copied!" : "Copy command"}
          aria-label="Copy command"
        >
          {copied ? (
            <CheckCircle2 size={11} className="text-accent-green" />
          ) : (
            <Copy size={11} />
          )}
        </button>
        <button
          type="button"
          onClick={handleRerun}
          className="text-text-muted hover:text-text-primary transition-colors p-0.5 rounded hover:bg-bg-border/50"
          title="Re-run command"
          aria-label="Re-run command"
        >
          <RotateCw size={11} />
        </button>
      </div>
      {verbosity === "verbose" && cwd && (
        <div className="px-2 pb-1 font-mono text-[10px] text-text-muted/80 truncate">
          cwd: {cwd}
        </div>
      )}
      {showBody && (
        <pre
          className="text-[11px] font-mono whitespace-pre-wrap bg-bg-primary rounded p-2 mx-1 mb-1 text-text-primary overflow-y-auto"
          style={{ maxHeight: 320 }}
        >
          {body}
        </pre>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, RotateCw, Terminal } from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { BaseToolCard } from "./tool-cards/BaseToolCard";
import { StatusPill } from "./tool-cards/StatusPill";

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

  // Keep expand state in sync when the per-conversation verbosity control
  // changes after the card has mounted.
  useEffect(() => {
    setExpanded(verbosity === "verbose");
  }, [verbosity]);

  const body = toolCall.fullContent ?? toolCall.summary ?? "";
  const hasBody = body.trim().length > 0;
  const canToggle = verbosity !== "summary" && hasBody;

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

  // F5: prefer the real exit code from `tool_output_extended` over the
  // status-derived best guess. Status only tells us "errored or didn't" —
  // a real `exit 137` is meaningfully different from `exit 1`.
  const pillStatus = toolCall.status;
  const pill =
    pillStatus === "running" ? (
      <StatusPill status="running" />
    ) : (
      <StatusPill
        status={pillStatus}
        variant="exit-code"
        exitCode={
          toolCall.exitCode ?? (pillStatus === "error" ? 1 : 0)
        }
      />
    );

  const headerActions = (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className="text-text-muted hover:text-text-primary transition-colors p-0.5 rounded hover:bg-bg-border"
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
        className="text-text-muted hover:text-text-primary transition-colors p-0.5 rounded hover:bg-bg-border"
        title="Ask agent to re-run this command"
        aria-label="Ask agent to re-run this command"
      >
        <RotateCw size={11} />
      </button>
    </>
  );

  const subHeader =
    verbosity === "verbose" && cwd ? (
      <div className="px-2 pb-1 font-mono text-[10px] text-text-faint truncate">
        cwd: {cwd}
      </div>
    ) : undefined;

  return (
    <BaseToolCard
      icon={<Terminal size={11} className="text-text-muted shrink-0" />}
      title={
        <span className="font-mono">{command || "(no command)"}</span>
      }
      titleAttr={command}
      statusPill={pill}
      headerActions={headerActions}
      subHeader={subHeader}
      canToggle={canToggle}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={{
        expanded: "Collapse output",
        collapsed: "Expand output",
      }}
      isError={toolCall.status === "error"}
    >
      <pre className="text-[11px] font-mono whitespace-pre-wrap bg-bg-primary rounded p-2 mx-1 mb-1 text-text-primary overflow-y-auto max-h-[320px]">
        {body}
      </pre>
    </BaseToolCard>
  );
}

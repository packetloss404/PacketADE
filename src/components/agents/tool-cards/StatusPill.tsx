import { CheckCircle2, XCircle } from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { Spinner } from "@/components/ui/Spinner";

type StatusPillProps =
  | { status: Extract<AgentToolCall["status"], "running"> }
  | {
      // "label" renders done/error literals; "exit-code" formats `exit N` and
      // colours by code === 0 (used by bash where a real exit number is more
      // informative than the binary status flag).
      status: Exclude<AgentToolCall["status"], "running">;
      variant: "label";
    }
  | {
      status: Exclude<AgentToolCall["status"], "running">;
      variant: "exit-code";
      exitCode: number;
    };

const PILL_BASE =
  "inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full text-meta font-mono";

export function StatusPill(props: StatusPillProps) {
  if (props.status === "running") {
    return (
      <span className={`${PILL_BASE} bg-bg-primary text-text-muted`}>
        <Spinner size={10} label="running" />
        running
      </span>
    );
  }

  if (props.variant === "exit-code") {
    const ok = props.exitCode === 0;
    return (
      <span
        className={`${PILL_BASE} ${
          ok
            ? "bg-accent-green/10 text-accent-green"
            : "bg-accent-red/10 text-accent-red"
        }`}
      >
        {ok ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
        exit {props.exitCode}
      </span>
    );
  }

  const isError = props.status === "error";
  return (
    <span
      className={`${PILL_BASE} ${
        isError
          ? "bg-accent-red/10 text-accent-red"
          : "bg-accent-green/10 text-accent-green"
      }`}
    >
      {isError ? <XCircle size={10} /> : <CheckCircle2 size={10} />}
      {isError ? "error" : "done"}
    </span>
  );
}

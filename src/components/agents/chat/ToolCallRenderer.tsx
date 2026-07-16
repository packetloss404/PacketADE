import { memo } from "react";
import { BashToolCallCard } from "../BashToolCallCard";
import { MultiFileEditCard } from "../MultiFileEditCard";
import { SubagentToolCallCard } from "../SubagentToolCallCard";
import { TaskListCard } from "../TaskListCard";
import { ToolCallCard } from "./ToolCallCard";
import { isEditToolCall } from "@/lib/parseToolInput";
import { isExplorationToolName } from "../ExplorationRollupCard";
import type { AgentToolCall } from "@/types/agent-conversation";

interface ToolCallRendererProps {
  toolCalls: AgentToolCall[];
  conversationId: string;
  projectPath: string;
}

// Memoized: a streaming turn fires many store updates per second; skipping this
// whole subtree when the toolCalls array reference is unchanged (e.g. a text-only
// chunk arrived) avoids re-rendering 40+ tool cards on every token.
export const ToolCallRenderer = memo(function ToolCallRenderer({
  toolCalls,
  conversationId,
  projectPath,
}: ToolCallRendererProps) {
  if (!toolCalls.length) return null;

  // Hide exploration tool calls unconditionally: ExplorationRollupCard (above)
  // is their live streaming representation AND their settled summary, so the
  // stream→settle transition doesn't swap dozens of cards for one rollup (the
  // single-frame layout snap that destroyed scroll position).
  const visible = toolCalls.filter((tc) => !isExplorationToolName(tc.name));
  if (visible.length === 0) return null;

  // Edit-bearing calls across every runtime (write_file, Claude Code's
  // Write/Edit/MultiEdit/NotebookEdit, Codex apply_patch) — normalized by
  // parseEditToolCalls so grouping fires for all providers.
  const writeFileCalls = visible.filter(
    (tc) =>
      (tc.status === "done" || tc.status === "error") && isEditToolCall(tc),
  );
  const otherCalls = visible.filter((tc) => !writeFileCalls.includes(tc));
  const groupWrites = writeFileCalls.length >= 3;
  const rendered = groupWrites ? otherCalls : visible;

  return (
    <div className="flex flex-col gap-1">
      {groupWrites && (
        <MultiFileEditCard
          toolCalls={writeFileCalls}
          conversationId={conversationId}
          projectPath={projectPath}
        />
      )}
      {rendered.map((tc) => {
        if (tc.name === "bash") {
          return <BashToolCallCard key={tc.id} toolCall={tc} />;
        }
        if (tc.name === "spawn_subagent") {
          return (
            <SubagentToolCallCard
              key={tc.id}
              toolCall={tc}
              conversationId={conversationId}
            />
          );
        }
        if (tc.name === "task_list") {
          return <TaskListCard key={tc.id} toolCall={tc} />;
        }
        return (
          <ToolCallCard
            key={tc.id}
            toolCall={tc}
            conversationId={conversationId}
            projectPath={projectPath}
          />
        );
      })}
    </div>
  );
});

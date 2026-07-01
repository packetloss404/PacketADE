import { memo } from "react";
import { BashToolCallCard } from "../BashToolCallCard";
import { MultiFileEditCard } from "../MultiFileEditCard";
import { SubagentToolCallCard } from "../SubagentToolCallCard";
import { TaskListCard } from "../TaskListCard";
import { ToolCallCard } from "./ToolCallCard";
import type {
  AgentToolCall,
  TranscriptVerbosity,
} from "@/types/agent-conversation";

const EXPLORED_TOOL_NAMES = new Set([
  "read_file",
  "Read",
  "grep",
  "Grep",
  "glob",
  "Glob",
  "search",
  "list_directory",
  "list_files",
  "LS",
  "ls",
]);

interface ToolCallRendererProps {
  toolCalls: AgentToolCall[];
  isStreaming: boolean | undefined;
  conversationId: string;
  projectPath: string;
  verbosity: TranscriptVerbosity;
}

// Memoized: a streaming turn fires many store updates per second; skipping this
// whole subtree when the toolCalls array reference is unchanged (e.g. a text-only
// chunk arrived) avoids re-rendering 40+ tool cards on every token.
export const ToolCallRenderer = memo(function ToolCallRenderer({
  toolCalls,
  isStreaming,
  conversationId,
  projectPath,
  verbosity,
}: ToolCallRendererProps) {
  if (!toolCalls.length) return null;

  // Hide explored-only tool calls (already summarized via ExplorationRollupCard
  // above) when the turn has settled. Keep them visible during streaming so the
  // user can watch progress.
  const visible = isStreaming
    ? toolCalls
    : toolCalls.filter((tc) => !EXPLORED_TOOL_NAMES.has(tc.name));
  if (visible.length === 0) return null;

  const writeFileCalls = visible.filter(
    (tc) =>
      tc.name === "write_file" &&
      (tc.status === "done" || tc.status === "error"),
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
          return (
            <BashToolCallCard
              key={tc.id}
              toolCall={tc}
              conversationId={conversationId}
              verbosity={verbosity}
            />
          );
        }
        if (tc.name === "spawn_subagent") {
          return (
            <SubagentToolCallCard
              key={tc.id}
              toolCall={tc}
              conversationId={conversationId}
              verbosity={verbosity}
            />
          );
        }
        if (tc.name === "task_list") {
          return (
            <TaskListCard key={tc.id} toolCall={tc} verbosity={verbosity} />
          );
        }
        return (
          <ToolCallCard
            key={tc.id}
            toolCall={tc}
            projectPath={projectPath}
            verbosity={verbosity}
          />
        );
      })}
    </div>
  );
});

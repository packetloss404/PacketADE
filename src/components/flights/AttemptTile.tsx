import { useEffect, useState } from "react";
import {
  Folder,
  GitPullRequest,
  Server,
  Square,
  Check,
  X as XIcon,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Send,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  ShieldCheck,
  MonitorUp,
  PanelsTopLeft,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useGitHubStore } from "@/stores/githubStore";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { notifyAttemptFailed } from "@/lib/notifications";
import type { Attempt, AttemptStatus, Flight } from "@/types/flight";
import type { AgentMessage } from "@/types/agent-conversation";
import { reviewerGateAllowsAcceptance } from "@/lib/reviewerGate";
import { openFlightAttemptInWorkspace } from "@/lib/agentHandoffs";
import { openMonitorWindow } from "@/lib/monitorWindows";

interface AttemptTileProps {
  flight: Flight;
  attempt: Attempt;
}

const STATUS_META: Record<
  AttemptStatus,
  { label: string; color: string; icon: React.ComponentType<{ size?: number; className?: string }> }
> = {
  queued: { label: "Queued", color: "text-text-muted", icon: Loader2 },
  provisioning: { label: "Provisioning", color: "text-accent-blue", icon: Loader2 },
  running: { label: "Running", color: "text-accent-blue", icon: Loader2 },
  reviewing: { label: "Reviewing", color: "text-accent-amber", icon: AlertTriangle },
  completed: { label: "Completed", color: "text-accent-green", icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-accent-red", icon: AlertTriangle },
  cancelled: { label: "Cancelled", color: "text-text-muted", icon: Square },
};

const EMPTY_MESSAGES: AgentMessage[] = [];

export function AttemptTile({ flight, attempt }: AttemptTileProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === attempt.sessionId),
  );
  const sendMessage = useAgentTaskStore((s) => s.sendMessage);
  const cancelAttempt = useAsyncFlightStore((s) => s.cancelAttempt);
  const setAttemptStatus = useAsyncFlightStore((s) => s.setAttemptStatus);
  const retryReviewGate = useAsyncFlightStore((s) => s.retryReviewGate);
  const overrideReviewGate = useAsyncFlightStore((s) => s.overrideReviewGate);
  const sendReviewFindingsToBuilder = useAsyncFlightStore((s) => s.sendReviewFindingsToBuilder);
  const updateFlight = useFlightStore((s) => s.updateFlight);

  const [followUp, setFollowUp] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const messages = conversation?.messages ?? EMPTY_MESSAGES;

  const attemptLabel = attempt.target.kind === "ssh" ? attempt.target.serverId : "local";

  // Notify on transition into "failed" (whether from backend or UI rejection).
  useEffect(() => {
    if (attempt.status === "failed") {
      void notifyAttemptFailed(flight.title, attemptLabel, attempt.errorMessage);
    }
  }, [attempt.status, attempt.errorMessage, flight.title, attemptLabel]);

  // Roll up cost/tokens from streamed messages onto the persisted attempt.
  useEffect(() => {
    if (!conversation) return;
    const totals = conversation.messages.reduce(
      (acc, m) => {
        acc.input += m.inputTokens ?? 0;
        acc.output += m.outputTokens ?? 0;
        return acc;
      },
      { input: 0, output: 0 },
    );
    const total = totals.input + totals.output;
    if (total > 0 && total !== attempt.tokens) {
      const updated = (flight.attempts ?? []).map((a) =>
        a.id === attempt.id ? { ...a, tokens: total } : a,
      );
      updateFlight(flight.id, { attempts: updated });
    }
  }, [conversation?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = STATUS_META[attempt.status];
  const StatusIcon = meta.icon;
  const isInProgress =
    attempt.status === "queued" ||
    attempt.status === "provisioning" ||
    attempt.status === "running";

  const visibleMessages = expanded ? messages : messages.slice(-5);

  const targetIcon = attempt.target.kind === "ssh" ? Server : Folder;
  const targetLabel =
    attempt.target.kind === "ssh"
      ? attempt.target.serverId
      : (attempt.target.basePath.split(/[/\\]/).filter(Boolean).pop() ?? "local");
  const acceptance = reviewerGateAllowsAcceptance(flight, attempt);
  const gate = attempt.reviewGate;

  async function runAction(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleSend() {
    const text = followUp.trim();
    if (!text || !conversation) return;
    sendMessage(attempt.sessionId, text);
    setFollowUp("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded border border-bg-border bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-1.5 text-[11px]">
        <StatusIcon
          size={12}
          className={`${meta.color} ${isInProgress ? "animate-spin" : ""} flex-shrink-0`}
        />
        <span className={`font-medium ${meta.color}`}>{meta.label}</span>
        {React.createElement(targetIcon, {
          size: 11,
          className: "text-text-muted flex-shrink-0",
        })}
        <span className="truncate text-text-secondary">{targetLabel}</span>
        <span className="text-text-muted">·</span>
        <span className="truncate text-text-muted">
          {attempt.model.split("-").slice(0, 2).join("-")}
        </span>
        {/* v0.8-G: draft PR link, shown when the attempt was published */}
        {attempt.draftPrNumber && <DraftPrLink prNumber={attempt.draftPrNumber} />}
        <span className="ml-auto text-text-muted">
          {attempt.tokens > 0 ? `${(attempt.tokens / 1000).toFixed(1)}k` : ""}
        </span>
      </div>

      {/* Messages */}
      <div className="max-h-[340px] min-h-[160px] flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {messages.length === 0 ? (
          <div className="py-2 text-[10px] italic text-text-muted">Waiting for agent to start…</div>
        ) : (
          <>
            {messages.length > 5 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-text-muted transition-colors hover:text-text-primary"
              >
                {expanded ? (
                  <>
                    <ChevronDown size={10} /> Showing all {messages.length}
                  </>
                ) : (
                  <>
                    <ChevronRight size={10} /> {messages.length - 5} earlier message
                    {messages.length - 5 === 1 ? "" : "s"}
                  </>
                )}
              </button>
            )}
            {visibleMessages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </>
        )}

        {attempt.errorMessage && (
          <div className="bg-accent-red/10 border-accent-red/30 rounded border px-2 py-1 text-[10px] text-accent-red">
            {attempt.failureCategory && (
              <span className="bg-accent-red/20 mr-1 rounded px-1 font-mono uppercase tracking-wide">
                {attempt.failureCategory.replace(/_/g, " ")}
              </span>
            )}
            {attempt.errorMessage}
          </div>
        )}

        {flight.reviewGatePolicy?.enabled && (
          <div className="border-accent-purple/30 bg-accent-purple/5 rounded border px-2.5 py-2 text-[10px]">
            <div className="flex items-center gap-1.5 text-text-secondary">
              <ShieldCheck size={11} className="text-accent-purple" />
              <span className="font-medium">Independent Reviewer Gate</span>
              <span className="ml-auto uppercase tracking-wide text-text-muted">
                {gate?.status.replace(/_/g, " ") ?? "pending"}
              </span>
            </div>
            {gate?.report && (
              <div className="mt-1.5 space-y-1.5">
                <p className="text-text-secondary">{gate.report.summary}</p>
                {gate.report.findings.map((finding, index) => (
                  <div
                    key={`${finding.title}-${index}`}
                    className={`rounded border px-2 py-1 ${
                      finding.severity === "error"
                        ? "border-accent-red/30 bg-accent-red/5 text-accent-red"
                        : finding.severity === "warning"
                          ? "border-accent-amber/30 bg-accent-amber/5 text-accent-amber"
                          : "border-bg-border text-text-secondary"
                    }`}
                  >
                    <span className="font-medium">{finding.title}</span>
                    {finding.filePath && (
                      <span className="ml-1 font-mono text-text-muted">
                        {finding.filePath}
                        {finding.line ? `:${finding.line}` : ""}
                      </span>
                    )}
                    <div className="mt-0.5 text-text-secondary">{finding.details}</div>
                  </div>
                ))}
              </div>
            )}
            {gate?.errorMessage && <p className="mt-1.5 text-accent-red">{gate.errorMessage}</p>}
            {gate?.status === "overridden" && gate.overrideReason && (
              <p className="mt-1.5 text-accent-amber">Override recorded: {gate.overrideReason}</p>
            )}
            {gate && ["changes_requested", "blocked", "error"].includes(gate.status) && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <button
                  onClick={() => void runAction(() => retryReviewGate(flight.id, attempt.id))}
                  className="flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-text-secondary hover:text-text-primary"
                >
                  <RotateCcw size={9} /> Retry reviewer
                </button>
                {gate.report && (
                  <button
                    onClick={() =>
                      void runAction(() => sendReviewFindingsToBuilder(flight.id, attempt.id))
                    }
                    className="flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-text-secondary hover:text-text-primary"
                  >
                    <Send size={9} /> Send findings to builder
                  </button>
                )}
                <button
                  onClick={() => setOverrideOpen((value) => !value)}
                  className="border-accent-amber/30 hover:bg-accent-amber/10 rounded border px-2 py-0.5 text-accent-amber"
                >
                  Override…
                </button>
              </div>
            )}
            {overrideOpen && gate?.status !== "overridden" && (
              <div className="mt-2 flex items-start gap-1">
                <textarea
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  rows={2}
                  placeholder="Required reason for accepting despite the reviewer"
                  className="border-accent-amber/30 flex-1 resize-none rounded border bg-bg-primary px-2 py-1 text-[10px] text-text-primary outline-none"
                />
                <button
                  disabled={overrideReason.trim().length < 3}
                  onClick={() =>
                    void runAction(async () => {
                      await overrideReviewGate(flight.id, attempt.id, overrideReason);
                      setOverrideOpen(false);
                      setOverrideReason("");
                    })
                  }
                  className="border-accent-amber/30 bg-accent-amber/10 rounded border px-2 py-1 text-accent-amber disabled:opacity-40"
                >
                  Record
                </button>
              </div>
            )}
          </div>
        )}

        {actionError && (
          <div className="border-accent-red/30 bg-accent-red/10 rounded border px-2 py-1 text-[10px] text-accent-red">
            {actionError}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-bg-border bg-bg-secondary">
        {/* Follow-up input — always visible while in progress or reviewing */}
        {(isInProgress || attempt.status === "reviewing") && conversation && (
          <div className="flex items-center gap-1 px-2 py-1.5">
            <textarea
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Send a follow-up message…"
              rows={1}
              className="focus:border-accent-green/40 flex-1 resize-none rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-muted"
            />
            <button
              onClick={handleSend}
              disabled={!followUp.trim()}
              className="hover:bg-accent-green/10 rounded p-1 text-accent-green disabled:opacity-30"
              title="Send (Enter)"
            >
              <Send size={12} />
            </button>
          </div>
        )}

        {/* Action row */}
        <div className="border-bg-border/40 flex items-center justify-end gap-1 border-t px-2 py-1">
          {conversation && (
            <>
              <button
                onClick={() => {
                  const result = openFlightAttemptInWorkspace(attempt.sessionId);
                  if (!result.ok) setActionError(result.message);
                }}
                className="flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"
                title="Open this attempt's project in a CLI-first Workspace"
              >
                <PanelsTopLeft size={10} /> Open in Workspace
              </button>
              <button
                onClick={() =>
                  void runAction(() =>
                    openMonitorWindow({
                      kind: "agent_conversation",
                      conversationId: attempt.sessionId,
                    }).then(() => {}),
                  )
                }
                className="flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"
                title="Open a read-only monitor for this attempt"
              >
                <MonitorUp size={10} /> Monitor
              </button>
            </>
          )}
          {attempt.status === "reviewing" && (
            <>
              <button
                onClick={() =>
                  void runAction(() => setAttemptStatus(flight.id, attempt.id, "completed"))
                }
                disabled={!acceptance.allowed}
                title={acceptance.reason}
                className="bg-accent-green/10 border-accent-green/30 hover:bg-accent-green/20 flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] text-accent-green disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Check size={10} /> Accept
              </button>
              <button
                onClick={() =>
                  void runAction(() => setAttemptStatus(flight.id, attempt.id, "failed"))
                }
                className="hover:bg-accent-red/10 flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-[10px] text-accent-red"
              >
                <XIcon size={10} /> Reject
              </button>
            </>
          )}
          {isInProgress && (
            <button
              onClick={() => void cancelAttempt(flight.id, attempt.id)}
              className="flex items-center gap-1 rounded border border-bg-border px-2 py-0.5 text-[10px] text-text-muted hover:text-accent-red"
              title="Cancel attempt + remove worktree"
            >
              <Square size={10} /> Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: AgentMessage }) {
  if (message.role === "user") {
    return (
      <div className="bg-bg-secondary/50 rounded-sm border-l-2 border-accent-purple px-2 py-1 text-[11px] text-text-secondary">
        <span className="mr-1.5 text-[9px] uppercase tracking-wide text-accent-purple">You</span>
        {message.content}
      </div>
    );
  }
  if (message.role === "system") {
    return <div className="text-[10px] italic text-text-muted">{message.content}</div>;
  }
  // assistant
  return (
    <div className="text-[11px] text-text-primary">
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mb-1.5 flex flex-col gap-0.5">
          {message.toolCalls.map((tc) => (
            <ToolCallChip key={tc.id} call={tc} />
          ))}
        </div>
      )}
      {message.content && (
        <div className="prose prose-invert prose-sm max-w-none [&>*]:my-1 [&>*]:text-[11px]">
          <MarkdownRenderer content={message.content} />
        </div>
      )}
      {message.isStreaming && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-text-muted">
          <Loader2 size={10} className="animate-spin" /> streaming…
        </div>
      )}
    </div>
  );
}

function ToolCallChip({
  call,
}: {
  call: { id: string; name: string; status: string; summary?: string };
}) {
  const color =
    call.status === "running"
      ? "text-accent-blue"
      : call.status === "error"
        ? "text-accent-red"
        : "text-accent-green";
  return (
    <div className={`flex items-center gap-1.5 text-[10px] ${color}`} title={call.summary ?? ""}>
      <span className="font-mono">{call.name}</span>
      {call.status === "running" && <Loader2 size={9} className="animate-spin" />}
      {call.status === "done" && <Check size={9} />}
      {call.status === "error" && <AlertTriangle size={9} />}
      {call.summary && (
        <span className="max-w-[200px] truncate text-text-muted">
          {call.summary.split("\n")[0]}
        </span>
      )}
    </div>
  );
}

// Need to import React for React.createElement above
import React from "react";

/**
 * v0.8-G: small "Draft PR #N" pill rendered next to an attempt's status
 * header once its branch has been published. Clicking opens the PR on
 * GitHub in the user's default browser via the standard anchor target.
 */
function DraftPrLink({ prNumber }: { prNumber: number }) {
  const selectedRepo = useGitHubStore((s) => s.config.selectedRepo);
  const href = selectedRepo
    ? `https://github.com/${selectedRepo.owner}/${selectedRepo.repo}/pull/${prNumber}`
    : undefined;
  const inner = (
    <>
      <GitPullRequest size={10} className="text-accent-purple" />
      <span className="font-medium">Draft PR #{prNumber}</span>
    </>
  );
  if (!href) {
    return (
      <span className="border-accent-purple/30 bg-accent-purple/10 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-accent-purple">
        {inner}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="border-accent-purple/30 bg-accent-purple/10 hover:bg-accent-purple/20 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-accent-purple"
      title={`Open PR #${prNumber} on GitHub`}
    >
      {inner}
    </a>
  );
}

import { useMemo, useState } from "react";
import { Archive, Check, Clipboard, Inbox, RotateCcw, Send, Terminal } from "lucide-react";
import { selectCooperativeTaskViews } from "@/lib/cooperativeFlight";
import {
  acknowledgeCoordinationMessage,
  archiveCoordinationMessage,
  expandCoordinationRecipients,
  postCoordinationMessage,
  retryCoordinationMessage,
  sendCoordinationMessageToTerminal,
} from "@/stores/coordinationInboxStore";
import { useFlightStore } from "@/stores/flightStore";
import type { CoordinationMessageKind, CoordinationMessageRecipient, Flight } from "@/types/flight";

const KINDS: CoordinationMessageKind[] = [
  "instruction",
  "question",
  "answer",
  "blocker",
  "finding",
  "handoff",
  "artifact",
];

function recipientOptions(flight: Flight): { value: string; label: string }[] {
  const tasks = flight.milestones.flatMap((milestone) => milestone.tasks);
  return [
    { value: "flight", label: "Whole Flight" },
    { value: "all-running", label: "All running agents" },
    { value: "all-ready", label: "All ready tasks" },
    { value: "role:builder", label: "Role · builders" },
    { value: "role:reviewer", label: "Role · reviewers" },
    { value: "role:scout", label: "Role · scouts" },
    { value: "role:coordinator", label: "Role · coordinators" },
    ...tasks.map((task) => ({ value: `task:${task.id}`, label: `Task · ${task.title}` })),
    ...(flight.attempts ?? []).map((attempt) => ({
      value: `attempt:${attempt.id}`,
      label: `Attempt · ${attempt.id.slice(-8)}`,
    })),
  ];
}

function resolveRecipients(flight: Flight, value: string): CoordinationMessageRecipient[] {
  if (value === "flight") return [{ kind: "flight", id: flight.id, label: flight.title }];
  if (value === "all-running") {
    return (flight.attempts ?? [])
      .filter((attempt) =>
        ["queued", "provisioning", "running", "reviewing"].includes(attempt.status),
      )
      .map((attempt) => ({
        kind: "attempt" as const,
        id: attempt.id,
        label: attempt.id.slice(-8),
      }));
  }
  if (value === "all-ready") {
    return selectCooperativeTaskViews(flight)
      .filter((view) => view.state === "ready")
      .map((view) => ({ kind: "task" as const, id: view.task.id, label: view.task.title }));
  }
  const [kind, id] = value.split(":", 2);
  if (kind === "role") return [{ kind: "role", id, label: id }];
  if (kind === "task") {
    const task = flight.milestones
      .flatMap((milestone) => milestone.tasks)
      .find((candidate) => candidate.id === id);
    return [{ kind: "task", id, label: task?.title ?? id }];
  }
  if (kind === "attempt") return [{ kind: "attempt", id, label: id.slice(-8) }];
  return [];
}

export function FlightCoordinationInbox({ flight }: { flight: Flight }) {
  const liveFlight =
    useFlightStore((state) => state.flights.find((candidate) => candidate.id === flight.id)) ??
    flight;
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | "needs_response" | "failed">("all");
  const [kind, setKind] = useState<CoordinationMessageKind>("instruction");
  const [recipient, setRecipient] = useState("flight");
  const [body, setBody] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const inbox = liveFlight.coordinationInbox ?? [];
  const needsResponse = inbox.filter(
    (message) =>
      message.status === "queued" &&
      (message.sender.kind === "agent" ||
        message.kind === "question" ||
        message.kind === "blocker"),
  ).length;
  const failed = inbox.filter((message) => message.status === "failed").length;
  const preview = useMemo(() => {
    try {
      return expandCoordinationRecipients(liveFlight, resolveRecipients(liveFlight, recipient));
    } catch {
      return [];
    }
  }, [liveFlight, recipient]);
  const visible = inbox
    .filter((message) => message.status !== "archived")
    .filter((message) => {
      if (filter === "failed") return message.status === "failed";
      if (filter === "needs_response") {
        return (
          message.status === "queued" &&
          (message.sender.kind === "agent" ||
            message.kind === "question" ||
            message.kind === "blocker")
        );
      }
      return true;
    })
    .sort((left, right) => right.createdAt - left.createdAt);

  async function run(action: () => Promise<void>, success?: string) {
    setFeedback(null);
    try {
      await action();
      if (success) setFeedback(success);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  }

  async function submit() {
    await run(async () => {
      const recipients = resolveRecipients(liveFlight, recipient);
      const posted = await postCoordinationMessage({
        flightId: liveFlight.id,
        kind,
        sender: { kind: "user", id: "user", displayName: "You" },
        recipients,
        body,
      });
      setBody("");
      setFeedback(
        `Posted ${posted.length} delivery${posted.length === 1 ? "" : "ies"} to ${preview.map((item) => item.label ?? item.id).join(", ")}.`,
      );
    });
  }

  return (
    <div className="rounded border border-bg-border bg-bg-secondary">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Inbox size={12} className="text-accent-blue" />
        <span className="text-[11px] font-semibold text-text-primary">Coordination inbox</span>
        {needsResponse > 0 && (
          <span className="bg-accent-amber/15 rounded-full px-1.5 text-[9px] text-accent-amber">
            {needsResponse} need response
          </span>
        )}
        {failed > 0 && (
          <span className="bg-accent-red/15 rounded-full px-1.5 text-[9px] text-accent-red">
            {failed} failed
          </span>
        )}
        <span className="ml-auto text-[10px] text-text-muted">
          {inbox.length} message{inbox.length === 1 ? "" : "s"} · {expanded ? "hide" : "show"}
        </span>
      </button>

      {expanded && (
        <>
          <div className="grid grid-cols-[130px_minmax(170px,1fr)] gap-2 border-t border-bg-border px-3 py-2">
            <select
              aria-label="Coordination message kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as CoordinationMessageKind)}
              className="rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10px] text-text-secondary outline-none"
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <select
              aria-label="Coordination recipients"
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              className="rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10px] text-text-secondary outline-none"
            >
              {recipientOptions(liveFlight).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <textarea
              aria-label="Coordination message"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={2}
              placeholder="Steer the selected task, role, agent, or Flight…"
              className="col-span-2 resize-none rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[10px] text-text-primary outline-none placeholder:text-text-muted"
            />
            <div className="col-span-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[9px] text-text-muted">
                Exact recipients:{" "}
                {preview.length > 0
                  ? preview.map((item) => item.label ?? item.id).join(", ")
                  : "none"}
              </span>
              <button
                type="button"
                disabled={!body.trim() || preview.length === 0}
                onClick={() => void submit()}
                className="border-accent-blue/30 bg-accent-blue/10 flex items-center gap-1 rounded border px-2 py-1 text-[10px] text-accent-blue disabled:opacity-40"
              >
                <Send size={9} /> Send
              </button>
            </div>
          </div>

          <div className="flex gap-1 border-t border-bg-border px-3 py-1.5">
            {(["all", "needs_response", "failed"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded px-1.5 py-0.5 text-[9px] ${
                  filter === value
                    ? "bg-bg-tertiary text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {value.replace(/_/g, " ")}
              </button>
            ))}
          </div>

          <div className="max-h-[280px] divide-y divide-bg-border overflow-y-auto border-t border-bg-border">
            {visible.length === 0 ? (
              <div className="px-3 py-4 text-[10px] text-text-muted">
                No coordination messages in this filter.
              </div>
            ) : (
              visible.map((message) => (
                <div key={message.id} className="px-3 py-2 text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-text-primary">
                      {message.sender.displayName}
                    </span>
                    <span className="text-text-muted">→</span>
                    <span className="text-text-secondary">
                      {message.recipient.label ?? message.recipient.id ?? "Flight"}
                    </span>
                    <span className="rounded bg-bg-tertiary px-1 text-[9px] text-text-muted">
                      {message.kind}
                    </span>
                    <span className="ml-auto text-[9px] text-text-muted">{message.status}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-text-secondary">{message.body}</div>
                  {message.errorMessage && (
                    <div className="mt-1 text-accent-red">{message.errorMessage}</div>
                  )}
                  <div className="mt-1 flex justify-end gap-1">
                    <button
                      type="button"
                      title="Copy message"
                      onClick={() => void navigator.clipboard.writeText(message.body)}
                      className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      <Clipboard size={9} />
                    </button>
                    {message.status === "queued" && (
                      <button
                        type="button"
                        title="Explicitly send to a PTY terminal"
                        onClick={() =>
                          void run(() =>
                            sendCoordinationMessageToTerminal(liveFlight.id, message.id),
                          )
                        }
                        className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-accent-blue"
                      >
                        <Terminal size={9} />
                      </button>
                    )}
                    {message.status === "failed" && (
                      <button
                        type="button"
                        title="Retry delivery"
                        onClick={() =>
                          void run(() => retryCoordinationMessage(liveFlight.id, message.id))
                        }
                        className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-accent-blue"
                      >
                        <RotateCcw size={9} />
                      </button>
                    )}
                    {message.status !== "acknowledged" && (
                      <button
                        type="button"
                        title="Acknowledge"
                        onClick={() =>
                          acknowledgeCoordinationMessage(liveFlight.id, message.id, {
                            kind: "user",
                            id: "user",
                            displayName: "You",
                          })
                        }
                        className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-accent-green"
                      >
                        <Check size={9} />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Archive"
                      onClick={() => archiveCoordinationMessage(liveFlight.id, message.id)}
                      className="rounded p-1 text-text-muted hover:bg-bg-tertiary"
                    >
                      <Archive size={9} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          {feedback && (
            <div className="border-t border-bg-border px-3 py-1.5 text-[9px] text-text-secondary">
              {feedback}
            </div>
          )}
        </>
      )}
    </div>
  );
}

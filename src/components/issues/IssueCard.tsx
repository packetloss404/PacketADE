import { Plane } from "lucide-react";
import { type Issue } from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";
import { getLabelColor } from "@/lib/colors";

interface IssueCardProps {
  issue: Issue;
  onDragStart: (e: React.DragEvent) => void;
  onClick: () => void;
  isDragging?: boolean;
}

const PRIORITY_DISPLAY: Record<Issue["priority"], { label: string; color: string }> = {
  critical: { label: "P0", color: "text-accent-red" },
  high: { label: "P1", color: "text-accent-amber" },
  medium: { label: "P2", color: "text-text-faint" },
  low: { label: "P3", color: "text-text-faint" },
};

function shortFlightId(flightId: string): string {
  const stripped = flightId.replace(/^flight[-_]/i, "").slice(0, 4).toUpperCase();
  return `F-${stripped}`;
}

function ticketNumber(ticketId: string): string {
  const m = ticketId.match(/(\d+)$/);
  return m ? `#${m[1]}` : `#${ticketId}`;
}

function ticketInitials(ticketId: string): string {
  const prefix = ticketId.split("-")[0] ?? ticketId;
  return prefix.slice(0, 2).toUpperCase();
}

export function IssueCard({ issue, onDragStart, onClick, isDragging }: IssueCardProps) {
  const flights = useFlightStore((s) => s.flights);
  const flight = flights.find((f) => f.issueIds.includes(issue.id)) ?? null;

  const pri = PRIORITY_DISPLAY[issue.priority];
  const initials = ticketInitials(issue.ticketId);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={`flex flex-col gap-1.5 cursor-pointer rounded-md border border-bg-border bg-bg-secondary p-2.5 transition-all hover:border-line-strong ${
        isDragging ? "opacity-50 scale-[0.97] ring-1 ring-accent-line" : ""
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-text-faint">
          {ticketNumber(issue.ticketId)}
        </span>
        <div className="flex-1" />
        <span className={`font-mono text-[10px] font-semibold ${pri.color}`}>
          {pri.label}
        </span>
      </div>

      <p
        className={`text-[12px] leading-[1.4] text-text-primary ${
          issue.status === "done" ? "line-through opacity-60" : ""
        }`}
      >
        {issue.title}
      </p>

      {(issue.labels.length > 0 || issue.epic) && (
        <div className="flex flex-wrap gap-1">
          {issue.epic && (
            <span className="rounded bg-accent-purple/15 px-1.5 py-px text-[10px] font-medium text-accent-purple">
              {issue.epic}
            </span>
          )}
          {issue.labels.map((label) => {
            const color = getLabelColor(label);
            return (
              <span
                key={label}
                className={`rounded px-1.5 py-px text-[10px] font-medium ${color.bg} ${color.text}`}
              >
                {label}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-0.5 flex items-center gap-1.5">
        {flight && (
          <span
            className="inline-flex items-center gap-1 rounded border border-accent-line bg-accent-soft px-1.5 py-px text-[10px] text-accent-green"
            title={flight.title}
          >
            <Plane size={9} />
            {shortFlightId(flight.id)}
          </span>
        )}
        <div className="flex-1" />
        <div
          className="grid h-4 w-4 place-items-center rounded-full border border-bg-border bg-bg-elevated text-[8.5px] font-semibold text-text-secondary"
          title={issue.ticketId}
        >
          {initials}
        </div>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { DollarSign, Cpu, ListChecks, ShieldAlert, Users, Clock } from "lucide-react";
import { relativeTime } from "@/lib/time";
import type { Flight } from "@/types/flight";

interface FlightStatStripProps {
  flight: Flight;
}

export function FlightStatStrip({ flight }: FlightStatStripProps) {
  const stats = useMemo(() => {
    const allTasks = flight.milestones.flatMap((m) => m.tasks);
    const done = allTasks.filter((t) => t.status === "done").length;
    const approvals = allTasks.filter((t) => t.status === "approval_needed").length;
    return {
      done,
      total: allTasks.length,
      approvals,
      sessions: flight.linkedSessionIds.length,
    };
  }, [flight]);

  return (
    <div className="flex items-stretch divide-x divide-bg-border border-b border-bg-border bg-bg-secondary text-[10px]">
      <Stat icon={<DollarSign size={11} className="text-accent-green" />} label="Cost" value={`$${flight.totalCost.toFixed(2)}`} />
      <Stat icon={<Cpu size={11} className="text-accent-blue" />} label="Tokens" value={flight.totalTokens.toLocaleString()} />
      <Stat icon={<ListChecks size={11} className="text-accent-green" />} label="Tasks" value={`${stats.done}/${stats.total}`} />
      <Stat
        icon={<ShieldAlert size={11} className={stats.approvals > 0 ? "text-accent-amber" : "text-text-muted"} />}
        label="Approvals"
        value={String(stats.approvals)}
        emphasis={stats.approvals > 0}
      />
      <Stat icon={<Users size={11} className="text-accent-blue" />} label="Sessions" value={String(stats.sessions)} />
      <Stat icon={<Clock size={11} className="text-text-muted" />} label="Updated" value={relativeTime(flight.updatedAt)} />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  emphasis = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col flex-1 gap-0.5 px-3 py-2 min-w-0">
      <div className="flex items-center gap-1 text-text-muted">
        {icon}
        <span className="uppercase tracking-wide">{label}</span>
      </div>
      <span className={`text-xs font-medium truncate ${emphasis ? "text-accent-amber" : "text-text-primary"}`}>
        {value}
      </span>
    </div>
  );
}

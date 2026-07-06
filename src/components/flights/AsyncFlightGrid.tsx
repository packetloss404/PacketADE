import { Rocket } from "lucide-react";
import { AttemptTile } from "./AttemptTile";
import type { Flight } from "@/types/flight";

interface AsyncFlightGridProps {
  flight: Flight;
  // When provided, the empty state renders a "Launch attempt" affordance
  // that opens the launch modal targeting this flight (rather than leaving
  // an attempt-less flight with no way to ever get attempts).
  onLaunch?: () => void;
}

export function AsyncFlightGrid({ flight, onLaunch }: AsyncFlightGridProps) {
  const attempts = flight.attempts ?? [];
  if (attempts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-[11px] text-text-muted py-8">
        <span>No attempts yet.</span>
        {onLaunch && (
          <button
            type="button"
            onClick={onLaunch}
            className="hover:bg-accent-green/15 flex items-center gap-1.5 rounded border border-accent-line bg-accent-soft px-3 py-1.5 text-[11px] font-medium text-accent-green transition-colors"
          >
            <Rocket size={11} />
            Launch attempt
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      {/* Prompt header */}
      {flight.prompt && (
        <div className="mb-3 px-3 py-2 bg-bg-secondary border border-bg-border rounded">
          <div className="text-[9px] uppercase tracking-wide text-text-muted mb-0.5">
            Prompt
          </div>
          <div className="text-[11px] text-text-primary whitespace-pre-wrap">
            {flight.prompt}
          </div>
        </div>
      )}

      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
        }}
      >
        {attempts.map((attempt) => (
          <AttemptTile key={attempt.id} flight={flight} attempt={attempt} />
        ))}
      </div>
    </div>
  );
}

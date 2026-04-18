import { AttemptTile } from "./AttemptTile";
import type { Flight } from "@/types/flight";

interface AsyncFlightGridProps {
  flight: Flight;
}

export function AsyncFlightGrid({ flight }: AsyncFlightGridProps) {
  const attempts = flight.attempts ?? [];
  if (attempts.length === 0) {
    return (
      <div className="flex items-center justify-center text-[11px] text-text-muted py-8">
        No attempts yet.
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

import { useEffect, useMemo, useState } from "react";
import { Radio, Plus } from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { FlightList } from "@/components/flights/FlightList";
import { FlightDetail } from "@/components/flights/FlightDetail";
import { NewFlightModal } from "@/components/flights/NewFlightModal";

export function FlightDeckView() {
  const flights = useFlightStore((s) => s.flights);
  const activeFlightId = useFlightStore((s) => s.activeFlightId);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const [showCreate, setShowCreate] = useState(false);

  // Auto-select a flight if none is active.
  const selectedId = useMemo(() => {
    if (activeFlightId && flights.some((f) => f.id === activeFlightId)) {
      return activeFlightId;
    }
    return flights[0]?.id ?? null;
  }, [flights, activeFlightId]);

  useEffect(() => {
    if (selectedId && selectedId !== activeFlightId) {
      setActiveFlight(selectedId);
    }
  }, [selectedId, activeFlightId, setActiveFlight]);

  const selectedFlight = useMemo(
    () => flights.find((f) => f.id === selectedId) ?? null,
    [flights, selectedId],
  );

  if (flights.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-text-muted bg-bg-primary">
          <Radio size={32} />
          <span className="text-sm font-medium">No flights yet</span>
          <span className="text-xs">Create a flight to start planning a mission.</span>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/10 transition-colors"
          >
            <Plus size={12} />
            New Flight
          </button>
        </div>
        {showCreate && (
          <NewFlightModal
            onCreated={(id) => setActiveFlight(id)}
            onClose={() => setShowCreate(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <FlightList selectedId={selectedId} onSelect={setActiveFlight} />
      <FlightDetail flight={selectedFlight} />
    </div>
  );
}

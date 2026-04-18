import { useEffect, useMemo, useState } from "react";
import { Radio, Sparkles, ListTree } from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { FlightList } from "@/components/flights/FlightList";
import { FlightDetail } from "@/components/flights/FlightDetail";
import { NewFlightModal } from "@/components/flights/NewFlightModal";
import { LaunchAsyncFlightModal } from "@/components/flights/LaunchAsyncFlightModal";

type ModalKind = null | "async" | "multitask";

export function MissionsView() {
  const flights = useFlightStore((s) => s.flights);
  const activeFlightId = useFlightStore((s) => s.activeFlightId);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const [modal, setModal] = useState<ModalKind>(null);

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

  const closeModal = () => setModal(null);

  if (flights.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-text-muted bg-bg-primary px-6">
          <Radio size={32} />
          <span className="text-sm font-medium text-text-primary">No flights yet</span>
          <span className="text-xs max-w-md text-center">
            A Flight launches one or more agents in parallel — each in its own
            git worktree, on local or remote SSH targets.
          </span>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => setModal("async")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/10 transition-colors"
            >
              <Sparkles size={12} />
              Launch agents
            </button>
            <button
              onClick={() => setModal("multitask")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            >
              <ListTree size={12} />
              Multi-task plan
            </button>
          </div>
        </div>
        {modal === "async" && (
          <LaunchAsyncFlightModal
            onLaunched={(id) => setActiveFlight(id)}
            onClose={closeModal}
          />
        )}
        {modal === "multitask" && (
          <NewFlightModal
            onCreated={(id) => setActiveFlight(id)}
            onClose={closeModal}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-1 overflow-hidden">
        <FlightList selectedId={selectedId} onSelect={setActiveFlight} />
        <FlightDetail flight={selectedFlight} />
      </div>
      {modal === "async" && (
        <LaunchAsyncFlightModal
          onLaunched={(id) => setActiveFlight(id)}
          onClose={closeModal}
        />
      )}
      {modal === "multitask" && (
        <NewFlightModal
          onCreated={(id) => setActiveFlight(id)}
          onClose={closeModal}
        />
      )}
    </>
  );
}


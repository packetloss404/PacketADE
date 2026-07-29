import { Check, ChevronDown, GitBranch, RefreshCw, Unlink } from "lucide-react";
import { useState } from "react";
import { useGitHubStore } from "@/stores/githubStore";
import { useIssueFlightMirrorStore } from "@/stores/issueFlightMirrorStore";
import type { Flight } from "@/types/flight";

export function IssueFlightMirrorCard({ flight }: { flight: Flight }) {
  const selectedRepo = useGitHubStore((state) => state.config.selectedRepo);
  const hostConnectionId = useGitHubStore((state) => state.activeConnectionId);
  const config = useIssueFlightMirrorStore((state) => state.mirrors[flight.id]);
  const syncing = useIssueFlightMirrorStore((state) => state.syncingFlightIds.includes(flight.id));
  const enable = useIssueFlightMirrorStore((state) => state.enable);
  const disable = useIssueFlightMirrorStore((state) => state.disable);
  const acknowledgeConflicts = useIssueFlightMirrorStore((state) => state.acknowledgeConflicts);
  const syncFlight = useIssueFlightMirrorStore((state) => state.syncFlight);
  const [showConflicts, setShowConflicts] = useState(false);
  const conflicts = Object.values(config?.records ?? {}).flatMap((record) =>
    (record.conflicts ?? []).map((conflict) => ({
      issueNumber: record.issueNumber,
      ...conflict,
    })),
  );
  const conflictCount = conflicts.length;

  function start() {
    if (!selectedRepo) return;
    enable(flight.id, { hostConnectionId, ...selectedRepo });
    queueMicrotask(() => void useIssueFlightMirrorStore.getState().syncFlight(flight.id));
  }

  return (
    <div className="rounded border border-bg-border bg-bg-secondary p-3">
      <div className="flex items-start gap-2">
        <GitBranch size={13} className="mt-0.5 text-accent-purple" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[11px] font-semibold text-text-primary">Issue ↔ Flight mirror</h3>
          <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">
            Each task becomes a host issue grouped under a milestone named for this Flight. Changes
            reconcile every 60 seconds with revision fences and visible conflicts.
          </p>
        </div>
      </div>

      {config?.enabled ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2 text-[9px] text-text-muted">
            <span className="font-mono">
              {config.owner}/{config.repo}
            </span>
            <span>{Object.keys(config.records).length} linked</span>
            {config.lastSyncAt && (
              <span>synced {new Date(config.lastSyncAt).toLocaleTimeString()}</span>
            )}
            {conflictCount > 0 && (
              <button
                type="button"
                onClick={() => setShowConflicts((value) => !value)}
                className="inline-flex items-center gap-1 text-accent-amber hover:text-text-primary"
              >
                <ChevronDown
                  size={10}
                  className={
                    showConflicts ? "rotate-180 transition-transform" : "transition-transform"
                  }
                />
                {conflictCount} conflict(s) need attention
              </button>
            )}
          </div>
          {showConflicts && conflictCount > 0 && (
            <div className="border-accent-amber/30 bg-accent-amber/5 mt-2 rounded border p-2">
              <p className="text-[9px] leading-relaxed text-text-secondary">
                The newer value already won. The losing value remains here until you acknowledge the
                reconciliation.
              </p>
              <div className="mt-1.5 space-y-1">
                {conflicts.map((conflict, index) => (
                  <div
                    key={`${conflict.issueNumber}:${conflict.field}:${index}`}
                    className="rounded bg-bg-primary px-2 py-1.5 text-[9px] text-text-muted"
                  >
                    <span className="font-medium text-text-secondary">
                      #{conflict.issueNumber} · {conflict.field} · {conflict.winner} won
                    </span>
                    <div className="mt-0.5 truncate">
                      local: {JSON.stringify(conflict.localValue)}
                    </div>
                    <div className="truncate">host: {JSON.stringify(conflict.hostValue)}</div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  acknowledgeConflicts(flight.id);
                  setShowConflicts(false);
                }}
                className="mt-2 inline-flex items-center gap-1 text-[9px] text-text-secondary hover:text-text-primary"
              >
                <Check size={10} />
                Acknowledge reconciled conflicts
              </button>
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={() => void syncFlight(flight.id)}
              disabled={syncing}
              className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
            >
              <RefreshCw size={11} className={syncing ? "animate-spin" : ""} />
              Sync now
            </button>
            <button
              onClick={() => disable(flight.id)}
              disabled={syncing}
              className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1.5 text-[10px] text-text-muted hover:bg-bg-hover"
            >
              <Unlink size={11} />
              Stop mirroring
            </button>
          </div>
          {config.error && <p className="mt-2 text-[10px] text-accent-red">{config.error}</p>}
        </>
      ) : (
        <button
          onClick={start}
          disabled={!selectedRepo}
          className="border-accent-purple/30 bg-accent-purple/10 hover:bg-accent-purple/15 mt-2 inline-flex items-center gap-1 rounded border px-2 py-1.5 text-[10px] text-accent-purple disabled:opacity-50"
        >
          <GitBranch size={11} />
          {selectedRepo
            ? `Mirror to ${selectedRepo.owner}/${selectedRepo.repo}`
            : "Select a repository in GitHub first"}
        </button>
      )}
    </div>
  );
}

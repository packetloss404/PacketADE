import { useEffect, useMemo, useState } from "react";
import { Bot, Eye, Pause, Play, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { APP_NAME_LOWER } from "@/lib/brand";
import {
  buildPacketAgentPackage,
  validatePacketAgentPackageLocally,
} from "@/lib/packetAgentPackage";
import { usePacketAgentStore } from "@/stores/packetAgentStore";
import type { Flight } from "@/types/flight";
import type { PacketAgentWorkerPackage } from "@/types/packet-agent";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventList(value: unknown): Array<Record<string, unknown>> {
  const events = object(value)?.events;
  return Array.isArray(events)
    ? events.filter((event): event is Record<string, unknown> => Boolean(object(event)))
    : [];
}

export function PacketAgentHandoffCard({ flight }: { flight: Flight }) {
  const endpoint = usePacketAgentStore((state) => state.endpoint);
  const workspaceId = usePacketAgentStore((state) => state.workspaceId);
  const projection = usePacketAgentStore((state) => state.deployments[flight.id]);
  const request = usePacketAgentStore((state) => state.request);
  const recordDeployment = usePacketAgentStore((state) => state.recordDeployment);
  const mergeProjection = usePacketAgentStore((state) => state.mergeProjection);
  const updateProjection = usePacketAgentStore((state) => state.updateProjection);
  const removeDeployment = usePacketAgentStore((state) => state.removeDeployment);
  const [workerPackage, setWorkerPackage] = useState<PacketAgentWorkerPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);

  const configured = Boolean(endpoint && workspaceId);
  const packageJson = useMemo(
    () => (workerPackage ? JSON.stringify(workerPackage, null, 2) : ""),
    [workerPackage],
  );

  useEffect(() => {
    let live = true;
    void buildPacketAgentPackage(flight).then((value) => {
      if (live) setWorkerPackage(value);
    });
    return () => {
      live = false;
    };
  }, [flight]);

  async function validate() {
    if (!workerPackage) return;
    const issues = validatePacketAgentPackageLocally(workerPackage);
    if (issues.length > 0) {
      setNotice(issues.join(" "));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await request("validate", {
        payload: {
          workerPackage,
          acceptedCapabilityIds:
            workerPackage.worker.content.policy.permissions.allowedCapabilityIds,
        },
        idempotencyKey: workerPackage.idempotencyKey,
      });
      setNotice("PacketAgent accepted the package and frozen capability set.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deploy() {
    if (!workerPackage) return;
    const issues = validatePacketAgentPackageLocally(workerPackage);
    if (issues.length > 0) {
      setNotice(issues.join(" "));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await request("validate", {
        payload: {
          workerPackage,
          acceptedCapabilityIds:
            workerPackage.worker.content.policy.permissions.allowedCapabilityIds,
        },
        idempotencyKey: workerPackage.idempotencyKey,
      });
      const deployed = await request("deploy", {
        payload: {
          workerPackage,
          acceptedCapabilityIds:
            workerPackage.worker.content.policy.permissions.allowedCapabilityIds,
        },
        idempotencyKey: workerPackage.idempotencyKey,
      });
      const saved = recordDeployment(flight.id, workerPackage, deployed);
      const activated = await request("activate", {
        deploymentId: saved.deploymentId,
        payload: {
          expectedRevision: saved.revision,
          startRun: true,
          triggerId: "manual",
          input: {},
        },
        idempotencyKey: `${workerPackage.idempotencyKey}:activate`,
      });
      mergeProjection(flight.id, activated);
      setNotice("Flight deployed to PacketAgent and started as an always-on worker.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function control(operation: "pause" | "resume" | "revoke") {
    if (!projection) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await request(operation, {
        deploymentId: projection.deploymentId,
        payload: { expectedRevision: projection.revision },
        idempotencyKey: `${APP_NAME_LOWER}:${projection.deploymentId}:${operation}:${projection.revision}`,
      });
      mergeProjection(flight.id, response);
      setNotice(`PacketAgent ${operation} request completed.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!projection) return;
    setBusy(true);
    try {
      const inspected = await request("inspect", { deploymentId: projection.deploymentId });
      mergeProjection(flight.id, inspected);
      const page = await request("events", {
        deploymentId: projection.deploymentId,
        cursor: projection.cursor,
      });
      const events = eventList(page.body);
      const latest = events[events.length - 1];
      const latestId = typeof latest?.id === "string" ? latest.id : undefined;
      const latestType = typeof latest?.type === "string" ? latest.type : undefined;
      const attentionCount = events.filter((event) =>
        String(event.type ?? "").includes("attention"),
      ).length;
      if (latestId && page.etag) {
        const acknowledged = await request("ack_events", {
          deploymentId: projection.deploymentId,
          payload: { cursor: latestId },
          idempotencyKey: `${APP_NAME_LOWER}:${projection.deploymentId}:cursor:${latestId}`,
          ifMatch: page.etag,
        });
        const cursor = object(acknowledged.body)?.cursor;
        updateProjection(flight.id, {
          cursor: latestId,
          cursorEtag: acknowledged.etag ?? object(cursor)?.etag?.toString(),
          lastEventId: latestId,
          lastEventType: latestType,
          attentionCount: projection.attentionCount + attentionCount,
          evidenceEventIds: [
            ...new Set([
              ...projection.evidenceEventIds,
              ...events
                .filter((event) => object(event.evidence)?.available === true)
                .map((event) => String(event.id)),
            ]),
          ],
        });
      }
      setNotice(
        events.length ? `Received ${events.length} ordered event(s).` : "Worker is current.",
      );
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadLatestEvidence() {
    const eventIds = projection?.evidenceEventIds ?? [];
    const eventId = eventIds[eventIds.length - 1];
    if (!eventId) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await request("evidence", { eventId });
      setEvidence(response.body);
      setNotice("Loaded the latest PacketAgent evidence envelope.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!projection || ["revoked", "retired"].includes(projection.status)) return;
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
    // Refresh deliberately tracks the durable identity/cursor, not each status update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection?.deploymentId, projection?.cursor]);

  return (
    <div className="rounded border border-bg-border bg-bg-secondary p-3">
      <div className="flex items-start gap-2">
        <Bot size={14} className="mt-0.5 text-accent-green" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] font-semibold text-text-primary">PacketAgent</h3>
            {projection && (
              <span className="bg-accent-green/10 rounded px-1.5 py-0.5 text-[9px] uppercase text-accent-green">
                {projection.status}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">
            Hand this Flight to the separate always-on worker runtime using its frozen W9 package
            and trust contract.
          </p>
        </div>
      </div>

      {!configured && (
        <p className="border-accent-amber/30 bg-accent-amber/10 mt-2 rounded border px-2 py-1.5 text-[10px] text-accent-amber">
          Configure the PacketAgent endpoint, workspace, and token in Settings first.
        </p>
      )}

      {workerPackage && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-text-muted">
          <span>v{workerPackage.packageVersion}</span>
          <span>{workerPackage.integrity.digest.slice(0, 20)}…</span>
          <button
            type="button"
            onClick={() => setShowPreview((value) => !value)}
            className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
          >
            <Eye size={10} />
            {showPreview ? "Hide package" : "Preview package"}
          </button>
        </div>
      )}
      {showPreview && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-bg-primary p-2 text-[9px] leading-relaxed text-text-secondary">
          {packageJson}
        </pre>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {!projection ? (
          <>
            <button
              onClick={() => void validate()}
              disabled={busy || !configured || !workerPackage}
              className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
            >
              <ShieldCheck size={11} />
              Validate
            </button>
            <button
              onClick={() => void deploy()}
              disabled={busy || !configured || !workerPackage}
              className="inline-flex items-center gap-1 rounded bg-accent-green px-2 py-1.5 text-[10px] font-medium text-bg-primary disabled:opacity-50"
            >
              <Play size={11} />
              Deploy &amp; keep running
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void refresh()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
            >
              <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
              Refresh
            </button>
            {projection.status === "paused" ? (
              <button
                onClick={() => void control("resume")}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover"
              >
                <Play size={11} />
                Resume
              </button>
            ) : (
              <button
                onClick={() => void control("pause")}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover"
              >
                <Pause size={11} />
                Pause
              </button>
            )}
            <button
              onClick={() => void control("revoke")}
              disabled={busy}
              className="border-accent-red/30 hover:bg-accent-red/10 inline-flex items-center gap-1 rounded border px-2 py-1.5 text-[10px] text-accent-red"
            >
              <Trash2 size={11} />
              Revoke
            </button>
          </>
        )}
      </div>

      {projection && (
        <div className="mt-2 grid grid-cols-2 gap-1 text-[9px] text-text-muted">
          <span className="truncate font-mono" title={projection.deploymentId}>
            {projection.deploymentId}
          </span>
          <span className="text-right">revision {projection.revision}</span>
          {projection.lastEventType && (
            <span className="col-span-2">{projection.lastEventType}</span>
          )}
          {projection.attentionCount > 0 && (
            <span className="col-span-2 text-accent-amber">
              {projection.attentionCount} attention event(s)
            </span>
          )}
          {["revoked", "retired"].includes(projection.status) && (
            <button
              onClick={() => removeDeployment(flight.id)}
              className="col-span-2 text-left text-text-secondary hover:text-text-primary"
            >
              Clear local reference
            </button>
          )}
          {projection.evidenceEventIds.length > 0 && (
            <button
              type="button"
              onClick={() => void loadLatestEvidence()}
              disabled={busy}
              className="col-span-2 text-left text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              Inspect latest evidence
            </button>
          )}
        </div>
      )}
      {evidence && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-bg-primary p-2 text-[9px] leading-relaxed text-text-secondary">
          {JSON.stringify(evidence, null, 2)}
        </pre>
      )}
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-text-secondary">{notice}</p>}
    </div>
  );
}

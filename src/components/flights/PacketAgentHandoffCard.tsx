import { useEffect, useMemo, useState } from "react";
import { Bot, Eye, Pause, Play, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { APP_NAME_LOWER } from "@/lib/brand";
import {
  buildPacketAgentEvidenceLanding,
  packetAgentTerminalVerdict,
  parsePacketAgentEvidence,
  type PacketAgentEvidenceParseResult,
} from "@/lib/packetAgentEvidence";
import { resolvePackageGitContext } from "@/lib/packetAgentGit";
import {
  buildWorkerPackage,
  validatePacketAgentPackageLocally,
  type PackageSource,
} from "@/lib/packetAgentPackage";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { postCoordinationMessage } from "@/stores/coordinationInboxStore";
import { usePacketAgentStore } from "@/stores/packetAgentStore";
import type { Flight } from "@/types/flight";
import type { PacketAgentWorkerPackage } from "@/types/packet-agent";

const TERMINAL_LOCAL_STATUSES = ["revoked", "retired"];

export function PacketAgentHandoffCard({ flight }: { flight: Flight }) {
  const endpoint = usePacketAgentStore((state) => state.endpoint);
  const workspaceId = usePacketAgentStore((state) => state.workspaceId);
  const projection = usePacketAgentStore((state) => state.deployments[flight.id]);
  const streamStatus = usePacketAgentStore((state) => state.streamStatus[flight.id]);
  const request = usePacketAgentStore((state) => state.request);
  const recordDeployment = usePacketAgentStore((state) => state.recordDeployment);
  const mergeProjection = usePacketAgentStore((state) => state.mergeProjection);
  const removeDeployment = usePacketAgentStore((state) => state.removeDeployment);
  const subscribe = usePacketAgentStore((state) => state.subscribe);
  const unsubscribe = usePacketAgentStore((state) => state.unsubscribe);
  const pollEventsOnce = usePacketAgentStore((state) => state.pollEventsOnce);
  const attention = usePacketAgentStore((state) => state.attention[flight.id]);
  const fetchAttention = usePacketAgentStore((state) => state.fetchAttention);
  const respondAttention = usePacketAgentStore((state) => state.respondAttention);
  const [workerPackage, setWorkerPackage] = useState<PacketAgentWorkerPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [evidenceView, setEvidenceView] = useState<{
    eventId: string;
    result: PacketAgentEvidenceParseResult;
  } | null>(null);
  // PH3: which source this card packages — the whole Flight (default), one
  // worktree attempt ("attempt:<id>"), or the planning conversation.
  const [sourceKey, setSourceKey] = useState("flight");
  const [buildError, setBuildError] = useState<string | null>(null);
  const planningConversation = useAgentTaskStore((state) =>
    flight.planningConversationId
      ? state.conversations.find(
          (conversation) => conversation.id === flight.planningConversationId,
        )
      : undefined,
  );

  const configured = Boolean(endpoint && workspaceId);
  const openAttention = attention ?? [];
  // PH8: terminal-state verdict — "completed without evidence" is a warning,
  // never a success.
  const verdict = projection ? packetAgentTerminalVerdict(projection) : undefined;
  const verdictClass =
    verdict?.tone === "success"
      ? "bg-accent-green/10 text-accent-green"
      : verdict?.tone === "warning"
        ? "bg-accent-amber/10 text-accent-amber"
        : "bg-accent-red/10 text-accent-red";
  const attempts = flight.attempts ?? [];
  const hasSourceChoices = attempts.length > 0 || Boolean(planningConversation);
  const packageJson = useMemo(
    () => (workerPackage ? JSON.stringify(workerPackage, null, 2) : ""),
    [workerPackage],
  );

  useEffect(() => {
    let live = true;
    async function build() {
      let source: PackageSource | null = null;
      if (sourceKey === "flight") {
        source = { kind: "flight", flight };
      } else if (sourceKey.startsWith("attempt:")) {
        const attempt = (flight.attempts ?? []).find(
          (candidate) => candidate.id === sourceKey.slice("attempt:".length),
        );
        if (attempt) source = { kind: "attempt", flight, attempt };
      } else if (sourceKey === "conversation" && planningConversation) {
        source = { kind: "conversation", conversation: planningConversation };
      }
      if (!source) {
        if (live) {
          setWorkerPackage(null);
          setBuildError("The selected handoff source no longer exists.");
        }
        return;
      }
      try {
        // The flight kind stays enrichment-free so its package (and digest)
        // is byte-identical to what pre-PH3 builds produced for the same
        // Flight; attempt/conversation kinds get origin-URL/branch context.
        const git =
          source.kind === "flight" ? undefined : await resolvePackageGitContext(source);
        const built = await buildWorkerPackage(source, git);
        if (live) {
          setWorkerPackage(built);
          setBuildError(null);
        }
      } catch (error) {
        if (live) {
          setWorkerPackage(null);
          setBuildError(String(error instanceof Error ? error.message : error));
        }
      }
    }
    void build();
    return () => {
      live = false;
    };
  }, [flight, sourceKey, planningConversation]);

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

  /** Manual sync — one multi-page poll pass through the store. The live SSE
   * subscription (below) is the steady-state event source. */
  async function syncNow() {
    if (!projection) return;
    setBusy(true);
    try {
      const applied = await pollEventsOnce(flight.id);
      setNotice(applied ? `Received ${applied} ordered event(s).` : "Worker is current.");
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
      setEvidenceView({ eventId, result: parsePacketAgentEvidence(response.body) });
      setNotice("Loaded the latest PacketAgent evidence envelope.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** PH8: explicit landing — record evidence/artifact REFERENCES in the
   * flight's coordination inbox with provenance. Never fetches content and
   * never checks anything out. */
  async function landEvidence() {
    if (!evidenceView || !projection) return;
    setBusy(true);
    setNotice(null);
    try {
      await postCoordinationMessage(
        buildPacketAgentEvidenceLanding({
          flightId: flight.id,
          deploymentId: projection.deploymentId,
          eventId: evidenceView.eventId,
          result: evidenceView.result,
        }),
      );
      setNotice("Evidence references landed in the coordination inbox.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  // PH6: live SSE subscription owned by the store. The card only mounts and
  // unmounts it; projection updates and acks happen inside the store.
  const deploymentId = projection?.deploymentId;
  const terminal = projection ? TERMINAL_LOCAL_STATUSES.includes(projection.status) : false;
  useEffect(() => {
    if (!deploymentId || terminal) return;
    void subscribe(flight.id);
    // PH7: seed the open-attention list; stream events keep it fresh after.
    void fetchAttention(flight.id).catch(() => undefined);
    return () => {
      void unsubscribe(flight.id);
    };
  }, [deploymentId, terminal, flight.id, subscribe, unsubscribe, fetchAttention]);

  async function respond(attentionId: string, decision: Parameters<typeof respondAttention>[2]) {
    setBusy(true);
    setNotice(null);
    try {
      await respondAttention(flight.id, attentionId, decision);
      setNotice(`Attention request ${decision.replaceAll("_", " ")} sent.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-bg-border bg-bg-secondary p-3">
      <div className="flex items-start gap-2">
        <Bot size={14} className="mt-0.5 text-accent-green" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] font-semibold text-text-primary">PacketAgent</h3>
            {projection &&
              (verdict ? (
                <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${verdictClass}`}>
                  {verdict.label}
                </span>
              ) : (
                <span className="bg-accent-green/10 rounded px-1.5 py-0.5 text-[9px] uppercase text-accent-green">
                  {projection.status}
                </span>
              ))}
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

      {hasSourceChoices && !projection && (
        <label className="mt-2 flex items-center gap-1.5 text-[10px] text-text-secondary">
          <span className="shrink-0 text-text-muted">Source</span>
          <select
            value={sourceKey}
            onChange={(event) => setSourceKey(event.target.value)}
            className="min-w-0 flex-1 rounded border border-bg-border bg-bg-primary px-1.5 py-1 text-[10px] text-text-primary outline-none focus:border-accent-green"
          >
            <option value="flight">Whole Flight</option>
            {attempts.map((attempt) => (
              <option key={attempt.id} value={`attempt:${attempt.id}`}>
                Attempt · {attempt.branch}
              </option>
            ))}
            {planningConversation && (
              <option value="conversation">
                Planning conversation · {planningConversation.title || planningConversation.id}
              </option>
            )}
          </select>
        </label>
      )}

      {buildError && (
        <p className="border-accent-red/30 bg-accent-red/10 mt-2 rounded border px-2 py-1.5 text-[10px] text-accent-red">
          {buildError}
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
              onClick={() => void syncNow()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
            >
              <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
              Sync
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
          {streamStatus && streamStatus.state !== "idle" && (
            <span className="col-span-2 truncate text-text-muted" title={streamStatus.message}>
              stream: {streamStatus.state}
              {streamStatus.consecutiveFailures > 0
                ? ` (${streamStatus.consecutiveFailures} failed connect${streamStatus.consecutiveFailures === 1 ? "" : "s"})`
                : ""}
            </span>
          )}
          {projection.totalCostUsd !== undefined && (
            <span className="col-span-2">cost ${projection.totalCostUsd.toFixed(2)}</span>
          )}
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
      {projection && openAttention.length > 0 && (
        <div className="border-accent-amber/30 bg-accent-amber/10 mt-2 space-y-2 rounded border px-2 py-2">
          <div className="text-[10px] font-semibold text-accent-amber">
            {openAttention.length} approval{openAttention.length === 1 ? "" : "s"} requested
          </div>
          {openAttention.map((request) => (
            <div key={request.id} className="rounded bg-bg-primary px-2 py-1.5">
              {request.operation && (
                <div className="font-mono text-[9px] text-text-primary">
                  {[request.operation.tool, request.operation.verb, request.operation.effect]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
              {request.operation?.resources && request.operation.resources.length > 0 && (
                <div
                  className="truncate font-mono text-[9px] text-text-muted"
                  title={request.operation.resources.join(", ")}
                >
                  {request.operation.resources.join(", ")}
                </div>
              )}
              {request.summary && (
                <div className="mt-0.5 text-[9px] leading-relaxed text-text-secondary">
                  {request.summary}
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  onClick={() => void respond(request.id, "approve_once")}
                  disabled={busy}
                  className="rounded bg-accent-green px-2 py-1 text-[9px] font-medium text-bg-primary disabled:opacity-50"
                >
                  Approve once
                </button>
                <button
                  onClick={() => void respond(request.id, "approve_for_run")}
                  disabled={busy}
                  className="rounded border border-bg-border px-2 py-1 text-[9px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
                >
                  Approve for run
                </button>
                <button
                  onClick={() => void respond(request.id, "reject")}
                  disabled={busy}
                  className="border-accent-red/30 hover:bg-accent-red/10 rounded border px-2 py-1 text-[9px] text-accent-red disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {evidenceView && (
        <div className="mt-2 space-y-1.5 rounded bg-bg-primary p-2">
          {evidenceView.result.codes.length > 0 && (
            <div className="font-mono text-[9px] text-accent-amber">
              {evidenceView.result.codes.join(" · ")}
            </div>
          )}
          {evidenceView.result.integrityErrors.length > 0 && (
            <div className="text-[9px] leading-relaxed text-accent-red">
              {evidenceView.result.integrityErrors.join(" ")}
            </div>
          )}
          {evidenceView.result.evidence.length === 0 &&
            evidenceView.result.codes.length === 0 && (
              <div className="text-[9px] text-text-muted">
                No evidence entries in this envelope.
              </div>
            )}
          {evidenceView.result.evidence.map((entry) => (
            <div key={entry.id} className="border-b border-bg-border pb-1.5 last:border-b-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span className="rounded bg-bg-secondary px-1 py-0.5 font-mono text-[8px] uppercase text-text-muted">
                  {entry.classification}
                </span>
                <span className="font-mono text-[8px] text-text-muted">#{entry.sequence}</span>
              </div>
              <div className="mt-0.5 text-[9px] leading-relaxed text-text-secondary">
                {entry.summary || "(no summary)"}
              </div>
              <div className="truncate font-mono text-[8px] text-text-muted" title={entry.evidenceDigest}>
                {entry.evidenceDigest}
              </div>
            </div>
          ))}
          {evidenceView.result.artifacts.map((artifact) => (
            <div key={artifact.reference} className="text-[9px] text-text-secondary">
              <span className="text-text-muted">artifact · </span>
              <span className="font-mono" title={artifact.contentDigest}>
                {artifact.name ?? artifact.reference}
              </span>
              <span className="text-text-muted">
                {" "}
                ({artifact.mediaType}, {artifact.byteLength} bytes)
              </span>
            </div>
          ))}
          <button
            type="button"
            onClick={() => void landEvidence()}
            disabled={busy}
            className="mt-1 rounded border border-bg-border px-2 py-1 text-[9px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            Land references into coordination inbox
          </button>
        </div>
      )}
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-text-secondary">{notice}</p>}
    </div>
  );
}

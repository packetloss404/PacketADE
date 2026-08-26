import { useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { APP_NAME } from "@/lib/brand";
import { resolvePackageGitContext } from "@/lib/packetAgentGit";
import {
  buildWorkerPackage,
  validatePacketAgentPackageLocally,
} from "@/lib/packetAgentPackage";
import { usePacketAgentStore } from "@/stores/packetAgentStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { PacketAgentWorkerPackage } from "@/types/packet-agent";

interface PacketAgentDeployModalProps {
  conversation: AgentConversation;
  onClose: () => void;
  onFeedback: (message: string) => void;
}

/**
 * PH3: conversation-tile entry point for the PacketAgent handoff. Packages
 * THIS conversation (kind: "conversation") and reuses the same
 * validate → deploy → activate sequence as the Flight card. The resulting
 * deployment projection is keyed by the conversation id.
 */
export function PacketAgentDeployModal({
  conversation,
  onClose,
  onFeedback,
}: PacketAgentDeployModalProps) {
  const endpoint = usePacketAgentStore((state) => state.endpoint);
  const workspaceId = usePacketAgentStore((state) => state.workspaceId);
  const request = usePacketAgentStore((state) => state.request);
  const recordDeployment = usePacketAgentStore((state) => state.recordDeployment);
  const mergeProjection = usePacketAgentStore((state) => state.mergeProjection);
  const existing = usePacketAgentStore((state) => state.deployments[conversation.id]);
  const [workerPackage, setWorkerPackage] = useState<PacketAgentWorkerPackage | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = Boolean(endpoint && workspaceId);
  const issues = useMemo(
    () => (workerPackage ? validatePacketAgentPackageLocally(workerPackage) : []),
    [workerPackage],
  );

  useEffect(() => {
    let live = true;
    async function build() {
      try {
        const source = { kind: "conversation", conversation } as const;
        const git = await resolvePackageGitContext(source);
        const built = await buildWorkerPackage(source, git);
        if (live) {
          setWorkerPackage(built);
          setBuildError(null);
        }
      } catch (cause) {
        if (live) {
          setWorkerPackage(null);
          setBuildError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }
    void build();
    return () => {
      live = false;
    };
  }, [conversation]);

  async function deploy() {
    if (!workerPackage || busy) return;
    if (issues.length > 0) {
      setError(issues.join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        workerPackage,
        acceptedCapabilityIds:
          workerPackage.worker.content.policy.permissions.allowedCapabilityIds,
      };
      await request("validate", { payload, idempotencyKey: workerPackage.idempotencyKey });
      const deployed = await request("deploy", {
        payload,
        idempotencyKey: workerPackage.idempotencyKey,
      });
      const saved = recordDeployment(conversation.id, workerPackage, deployed);
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
      mergeProjection(conversation.id, activated);
      onFeedback("Conversation deployed to PacketAgent");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Deploy to PacketAgent"
      icon={<Bot size={15} className="text-accent-green" />}
      onClose={busy ? () => {} : onClose}
      closeDisabled={busy}
      closeOnEscape
      width="w-[520px]"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-bg-border px-3 py-1.5 text-ui text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void deploy()}
            disabled={busy || !configured || !workerPackage || issues.length > 0}
            className="rounded bg-accent-green px-3 py-1.5 text-ui font-medium text-bg-primary hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Deploying…" : "Deploy & keep running"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-5">
        <p className="text-ui leading-relaxed text-text-secondary">
          Hands this conversation to the separate always-on PacketAgent runtime as a bounded W9
          worker package. {APP_NAME} keeps only the deployment reference and event cursor.
        </p>

        {!configured && (
          <div className="border-accent-amber/30 bg-accent-amber/10 rounded border px-3 py-2 text-ui text-accent-amber">
            Configure the PacketAgent endpoint, workspace, and token in Settings first.
          </div>
        )}

        {existing && (
          <div className="border-accent-amber/30 bg-accent-amber/10 rounded border px-3 py-2 text-ui text-accent-amber">
            This conversation already has a deployment ({existing.deploymentId}, status{" "}
            {existing.status}). Deploying again creates a new package version.
          </div>
        )}

        {buildError && (
          <div className="border-accent-red/30 bg-accent-red/10 rounded border px-3 py-2 text-ui text-accent-red">
            {buildError}
          </div>
        )}

        {workerPackage && (
          <div className="rounded border border-bg-border bg-bg-primary px-3 py-2 font-mono text-meta text-text-muted">
            <div className="truncate" title={workerPackage.packageId}>
              {workerPackage.packageId}
            </div>
            <div className="mt-1">
              v{workerPackage.packageVersion} · {workerPackage.integrity.digest.slice(0, 20)}…
            </div>
            {workerPackage.source.repository && (
              <div className="mt-1 truncate" title={workerPackage.source.repository}>
                {workerPackage.source.repository}
                {workerPackage.source.revision ? ` @ ${workerPackage.source.revision}` : ""}
              </div>
            )}
          </div>
        )}

        {issues.length > 0 && (
          <div className="border-accent-red/30 bg-accent-red/10 rounded border px-3 py-2 text-ui text-accent-red">
            {issues.join(" ")}
          </div>
        )}

        {error && (
          <div className="border-accent-red/30 bg-accent-red/10 rounded border px-3 py-2 text-ui text-accent-red">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

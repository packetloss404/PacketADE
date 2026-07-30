import { useMemo, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import {
  buildPacketCodeHandoffPayload,
  formatPacketCodeHandoffPayload,
  getConversationProjectTarget,
  openConversationInPacketCode,
} from "@/lib/agentHandoffs";
import { useAppStore } from "@/stores/appStore";
import type { AgentConversation } from "@/types/agent-conversation";

interface PacketCodeHandoffModalProps {
  conversation: AgentConversation;
  onClose: () => void;
  onFeedback: (message: string) => void;
}

export function PacketCodeHandoffModal({
  conversation,
  onClose,
  onFeedback,
}: PacketCodeHandoffModalProps) {
  const [objective, setObjective] = useState("");
  const [referencesText, setReferencesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useMemo(
    () => getConversationProjectTarget(conversation),
    [conversation],
  );
  const references = referencesText
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  async function handleContinue() {
    if (!objective.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = buildPacketCodeHandoffPayload({
        conversation,
        objective,
        references,
      });
      await navigator.clipboard.writeText(formatPacketCodeHandoffPayload(payload));
      const result = openConversationInPacketCode(conversation.id);
      if (!result.ok) {
        if (result.code === "packetcode_unavailable" && target.kind === "local") {
          useAppStore.getState().openSettings({
            section: "cli-clients",
            cliId: "packetcode",
          });
          onFeedback("PacketCode needs setup before this handoff can continue");
          onClose();
          return;
        }
        setError(result.message);
        return;
      }
      onFeedback("Bounded handoff copied; PacketCode is ready for paste");
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The PacketCode handoff failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Continue in PacketCode"
      icon={<SquareTerminal size={15} className="text-accent-purple" />}
      onClose={busy ? () => {} : onClose}
      closeDisabled={busy}
      closeOnEscape
      width="w-[560px]"
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
            onClick={() => void handleContinue()}
            disabled={!objective.trim() || busy}
            className="rounded bg-accent-purple px-3 py-1.5 text-ui font-medium text-text-primary hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Preparing…" : "Copy payload & open PacketCode"}
          </button>
        </div>
      }
    >
      <div className="space-y-4 p-5">
        <div className="rounded border border-bg-border bg-bg-primary px-3 py-2 text-ui">
          <div className="text-text-muted">Exact execution target</div>
          <div className="mt-1 break-all font-mono text-text-primary">
            {target.projectPath}
          </div>
          <div className="mt-1 text-meta text-text-muted">
            {target.kind === "ssh"
              ? `SSH · ${target.serverName ?? target.serverId}`
              : "Local"}
            {target.worktree ? ` · ${target.worktree.branch}` : ""}
          </div>
        </div>

        <label className="block">
          <span className="text-ui font-medium text-text-primary">
            Objective for PacketCode
          </span>
          <textarea
            autoFocus
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            rows={4}
            placeholder="Describe exactly what PacketCode should continue or verify."
            className="mt-1.5 w-full resize-y rounded border border-bg-border bg-bg-primary px-3 py-2 text-ui text-text-primary outline-none placeholder:text-text-muted focus:border-accent-purple"
          />
        </label>

        <label className="block">
          <span className="text-ui font-medium text-text-primary">
            File or reference allowlist
          </span>
          <span className="ml-2 text-meta text-text-muted">
            optional · one path or reference per line
          </span>
          <textarea
            value={referencesText}
            onChange={(event) => setReferencesText(event.target.value)}
            rows={3}
            placeholder={"src/example.ts\nissue:123"}
            className="mt-1.5 w-full resize-y rounded border border-bg-border bg-bg-primary px-3 py-2 font-mono text-ui text-text-primary outline-none placeholder:text-text-muted focus:border-accent-purple"
          />
        </label>

        <div className="rounded border border-accent-line bg-accent-soft px-3 py-2 text-meta text-text-secondary">
          The handoff contains the source ID, visible title, exact target,
          objective, references, and current permission posture. It does not
          include the transcript, secrets, hidden reasoning, or transferred
          authority. PacketCode opens separately and you paste the visible
          payload yourself.
        </div>

        {error && (
          <div className="rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-ui text-accent-red">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

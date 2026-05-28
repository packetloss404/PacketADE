import { useMemo, useState } from "react";
import { GitPullRequest, Rocket, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useFlightStore } from "@/stores/flightStore";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { MultiTargetPicker, type PickedTarget } from "./MultiTargetPicker";
import { type AttemptTargetSpec } from "@/lib/tauri";
import type { FlightPriority } from "@/types/flight";

interface LaunchAsyncFlightModalProps {
  onClose: () => void;
  onLaunched?: (flightId: string) => void;
}

function pickedToSpec(p: PickedTarget): AttemptTargetSpec {
  if (p.kind === "local") {
    return {
      kind: "local",
      basePath: p.basePath,
      baseBranch: p.baseBranch,
      agentConfigId: p.agent,
      provider: p.agent.replace(/^api-/, ""),
      model: p.model,
    };
  }
  return {
    kind: "ssh",
    // Phase 2: targetId is now the ServerConfig.id (was SshTarget.id).
    // The backend agent will be updated to call the field `serverId`
    // in the same PR — until then we keep the name for wire compat.
    targetId: p.server.id,
    host: p.server.host,
    port: p.server.port,
    user: p.server.username,
    keyPath: p.server.keyPath ?? null,
    authMethod: p.server.authMethod,
    hostFingerprint: p.server.hostFingerprint ?? null,
    basePath: p.basePath,
    baseBranch: p.baseBranch,
    agentConfigId: p.agent,
    provider: p.agent.replace(/^api-/, ""),
    model: p.model,
  };
}

export function LaunchAsyncFlightModal({
  onClose,
  onLaunched,
}: LaunchAsyncFlightModalProps) {
  const addFlight = useFlightStore((s) => s.addFlight);
  const launchAsync = useAsyncFlightStore((s) => s.launchAsync);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const projectPath = useLayoutStore((s) => s.projectPath);
  // v0.8: pre-check the publish toggle if the user opted into that default
  // via Settings → GitHub.
  const defaultPublishAttemptsAsPrs = useGitHubStore(
    (s) => s.defaultPublishAttemptsAsPrs,
  );

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<PickedTarget[]>([]);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v0.8-G: per-attempt draft-PR publish toggle. When enabled, the
  // asyncFlightStore pipeline pushes each attempt's branch and opens a
  // draft GitHub PR once it reaches a terminal state.
  const [publishAsPrs, setPublishAsPrs] = useState(
    defaultPublishAttemptsAsPrs,
  );

  const promptShort = useMemo(
    () => (prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt),
    [prompt],
  );

  const canLaunch =
    prompt.trim().length > 0 && picked.length > 0 && !launching;

  async function handleLaunch() {
    if (!canLaunch) return;
    setLaunching(true);
    setError(null);
    try {
      const flight = addFlight({
        title: (title.trim() || promptShort || "Untitled flight"),
        objective: prompt.trim(),
        priority: "medium" as FlightPriority,
        projectPath: activeWorkspace?.projectPath || projectPath || "",
        workspaceId: activeWorkspace?.id ?? null,
        issueIds: [],
        publishAttemptsAsPrs: publishAsPrs,
      });

      // v0.8 race-fix: `addFlight` already carries `publishAttemptsAsPrs`
      // through to backend persistence via `saveFlightsSlice`, so a
      // separate `setFlightPublishAttemptsAsPrs` call here was both
      // redundant and racy — its `await` could resolve before the
      // fire-and-forget `syncFlightsToBackend` queued by `addFlight` had
      // written the flight, surfacing as "Flight not found" warnings that
      // were silently swallowed.

      const targets = picked.map(pickedToSpec);
      await launchAsync(flight.id, prompt.trim(), targets);

      onLaunched?.(flight.id);
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "Launch failed");
    } finally {
      setLaunching(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      void handleLaunch();
    }
  }

  const footer = (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-text-muted">
        Ctrl+Enter to launch · Each agent runs in its own git worktree
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={onClose}
          disabled={launching}
          className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleLaunch()}
          disabled={!canLaunch}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Rocket size={11} />
          Launch {picked.length || ""} {picked.length === 1 ? "agent" : "agents"}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={launching ? () => {} : onClose}
      title="Launch parallel agents"
      icon={<Sparkles size={14} className="text-accent-green" />}
      width="w-[820px] max-w-[92vw]"
      footer={footer}
    >
      <div className="px-5 py-4 flex flex-col gap-4" onKeyDown={handleKeyDown}>
        {/* Prompt */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-text-secondary">
            Prompt
          </label>
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agents work on? Each agent runs the same prompt independently."
            rows={4}
            className="w-full bg-bg-primary text-xs text-text-primary placeholder:text-text-muted px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50 resize-none"
          />
        </div>

        {/* Title (optional) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-text-secondary">
            Title <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={promptShort || "Auto-generated from prompt"}
            className="w-full bg-bg-primary text-xs text-text-primary placeholder:text-text-muted px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
          />
        </div>

        {/* Targets */}
        <MultiTargetPicker picked={picked} onChange={setPicked} />

        {/* v0.8-G: publish attempts as draft PRs */}
        <label className="flex items-start gap-2 cursor-pointer group">
          <input
            type="checkbox"
            checked={publishAsPrs}
            onChange={(e) => setPublishAsPrs(e.target.checked)}
            className="mt-0.5 accent-accent-green"
          />
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary group-hover:text-text-primary">
              <GitPullRequest size={11} className="text-accent-purple" />
              Publish attempts as draft PRs
            </span>
            <span className="text-[10px] text-text-muted leading-snug">
              After each attempt, push the branch and open a draft PR on GitHub.
              Lets you review attempts via your normal PR flow.
            </span>
          </div>
        </label>

        {error && (
          <div className="text-[11px] text-accent-red bg-accent-red/10 border border-accent-red/30 rounded px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

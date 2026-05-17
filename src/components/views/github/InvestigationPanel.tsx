import { useEffect, useState } from "react";
import {
  Brain,
  GitBranch,
  Loader2,
  Plane,
  StickyNote,
} from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useMemoryStore } from "@/stores/memoryStore";
import type { AttemptTargetSpec } from "@/lib/tauri";
import type { GitHubIssue } from "@/types/github";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { CtaFeedbackRow, type CtaFeedback } from "./CtaFeedbackRow";

interface InvestigationPanelProps {
  issue: GitHubIssue;
  investigation: string | null;
  isInvestigating: boolean;
  onRun: () => void;
}

export function InvestigationPanel({
  issue,
  investigation,
  isInvestigating,
  onRun,
}: InvestigationPanelProps) {
  // v0.8-D — wire Hand off to Claude / Draft patch / Save as memory.
  const setActiveView = useAppStore((s) => s.setActiveView);
  const layoutProjectPath = useLayoutStore((s) => s.projectPath);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addFlight = useFlightStore((s) => s.addFlight);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const launchAsync = useAsyncFlightStore((s) => s.launchAsync);
  const captureManually = useMemoryStore((s) => s.captureManually);

  const [busy, setBusy] = useState<null | "handoff" | "draft" | "memory">(null);
  const [feedback, setFeedback] = useState<CtaFeedback>(null);

  // Clear stale feedback when the underlying investigation or issue
  // changes; what was "Saved to project memory" for issue #41 is no
  // longer relevant when the user clicks over to #42.
  const issueNumber = issue.number;
  useEffect(() => {
    setFeedback(null);
    setBusy(null);
  }, [issueNumber, investigation]);

  const resolvedProjectPath =
    activeWorkspace?.projectPath || layoutProjectPath || "";

  const downstreamReady = Boolean(investigation && !isInvestigating);

  async function handleHandoffToClaude() {
    if (!investigation || busy) return;
    if (!resolvedProjectPath) {
      setFeedback({
        tone: "error",
        message: "No project path — open a workspace before handing off.",
      });
      return;
    }
    setBusy("handoff");
    setFeedback(null);
    try {
      // Create a fresh workspace seeded with claude-code and the
      // investigation as the workspace-level prompt. The pane spawns
      // when WorkspaceView renders and `useTerminalSession` writes the
      // prompt as the first input.
      const initialPrompt =
        `--- GitHub Investigation for #${issue.number} (${issue.title}) ---\n\n` +
        `${investigation}\n\n` +
        `--- end of context ---\n\n` +
        `Please continue from here.`;
      const name = `GH #${issue.number} — ${issue.title}`.slice(0, 64);
      const wsId = createWorkspace(
        name,
        ["claude-code"],
        resolvedProjectPath,
        { prompt: initialPrompt },
      );
      setActiveWorkspace(wsId);
      setActiveView("workspace");
      setFeedback({
        tone: "success",
        message: `Opened Claude with #${issue.number} context`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Hand off failed: ${msg}` });
    } finally {
      setBusy(null);
    }
  }

  async function handleDraftPatch() {
    if (!investigation || busy) return;
    if (!resolvedProjectPath) {
      setFeedback({
        tone: "error",
        message: "No active workspace — open one to draft a patch.",
      });
      return;
    }
    setBusy("draft");
    setFeedback(null);
    try {
      // Seed a single-attempt async Flight using the investigation as the
      // brief. Executor model = claude-sonnet-4-6 over the OAuth sidecar
      // (api-claude-oauth) per the v0.8-D spec.
      const brief =
        `GitHub issue #${issue.number}: ${issue.title}\n\n` +
        `Issue description:\n${issue.body?.trim() || "(no description)"}\n\n` +
        `AI Investigation:\n${investigation}\n\n` +
        `Apply the change. Keep the diff focused on what the investigation calls out.`;
      const flight = addFlight({
        title: `Fix #${issue.number}: ${issue.title}`,
        objective: brief.slice(0, 200),
        priority: "medium",
        projectPath: resolvedProjectPath,
        workspaceId: activeWorkspace?.id ?? null,
        issueIds: [],
      });
      const target: AttemptTargetSpec = {
        kind: "local",
        basePath: resolvedProjectPath,
        baseBranch: "main",
        agentConfigId: "api-claude-oauth",
        provider: "claude-oauth",
        model: "claude-sonnet-4-6",
      };
      await launchAsync(flight.id, brief, [target]);
      setActiveFlight(flight.id);
      setActiveView("missions");
      setFeedback({
        tone: "success",
        message: `Launched draft patch for #${issue.number}`,
        linkLabel: "Open",
        onLinkClick: () => setActiveView("missions"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Draft patch failed: ${msg}` });
    } finally {
      setBusy(null);
    }
  }

  function handleSaveAsMemory() {
    if (!investigation || busy) return;
    setBusy("memory");
    setFeedback(null);
    try {
      captureManually({
        projectPath: resolvedProjectPath,
        source: "github-investigation",
        summary: `Investigation for #${issue.number}: ${issue.title}`,
        body: investigation,
        tags: ["github-investigation", `gh-${issue.number}`],
      });
      setFeedback({
        tone: "success",
        message: "Saved to project memory",
        linkLabel: "View",
        onLinkClick: () => setActiveView("memory"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Save failed: ${msg}` });
    } finally {
      setBusy(null);
    }
  }

  if (!investigation && !isInvestigating) {
    return (
      <div className="bg-bg-secondary border border-accent-blue/30 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-accent-blue/10 border-b border-accent-blue/20">
          <Brain size={12} className="text-accent-blue" />
          <span className="text-[11px] font-semibold text-accent-blue">
            AI Investigation
          </span>
          <span className="text-[9.5px] text-text-muted">scout · read-only</span>
        </div>
        <div className="px-3.5 py-3 flex items-center gap-3">
          <span className="text-[11px] text-text-muted flex-1">
            Run an AI investigation to scan the codebase, surface a likely fix,
            and list files touched.
          </span>
          <button
            type="button"
            onClick={onRun}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors"
          >
            <Brain size={10} /> Run investigation
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-bg-secondary border border-accent-blue/30 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-accent-blue/10 border-b border-accent-blue/20">
        <Brain size={12} className="text-accent-blue" />
        <span className="text-[11px] font-semibold text-accent-blue">
          AI Investigation
        </span>
        <span className="text-[9.5px] text-text-muted">
          scout · read-only
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRun}
          disabled={isInvestigating}
          className="text-[9.5px] text-accent-blue hover:underline px-1.5 py-0.5 disabled:opacity-50"
        >
          {isInvestigating ? "Running..." : "Re-run"}
        </button>
      </div>

      <div className="px-3.5 py-3 text-[11px] text-text-secondary leading-relaxed">
        {isInvestigating && !investigation ? (
          <div className="flex items-center gap-2 text-text-muted py-2">
            <Loader2 size={12} className="animate-spin" />
            Analyzing codebase...
          </div>
        ) : investigation ? (
          <MarkdownRenderer
            content={investigation}
            className="text-[11px] text-text-secondary leading-relaxed"
          />
        ) : null}

        <div className="flex gap-1.5 mt-3 pt-2.5 border-t border-dashed border-bg-border flex-wrap items-center">
          {/* v0.8-D — Hand off to Claude: spawn `claude` PTY with the
              investigation piped in as the first user turn. */}
          <button
            type="button"
            onClick={() => void handleHandoffToClaude()}
            disabled={!downstreamReady || busy === "handoff"}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-soft text-accent-green border border-accent-line rounded hover:bg-accent-green/15 transition-colors disabled:opacity-50"
          >
            {busy === "handoff" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Plane size={10} />
            )}{" "}
            Hand off to Claude
          </button>
          {/* v0.8-D — Draft patch: single-attempt async flight using the
              OAuth Claude sidecar (claude-sonnet-4-6) as executor. */}
          <button
            type="button"
            onClick={() => void handleDraftPatch()}
            disabled={!downstreamReady || busy === "draft"}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-bg-tertiary text-text-primary border border-bg-border rounded hover:bg-bg-elevated transition-colors disabled:opacity-50"
          >
            {busy === "draft" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <GitBranch size={10} />
            )}{" "}
            Draft patch
          </button>
          {/* v0.8-D — Save as memory: write the investigation as a manual
              MemoryEvent so it's available to future sessions. */}
          <button
            type="button"
            onClick={handleSaveAsMemory}
            disabled={!downstreamReady || busy === "memory"}
            className="inline-flex items-center gap-1.5 text-[10.5px] text-text-secondary hover:text-text-primary px-2 py-1 disabled:opacity-50"
          >
            {busy === "memory" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <StickyNote size={10} />
            )}{" "}
            Save as memory
          </button>
        </div>

        {feedback && (
          <div className="mt-2">
            <CtaFeedbackRow
              feedback={feedback}
              onDismiss={() => setFeedback(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

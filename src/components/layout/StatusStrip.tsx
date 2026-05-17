import { GitBranch, FolderGit2, Mic, Loader2 } from "lucide-react";
import { useGitInfo } from "@/hooks/useGitInfo";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore, type AppView } from "@/stores/appStore";
import { useDictationStore } from "@/stores/dictationStore";
import { useSidecarStatus } from "@/hooks/useSidecarStatus";
import type { SidecarStatus } from "@/lib/tauri";

const VIEW_LABELS: Partial<Record<AppView, string>> = {
  agents: "Agents",
  workspace: "Workspace",
  missions: "Flight Deck",
  issues: "Issues",
  github: "GitHub",
  memory: "Memory",
  history: "History",
  tools: "Tools",
  deploy: "Deploy",
  review_queue: "Review",
  cost_dashboard: "Costs",
  dictation: "Dictation",
  welcome: "Welcome",
};

function StatField({ label, value, mono, accent }: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "green" | "blue" | "amber" | "purple";
}) {
  const valueClass = accent
    ? `text-accent-${accent}`
    : "text-text-secondary";
  return (
    <span className="flex items-center gap-1.5 text-[10.5px]">
      <span className="text-text-faint">{label}</span>
      <span className={`${valueClass} ${mono ? "font-mono" : ""}`}>{value}</span>
    </span>
  );
}

/**
 * Persistent 7-px status dot that reflects the agent-sidecar's health.
 *
 *   - `ready`      → muted green (lightly toned so it doesn't compete with
 *                    other accents in the strip)
 *   - `restarting` → amber
 *   - `down`       → red with a slow pulse to draw the eye to a real fault
 *
 * Hidden when the supervisor hasn't started yet (`not_started`) or the
 * Tauri command hasn't returned (`null`). Tooltip mirrors the toolbar
 * chip's: a short status line + last_error when present.
 */
function SidecarStatusDot({ status }: { status: SidecarStatus | null }) {
  if (!status || status.state === "not_started") return null;

  // `ready` is lightly muted via opacity so the dot reads as ambient
  // rather than competing with the other accent-green chips in the bar.
  let dotClass = "bg-accent-green opacity-70";
  let pulse = false;
  let tooltip = "Sidecar ready";

  if (status.state === "ready") {
    dotClass = "bg-accent-green opacity-70";
    const detail = [
      status.version ? `v${status.version}` : null,
      status.pid != null ? `pid ${status.pid}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    tooltip = detail ? `Sidecar ready · ${detail}` : "Sidecar ready";
  } else if (status.state === "restarting") {
    dotClass = "bg-accent-amber";
    tooltip = `Sidecar restarting (${status.restart_count}/3)${
      status.last_error ? ` — ${status.last_error}` : ""
    }`;
  } else if (status.state === "down") {
    dotClass = "bg-accent-red";
    pulse = true;
    tooltip = `Sidecar down${status.last_error ? ` — ${status.last_error}` : ""}`;
  }

  return (
    <span
      className="flex items-center"
      title={tooltip}
      aria-label={tooltip}
      role="status"
    >
      <span
        className={`w-[7px] h-[7px] rounded-full ${dotClass} ${
          pulse ? "animate-pulse" : ""
        }`}
        aria-hidden
      />
    </span>
  );
}

export function StatusStrip() {
  const gitBranch = useGitInfo();
  const projectPath = useLayoutStore((s) => s.projectPath);
  const activeView = useAppStore((s) => s.activeView);
  const dictationStatus = useDictationStore((s) => s.status);
  const isRecording = useDictationStore((s) => s.isRecording);
  const isTranscribing = useDictationStore((s) => s.isTranscribing);
  const sidecar = useSidecarStatus();

  const projectName = projectPath ? (projectPath.split(/[/\\]/).pop() ?? null) : null;
  const viewLabel = VIEW_LABELS[activeView] ?? null;

  return (
    <div className="flex items-center h-[26px] px-3 gap-3.5 bg-bg-secondary border-t border-bg-border flex-shrink-0 select-none">
      <SidecarStatusDot status={sidecar} />
      {projectName && (
        <span className="flex items-center gap-1.5 text-[10.5px]">
          <FolderGit2 size={10} className="text-text-faint" />
          <span className="text-text-secondary font-mono">{projectName}</span>
        </span>
      )}

      {gitBranch && (
        <span className="flex items-center gap-1.5 text-[10.5px]">
          <GitBranch size={10} className="text-text-faint" />
          <span className="text-accent-blue font-mono">{gitBranch}</span>
        </span>
      )}

      {viewLabel && <StatField label="View" value={viewLabel} accent="green" />}

      <span className="flex-1" />

      {isRecording && (
        <span
          className="flex items-center gap-1.5 text-[10.5px] text-accent-red"
          title="Dictation recording — release Ctrl+Shift+V or press Escape to stop"
        >
          <Mic size={10} className="animate-pulse" />
          <span className="font-mono">REC</span>
        </span>
      )}
      {isTranscribing && !isRecording && (
        <span
          className="flex items-center gap-1.5 text-[10.5px] text-accent-amber"
          title="Transcribing dictation"
        >
          <Loader2 size={10} className="animate-spin" />
          <span className="font-mono">Transcribing…</span>
        </span>
      )}
      {dictationStatus === "error" && !isRecording && !isTranscribing && (
        <span className="flex items-center gap-1.5 text-[10.5px] text-accent-red" title="Last dictation failed">
          <Mic size={10} />
          <span className="font-mono">Err</span>
        </span>
      )}

      <span className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
        PacketADE
      </span>
    </div>
  );
}

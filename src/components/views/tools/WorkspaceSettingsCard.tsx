import { Terminal } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export function WorkspaceSettingsCard() {
  const keepTerminalsAlive = useWorkspaceStore((s) => s.keepTerminalsAlive);
  const setKeepTerminalsAlive = useWorkspaceStore((s) => s.setKeepTerminalsAlive);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Terminal size={12} className="text-accent-purple" />
        Workspace Pane
      </h3>

      <p className="mb-3 text-[10px] text-text-muted leading-snug">
        Controls for the separate Workspace pane. These do not change how the Agents pane
        groups or resumes conversations.
      </p>

      <div className="flex items-center justify-between gap-4 bg-bg-primary border border-bg-border rounded-lg px-3 py-2">
        <div className="min-w-0">
          <div className="text-[11px] text-text-secondary">Keep terminals alive</div>
          <p className="mt-1 text-[10px] text-text-muted leading-snug">
            Keep Workspace pane terminal sessions running when switching away from that pane.
          </p>
        </div>
        <Toggle checked={keepTerminalsAlive} onChange={setKeepTerminalsAlive} />
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 flex-shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent-green" : "bg-bg-elevated"
      }`}
      aria-pressed={checked}
      title={checked ? "Disable keep-alive" : "Enable keep-alive"}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

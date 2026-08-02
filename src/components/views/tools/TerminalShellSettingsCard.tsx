import { useMemo, useState } from "react";
import { ExternalLink, RefreshCw, TerminalSquare } from "lucide-react";
import { useTerminalShellDetection } from "@/hooks/useTerminalShellDetection";
import {
  formatTerminalShellArgs,
  isSupportedCustomShell,
  parseTerminalShellArgs,
  resolveTerminalShellLaunch,
  selectionForProfile,
  shellProfileLabel,
  shellProfilesForPlatform,
  terminalPlatform,
} from "@/lib/terminalShells";
import { probeTerminalShell } from "@/lib/tauri";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type {
  DetectedTerminalShell,
  TerminalShellProbe,
  TerminalShellProfileId,
  TerminalShellSelection,
} from "@/types/terminal-shell";

const INSTALL_LINKS: Partial<Record<TerminalShellProfileId, { label: string; url: string }>> = {
  powershell7: {
    label: "Install PowerShell 7",
    url: "https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows",
  },
  "git-bash": { label: "Install Git for Windows", url: "https://git-scm.com/download/win" },
  wsl: { label: "Install WSL", url: "https://learn.microsoft.com/windows/wsl/install" },
};

export function TerminalShellSettingsCard() {
  const platform = terminalPlatform();
  const profiles = shellProfilesForPlatform(platform);
  const defaultShell = useTerminalSettingsStore((state) => state.defaultShell);
  const setDefaultShell = useTerminalSettingsStore((state) => state.setDefaultShell);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === state.activeWorkspaceId),
  );
  const setWorkspaceShell = useWorkspaceStore((state) => state.setTerminalShellOverride);
  const projectPath = workspace && !workspace.serverId ? workspace.projectPath : "";
  const detection = useTerminalShellDetection();

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <TerminalSquare size={12} className="text-accent-green" />
          Local terminal shell
        </h3>
        <button
          type="button"
          onClick={() => void detection.refresh()}
          disabled={detection.loading}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={10} className={detection.loading ? "animate-spin" : ""} />
          Detect
        </button>
      </div>
      <p className="mb-3 text-[10px] leading-snug text-text-muted">
        Chooses the shell for new or restarted local Terminal panes. Auto preserves the existing
        behavior: PowerShell on Windows and Bash on macOS/Linux. Coding CLIs launch normally, and
        SSH uses the remote host&apos;s login shell.
      </p>

      <div className="space-y-3">
        <ShellChoiceEditor
          label="App default"
          selection={defaultShell}
          profiles={profiles}
          shells={detection.shells}
          wslDistributions={detection.wslDistributions}
          projectPath={projectPath}
          onChange={(selection) => {
            if (selection) setDefaultShell(selection);
          }}
        />

        <ShellChoiceEditor
          label={workspace ? `Workspace override · ${workspace.name}` : "Workspace override"}
          selection={workspace?.terminalShell}
          profiles={profiles}
          shells={detection.shells}
          wslDistributions={detection.wslDistributions}
          projectPath={projectPath}
          inheritLabel="Use app default"
          disabled={!workspace || !!workspace.serverId}
          onChange={(selection) => {
            if (activeWorkspaceId) setWorkspaceShell(activeWorkspaceId, selection);
          }}
        />
      </div>

      {detection.error && (
        <p className="mt-3 text-[10px] text-accent-red">Detection failed: {detection.error}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-bg-border pt-3">
        {profiles
          .filter((profile) => profile !== "auto" && profile !== "custom")
          .map((profile) => {
            const result = detection.shells[profile];
            const ready = result?.available ?? false;
            const install = INSTALL_LINKS[profile];
            return (
              <span
                key={profile}
                className="inline-flex items-center gap-1 text-[9px] text-text-muted"
              >
                <span className={ready ? "text-accent-green" : "text-text-faint"}>
                  {ready ? "●" : "○"}
                </span>
                {shellProfileLabel(profile)}
                {!ready && install && (
                  <a
                    href={install.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-accent-amber hover:underline"
                  >
                    {install.label}
                    <ExternalLink size={8} />
                  </a>
                )}
              </span>
            );
          })}
      </div>
    </div>
  );
}

interface ShellChoiceEditorProps {
  label: string;
  selection: TerminalShellSelection | undefined;
  profiles: TerminalShellProfileId[];
  shells: Partial<Record<TerminalShellProfileId, DetectedTerminalShell>>;
  wslDistributions: string[];
  projectPath: string;
  inheritLabel?: string;
  disabled?: boolean;
  onChange: (selection: TerminalShellSelection | undefined) => void;
}

function ShellChoiceEditor({
  label,
  selection,
  profiles,
  shells,
  wslDistributions,
  projectPath,
  inheritLabel,
  disabled = false,
  onChange,
}: ShellChoiceEditorProps) {
  const [probe, setProbe] = useState<TerminalShellProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const value = selection?.profile ?? (inheritLabel ? "inherit" : "auto");
  const autoCommand = terminalPlatform() === "windows" ? "powershell" : "bash";
  const launch = useMemo(
    () => resolveTerminalShellLaunch(selection, autoCommand),
    [autoCommand, selection],
  );
  const customValid =
    selection?.profile !== "custom" ||
    (!!selection.executable && isSupportedCustomShell(selection.executable));

  const chooseProfile = (raw: string) => {
    setProbe(null);
    setProbeError(null);
    if (raw === "inherit") {
      onChange(undefined);
      return;
    }
    const profile = raw as TerminalShellProfileId;
    const next = selectionForProfile(profile, shells[profile]);
    if (profile === "wsl" && wslDistributions[0]) next.wslDistro = wslDistributions[0];
    onChange(next);
  };

  const runProbe = async () => {
    if (!customValid) return;
    setProbing(true);
    setProbe(null);
    setProbeError(null);
    try {
      setProbe(await probeTerminalShell(launch.command, projectPath));
    } catch (cause) {
      setProbeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="rounded-lg border border-bg-border bg-bg-primary px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[210px] flex-1">
          <span className="mb-1 block text-[10px] font-medium text-text-secondary">{label}</span>
          <select
            value={value}
            disabled={disabled}
            onChange={(event) => chooseProfile(event.target.value)}
            className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary focus:border-accent-green focus:outline-none disabled:opacity-50"
          >
            {inheritLabel && <option value="inherit">{inheritLabel}</option>}
            {profiles.map((profile) => {
              const detected = shells[profile];
              const unavailable =
                profile !== "auto" && profile !== "custom" && detected?.available === false;
              return (
                <option key={profile} value={profile} disabled={unavailable}>
                  {shellProfileLabel(profile)}
                  {unavailable ? " · not found" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void runProbe()}
          disabled={disabled || value === "inherit" || probing || !customValid}
          className="rounded border border-bg-border px-2.5 py-1.5 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
        >
          {probing ? "Testing…" : "Test shell"}
        </button>
      </div>

      {selection?.profile === "wsl" && (
        <label className="mt-2 block">
          <span className="mb-1 block text-[10px] text-text-muted">WSL distribution</span>
          <select
            value={selection.wslDistro ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...selection, wslDistro: event.target.value || undefined })
            }
            className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary focus:border-accent-green focus:outline-none disabled:opacity-50"
          >
            <option value="">Default WSL distribution</option>
            {wslDistributions.map((distro) => (
              <option key={distro} value={distro}>
                {distro}
              </option>
            ))}
          </select>
        </label>
      )}

      {selection?.profile === "custom" && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <label>
            <span className="mb-1 block text-[10px] text-text-muted">Shell executable</span>
            <input
              type="text"
              value={selection.executable ?? ""}
              disabled={disabled}
              onChange={(event) => onChange({ ...selection, executable: event.target.value })}
              placeholder="C:\\Tools\\shell\\pwsh.exe"
              className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 font-mono text-[10px] text-text-primary focus:border-accent-green focus:outline-none disabled:opacity-50"
            />
          </label>
          <label>
            <span className="mb-1 block text-[10px] text-text-muted">Startup arguments</span>
            <input
              key={`${selection.profile}:${selection.executable ?? ""}`}
              type="text"
              defaultValue={formatTerminalShellArgs(selection.args)}
              disabled={disabled}
              onBlur={(event) =>
                onChange({ ...selection, args: parseTerminalShellArgs(event.target.value) })
              }
              placeholder="--login -i"
              className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 font-mono text-[10px] text-text-primary focus:border-accent-green focus:outline-none disabled:opacity-50"
            />
          </label>
          {!customValid && (
            <p className="text-[9px] text-accent-amber md:col-span-2">
              Choose a supported shell executable such as pwsh, powershell, cmd, bash, zsh, fish,
              nu, or xonsh. Auto remains the effective launch until this is valid.
            </p>
          )}
        </div>
      )}

      {disabled && (
        <p className="mt-2 text-[9px] text-text-muted">
          Select an active local workspace to set an override. Remote workspaces use the host&apos;s
          login shell.
        </p>
      )}
      {probe && (
        <p className="mt-2 break-all text-[9px] leading-relaxed text-accent-green">
          Ready · {probe.executable}
          {probe.version ? ` · ${probe.version}` : ""} · {probe.platform} · cwd{" "}
          {probe.workingDirectory || "app scratch"}
        </p>
      )}
      {probeError && <p className="mt-2 text-[9px] text-accent-red">{probeError}</p>}
    </div>
  );
}

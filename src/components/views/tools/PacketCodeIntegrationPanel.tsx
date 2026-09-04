import { useMemo, useState } from "react";
import { CheckCircle2, FolderOpen, Loader2, Play, RefreshCw, XCircle } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  probePacketCodeIntegration,
  type DetectCatalogResult,
  type PacketCodeInstallationInspection,
  type PacketCodeIntegrationProbe,
} from "@/lib/tauri";
import {
  isAbsolutePacketCodePath,
  usePacketCodeIntegrationStore,
} from "@/stores/packetCodeIntegrationStore";
import { cliLaunchSourceLabel } from "@/lib/cli-catalog";
import { useServerStore } from "@/stores/serverStore";

interface PacketCodeIntegrationPanelProps {
  detection: DetectCatalogResult | undefined;
  manualPath: string | null;
  installing: boolean;
  inspection: PacketCodeInstallationInspection | null;
  installReport: PacketCodeInstallReport | null;
  onPinExecutable: (path: string) => Promise<void>;
  onInstall: () => void;
}

export interface PacketCodeInstallReport {
  status: "running" | "verifying" | "success" | "error";
  channel: "stable" | "preview";
  before: PacketCodeInstallationInspection | null;
  after: PacketCodeInstallationInspection | null;
  message?: string;
}

function isWindowsHost(): boolean {
  if (typeof navigator === "undefined") return false;
  return /windows|win32|win64/i.test(navigator.userAgent || navigator.platform || "");
}

function joinBinary(repo: string): string {
  const trimmed = repo.replace(/[\\/]+$/, "");
  return `${trimmed}${isWindowsHost() ? "\\bin\\packetcode.exe" : "/bin/packetcode"}`;
}

export function PacketCodeIntegrationPanel({
  detection,
  manualPath,
  installing,
  inspection,
  installReport,
  onPinExecutable,
  onInstall,
}: PacketCodeIntegrationPanelProps) {
  const localDataHome = usePacketCodeIntegrationStore((s) => s.localDataHome);
  const developerRepoPath = usePacketCodeIntegrationStore((s) => s.developerRepoPath);
  const releaseChannel = usePacketCodeIntegrationStore((s) => s.releaseChannel);
  const remoteDataHomes = usePacketCodeIntegrationStore((s) => s.remoteDataHomes);
  const setLocalDataHome = usePacketCodeIntegrationStore((s) => s.setLocalDataHome);
  const setDeveloperRepoPath = usePacketCodeIntegrationStore(
    (s) => s.setDeveloperRepoPath,
  );
  const setReleaseChannel = usePacketCodeIntegrationStore(
    (s) => s.setReleaseChannel,
  );
  const setRemoteDataHome = usePacketCodeIntegrationStore((s) => s.setRemoteDataHome);
  const servers = useServerStore((s) => s.servers);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<PacketCodeIntegrationProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const executable = inspection?.activeExecutablePath || manualPath || detection?.path || "";
  const executableVersion = inspection?.activeVersion || detection?.version || null;
  const localPlatform = isWindowsHost() ? "windows" : "posix";
  const invalidLocalHome =
    localDataHome.trim().length > 0 &&
    !isAbsolutePacketCodePath(localDataHome, localPlatform);
  const invalidRemoteIds = useMemo(
    () =>
      new Set(
        servers
          .filter((server) => {
            const path = remoteDataHomes[server.id]?.trim() ?? "";
            return path.length > 0 && !isAbsolutePacketCodePath(path, "posix");
          })
          .map((server) => server.id),
      ),
    [remoteDataHomes, servers],
  );

  const chooseDirectory = async (
    title: string,
    apply: (path: string) => void,
  ) => {
    const selected = await openDialog({
      multiple: false,
      directory: true,
      title,
    });
    if (typeof selected === "string") apply(selected);
  };

  const runDoctor = async () => {
    setProbing(true);
    setProbe(null);
    setProbeError(null);
    try {
      const result = await probePacketCodeIntegration(
        executable || null,
        localDataHome || null,
      );
      setProbe(result);
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-accent-amber/30 bg-bg-primary p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold text-text-primary">
            PacketCode integration
          </div>
          <div className="text-[10px] text-text-muted">
            Executable and data homes are independent. Changes apply to new sessions.
          </div>
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className="inline-flex items-center gap-1 rounded border border-accent-green/40 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 disabled:opacity-50"
        >
          {installing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          {detection?.installed ? "Update" : "Install"}
        </button>
      </div>

      {installReport && (
        <div
          className={`mt-3 rounded border px-2.5 py-2 text-[10px] ${
            installReport.status === "success"
              ? "border-accent-green/30 bg-accent-green/5"
              : installReport.status === "error"
                ? "border-accent-red/30 bg-accent-red/5"
                : "border-accent-blue/30 bg-accent-blue/5"
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium text-text-primary">
            {installReport.status === "running" || installReport.status === "verifying" ? (
              <Loader2 size={11} className="animate-spin text-accent-blue" />
            ) : installReport.status === "success" ? (
              <CheckCircle2 size={11} className="text-accent-green" />
            ) : (
              <XCircle size={11} className="text-accent-red" />
            )}
            {installReport.status === "running"
              ? `Installing ${installReport.channel}`
              : installReport.status === "verifying"
                ? "Verifying installed binary"
                : installReport.status === "success"
                  ? `${installReport.channel} install verified`
                  : "Install verification failed"}
          </div>

          {installReport.status === "success" && installReport.after && (
            <div className="mt-1.5 grid gap-1">
              <div className="text-text-secondary">
                Installer version: {installReport.before?.installerVersion ?? "not installed"} →{" "}
                <span className="font-mono text-text-primary">
                  {installReport.after.installerVersion}
                </span>
              </div>
              <div
                className="break-all font-mono text-text-secondary"
                title={installReport.after.installerExecutablePath}
              >
                Installed: {installReport.after.installerExecutablePath}
              </div>
              {installReport.after.workspaceUsesInstaller ? (
                <div className="flex items-center gap-1 text-accent-green">
                  <CheckCircle2 size={10} /> Workspace will launch this exact binary.
                </div>
              ) : (
                <div className="mt-0.5 rounded border border-accent-amber/30 bg-accent-amber/5 p-2">
                  <div className="text-accent-amber">
                    Workspace still launches {installReport.after.activeExecutablePath ?? "no binary"}
                    {installReport.after.activeSource
                      ? ` via ${cliLaunchSourceLabel(installReport.after.activeSource)}`
                      : ""}
                    .
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void onPinExecutable(installReport.after!.installerExecutablePath)
                    }
                    className="mt-1.5 rounded border border-accent-amber/40 px-2 py-1 text-[9px] text-accent-amber hover:bg-accent-amber/10"
                  >
                    Use installed binary in Workspace
                  </button>
                </div>
              )}
            </div>
          )}
          {installReport.message && (
            <div className="mt-1 text-accent-red">{installReport.message}</div>
          )}
        </div>
      )}

      <div className="mt-3 grid gap-2">
        <label className="grid gap-1">
          <span className="text-[10px] text-text-muted">
            Workspace launch binary
          </span>
          <input
            value={executable}
            readOnly
            placeholder="Not detected"
            className="rounded border border-bg-border bg-bg-secondary px-2 py-1 font-mono text-[10px] text-text-secondary"
          />
          <span className="text-[9px] text-text-muted">
            {executableVersion ?? "Version unavailable"}
            {inspection?.activeSource
              ? ` · selected via ${cliLaunchSourceLabel(inspection.activeSource)}`
              : ""}
          </span>
        </label>

        {inspection && (
          <div className="grid gap-1 rounded border border-bg-border bg-bg-secondary/40 px-2 py-1.5">
            <span className="text-[9px] uppercase tracking-wide text-text-muted">
              Official installer target
            </span>
            <span
              className="break-all font-mono text-[9px] text-text-secondary"
              title={inspection.installerExecutablePath}
            >
              {inspection.installerExecutablePath}
            </span>
            <span
              className={
                inspection.workspaceUsesInstaller ? "text-accent-green" : "text-accent-amber"
              }
            >
              {inspection.installerVersion ?? "Not installed"} ·{" "}
              {inspection.workspaceUsesInstaller
                ? "active in Workspace"
                : "not the active Workspace binary"}
            </span>
          </div>
        )}

        <label className="grid gap-1">
          <span className="text-[10px] text-text-muted">Local data home</span>
          <div className="flex gap-1">
            <input
              value={localDataHome}
              onChange={(event) => setLocalDataHome(event.target.value)}
              placeholder={
                isWindowsHost()
                  ? "Default: %USERPROFILE%\\.packetcode"
                  : "Default: ~/.packetcode"
              }
              className={`min-w-0 flex-1 rounded border bg-bg-secondary px-2 py-1 font-mono text-[10px] text-text-primary focus:outline-none ${
                invalidLocalHome
                  ? "border-accent-red/60"
                  : "border-bg-border focus:border-accent-blue/60"
              }`}
            />
            <button
              type="button"
              onClick={() =>
                void chooseDirectory("Choose PacketCode data home", setLocalDataHome)
              }
              className="rounded border border-bg-border px-2 text-text-muted hover:bg-bg-hover hover:text-text-primary"
              title="Choose data home"
            >
              <FolderOpen size={11} />
            </button>
          </div>
          {invalidLocalHome && (
            <span className="text-[9px] text-accent-red">
              PACKETCODE_HOME must be an absolute host path.
            </span>
          )}
        </label>

        <div className="grid grid-cols-[1fr_120px] gap-2">
          <label className="grid gap-1">
            <span className="text-[10px] text-text-muted">
              Development checkout (optional)
            </span>
            <div className="flex gap-1">
              <input
                value={developerRepoPath}
                onChange={(event) => setDeveloperRepoPath(event.target.value)}
                placeholder="PacketCode source repository"
                className="min-w-0 flex-1 rounded border border-bg-border bg-bg-secondary px-2 py-1 font-mono text-[10px] text-text-primary focus:border-accent-blue/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() =>
                  void chooseDirectory(
                    "Choose PacketCode development checkout",
                    setDeveloperRepoPath,
                  )
                }
                className="rounded border border-bg-border px-2 text-text-muted hover:bg-bg-hover hover:text-text-primary"
                title="Choose repository"
              >
                <FolderOpen size={11} />
              </button>
              {developerRepoPath.trim() && (
                <button
                  type="button"
                  onClick={() => void onPinExecutable(joinBinary(developerRepoPath))}
                  className="rounded border border-accent-amber/40 px-2 text-[9px] text-accent-amber hover:bg-accent-amber/10"
                  title={`Use ${joinBinary(developerRepoPath)}`}
                >
                  Use build
                </button>
              )}
            </div>
          </label>
          <label className="grid gap-1">
            <span className="text-[10px] text-text-muted">Release channel</span>
            <select
              value={releaseChannel}
              onChange={(event) =>
                setReleaseChannel(event.target.value === "preview" ? "preview" : "stable")
              }
              className="rounded border border-bg-border bg-bg-secondary px-2 py-1 text-[10px] text-text-primary"
            >
              <option value="stable">Stable</option>
              <option value="preview">Preview</option>
            </select>
          </label>
        </div>

        {servers.length > 0 && (
          <div className="grid gap-1">
            <span className="text-[10px] text-text-muted">
              Remote data homes (POSIX absolute paths)
            </span>
            {servers.map((server) => (
              <label key={server.id} className="grid grid-cols-[120px_1fr] items-center gap-2">
                <span className="truncate text-[9px] text-text-secondary" title={server.name}>
                  {server.name}
                </span>
                <input
                  value={remoteDataHomes[server.id] ?? ""}
                  onChange={(event) => setRemoteDataHome(server.id, event.target.value)}
                  placeholder="Default: ~/.packetcode"
                  className={`rounded border bg-bg-secondary px-2 py-1 font-mono text-[9px] text-text-primary focus:outline-none ${
                    invalidRemoteIds.has(server.id)
                      ? "border-accent-red/60"
                      : "border-bg-border focus:border-accent-blue/60"
                  }`}
                />
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-bg-border pt-2">
        <button
          type="button"
          onClick={() => void runDoctor()}
          disabled={probing || invalidLocalHome || !detection?.installed}
          className="inline-flex items-center gap-1 rounded border border-accent-blue/40 px-2 py-1 text-[10px] text-accent-blue hover:bg-accent-blue/10 disabled:opacity-40"
        >
          {probing ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
          Run doctor
        </button>
        {probe && (
          <div className="flex min-w-0 items-center gap-1 text-[9px]">
            {probe.healthy ? (
              <CheckCircle2 size={10} className="shrink-0 text-accent-green" />
            ) : (
              <XCircle size={10} className="shrink-0 text-accent-red" />
            )}
            <span className={probe.healthy ? "text-accent-green" : "text-accent-red"}>
              {probe.doctorStatus}
            </span>
            <span className="truncate text-text-muted" title={probe.effectiveHome ?? ""}>
              {probe.effectiveHome}
            </span>
            <span className="text-text-faint">
              providers {probe.providerSummary.ready}/{probe.providerSummary.configured} ready
            </span>
          </div>
        )}
        {probeError && (
          <span className="min-w-0 truncate text-[9px] text-accent-red" title={probeError}>
            {probeError}
          </span>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Atom,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Diamond,
  Download,
  ExternalLink,
  FolderOpen,
  Github,
  Hexagon,
  Loader2,
  type LucideIcon,
  MousePointer2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Terminal,
  Trash2,
  Wand2,
  Wind,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createGenericConfig } from "@/agents/generic";
import { useAgentStore } from "@/stores/agentStore";
import { useAppStore } from "@/stores/appStore";
import { useCliOverrideStore } from "@/stores/cliOverrideStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  brandClasses,
  CLI_CATALOG,
  type CliCatalogEntry,
  getCliBinaries,
} from "@/lib/cli-catalog";
import { detectCliCatalog, type DetectCatalogResult, writePty } from "@/lib/tauri";
import type { AgentConfig } from "@/types/agent";
import { CliCatalogHeader } from "./CliCatalogHeader";

// Static map from catalog iconName -> lucide component. Catalog uses string
// names so backend/test code can stay framework-agnostic; resolve here.
const ICON_MAP: Record<string, LucideIcon> = {
  Bot,
  Atom,
  Cpu,
  Sparkles,
  Hexagon,
  Terminal,
  Github,
  Wand2,
  MousePointer2,
  BrainCircuit,
  Wind,
  Diamond,
};

function renderCatalogIcon(
  name: string,
  className: string,
): React.ReactElement {
  const Resolved: LucideIcon = ICON_MAP[name] ?? Terminal;
  return <Resolved size={16} className={className} />;
}

// === v0.8.7: card variant model ===

/** Discriminated render mode for each catalog entry. Computed top-to-bottom:
 *  installed > browse-only > installable > coming-soon > browse-fallback. */
type CardVariant = "installed" | "browse-only" | "installable" | "coming-soon" | "browse-fallback";

function resolveVariant(
  entry: CliCatalogEntry,
  result: DetectCatalogResult | undefined,
): CardVariant {
  if (result?.installed) return "installed";
  if (entry.browseRequired) return "browse-only";
  if (entry.installCommand) return "installable";
  if (entry.comingSoon) return "coming-soon";
  return "browse-fallback";
}

/** OS detector — we lack `@tauri-apps/plugin-os`, so sniff the user agent.
 *  Used only to decide the file-picker extension filter; a wrong answer just
 *  means a less-helpful filter (Unix execs are extensionless either way). */
function isWindowsHost(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || navigator.platform || "";
  return /windows/i.test(ua) || /win32|win64/i.test(ua);
}

function basename(p: string): string {
  if (!p) return p;
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// === Custom CLI drawer state (preserved from previous implementation) ===

interface DraftState {
  id: string | null;
  name: string;
  command: string;
  defaultArgsText: string;
  description: string;
  isBuiltin: boolean;
}

function agentToDraft(agent: AgentConfig): DraftState {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgsText: agent.defaultArgs.join("\n"),
    description: agent.description,
    isBuiltin: agent.isBuiltin,
  };
}

function emptyDraft(): DraftState {
  return {
    id: null,
    name: "",
    command: "",
    defaultArgsText: "",
    description: "",
    isBuiltin: false,
  };
}

function parseArgs(value: string): string[] {
  return value
    .split("\n")
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function makeCustomAgentId(name: string, command: string): string {
  const seed = `${name || command}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `custom-${seed || "cli"}-${Date.now().toString(36)}`;
}

function commandSummary(agent: AgentConfig): string {
  return [agent.command, ...agent.defaultArgs].filter(Boolean).join(" ");
}

// === Per-card grid component ===

interface CliCatalogCardProps {
  entry: CliCatalogEntry;
  result: DetectCatalogResult | undefined;
  selected: boolean;
  detecting: boolean;
  installing: boolean;
  manualPath: string | null;
  onSelect: (id: string) => void;
  onInstall: (entry: CliCatalogEntry) => void;
  onBrowse: (entry: CliCatalogEntry) => void;
  onClearOverride: (entry: CliCatalogEntry) => void;
}

function CliCatalogCard({
  entry,
  result,
  selected,
  detecting,
  installing,
  manualPath,
  onSelect,
  onInstall,
  onBrowse,
  onClearOverride,
}: CliCatalogCardProps) {
  const variant = resolveVariant(entry, result);
  const installed = variant === "installed";
  const brand = brandClasses(entry.color);

  // Selected = filled accent-amber highlight; installed = green; otherwise
  // faint gray. Browse-only and Installable both stay "not installed" until
  // the user actually points us at a binary that responds.
  const outerClass = selected
    ? "border-accent-amber/40 bg-accent-amber/5"
    : installed
      ? "border-bg-border bg-bg-secondary hover:bg-bg-elevated"
      : variant === "coming-soon"
        ? "border-bg-border bg-bg-secondary opacity-80"
        : "border-bg-border bg-bg-secondary opacity-90 hover:bg-bg-elevated";

  const dotClass = !installed
    ? variant === "coming-soon"
      ? "bg-accent-amber/60"
      : "bg-text-faint"
    : selected
      ? "bg-accent-amber"
      : "bg-accent-green";

  let versionText: React.ReactNode;
  if (detecting && !result) {
    versionText = <span className="text-text-faint">checking…</span>;
  } else if (installed) {
    versionText = result?.version ? (
      <span className="font-mono">{result.version}</span>
    ) : (
      <span className="text-text-muted">installed</span>
    );
  } else if (variant === "browse-only") {
    versionText = <span className="italic text-text-muted">Locate the executable to use it here.</span>;
  } else if (variant === "installable") {
    versionText = <span className="italic">not installed</span>;
  } else if (variant === "coming-soon") {
    versionText = <span className="italic text-text-muted">Coming soon — track on the roadmap.</span>;
  } else {
    versionText = <span className="italic">not installed</span>;
  }

  // Buttons under the card body. `stopPropagation` so the surrounding card
  // click (which toggles selection) doesn't also fire when the user is
  // interacting with the install/browse affordances.
  function stop<E extends React.SyntheticEvent>(e: E) {
    e.stopPropagation();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(entry.id);
        }
      }}
      aria-pressed={selected}
      className={`relative flex flex-col gap-2 p-3 rounded border cursor-pointer transition-colors text-left ${outerClass}`}
    >
      {/* Status dot */}
      <span
        aria-hidden="true"
        className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full ${dotClass}`}
      />

      <div className="flex items-start gap-3">
        {/* Icon block */}
        <div
          className={`w-8 h-8 rounded flex items-center justify-center flex-shrink-0 ${
            installed ? brand.iconBg : "bg-bg-elevated"
          }`}
        >
          {installed ? (
            renderCatalogIcon(entry.iconName, brand.iconColor)
          ) : variant === "coming-soon" ? (
            <Clock size={14} className="text-accent-amber/80" />
          ) : (
            <span className="w-2 h-2 rounded-full bg-text-faint" />
          )}
        </div>

        {/* Name + version/state line */}
        <div className="flex-1 min-w-0 pr-4">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`text-xs font-medium truncate ${
                installed ? "text-text-primary" : "text-text-secondary"
              }`}
            >
              {entry.name}
            </span>
            {variant === "coming-soon" && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber font-medium uppercase tracking-wide">
                Coming Soon
              </span>
            )}
          </div>
          <div className="text-[10px] text-text-muted truncate mt-0.5">
            {versionText}
          </div>
        </div>
      </div>

      {/* Manual-path override tag — visible whenever the user has pinned a
          path AND detection succeeded. The X clears the override and
          re-runs detection so the card flips back to PATH-based resolution. */}
      {installed && manualPath && (
        <div className="flex items-center gap-1 text-[10px] text-text-faint" onClick={stop}>
          <span
            className="px-1.5 py-0.5 rounded bg-bg-elevated text-text-muted truncate max-w-[180px]"
            title={manualPath}
          >
            Override: {basename(manualPath)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onClearOverride(entry);
            }}
            className="p-0.5 rounded hover:bg-bg-hover hover:text-text-secondary transition-colors"
            title="Clear manual path override"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* State-specific actions row. Rendered only for non-installed
          variants — the installed card relies on its version line and the
          shared Test button in the header. */}
      {!installed && (
        <div className="flex items-center gap-1.5 flex-wrap" onClick={stop} onKeyDown={stop}>
          {variant === "browse-only" && (
            <button
              type="button"
              onClick={() => onBrowse(entry)}
              className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10 transition-colors"
            >
              <FolderOpen size={10} />
              Browse for binary
            </button>
          )}

          {variant === "installable" && (
            <>
              <button
                type="button"
                onClick={() => onInstall(entry)}
                disabled={installing}
                className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={entry.installCommand}
              >
                {installing ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Download size={10} />
                )}
                Install
              </button>
              <button
                type="button"
                onClick={() => onBrowse(entry)}
                className="text-[10px] text-text-muted hover:text-accent-blue underline underline-offset-2 transition-colors"
              >
                Browse…
              </button>
              {entry.installDocsUrl && (
                <a
                  href={entry.installDocsUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={stop}
                  className="flex items-center gap-0.5 text-[10px] text-text-faint hover:text-text-muted"
                  title="Install docs"
                >
                  <ExternalLink size={9} />
                </a>
              )}
            </>
          )}

          {variant === "coming-soon" && entry.installDocsUrl && (
            <a
              href={entry.installDocsUrl}
              target="_blank"
              rel="noreferrer"
              onClick={stop}
              className="flex items-center gap-1 text-[10px] text-text-faint hover:text-accent-amber underline underline-offset-2"
            >
              <ExternalLink size={9} />
              Roadmap
            </a>
          )}

          {variant === "browse-fallback" && (
            <button
              type="button"
              onClick={() => onBrowse(entry)}
              className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-bg-border text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <FolderOpen size={10} />
              Browse for binary
            </button>
          )}
        </div>
      )}

      {/* Installing feedback strip — present while we're spawning the
          install workspace. Clears when the install pane gets a sessionId. */}
      {installing && (
        <div className="flex items-center gap-1 text-[10px] text-accent-green border-t border-accent-green/20 pt-1.5">
          <Loader2 size={10} className="animate-spin" />
          <span>Installing in workspace →</span>
        </div>
      )}
    </div>
  );
}

// === Main card ===

export function CliAgentsCard() {
  const agents = useAgentStore((s) => s.agents);
  const storeDetecting = useAgentStore((s) => s.detecting);
  const addAgent = useAgentStore((s) => s.addAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const detectInstalled = useAgentStore((s) => s.detectInstalled);
  const resetBuiltins = useAgentStore((s) => s.resetBuiltins);

  // v0.8.7: manual-path overrides + workspace spawning for installs.
  const overrides = useCliOverrideStore((s) => s.overrides);
  const setManualPath = useCliOverrideStore((s) => s.setManualPath);
  const clearManualPath = useCliOverrideStore((s) => s.clearManualPath);

  const [results, setResults] = useState<Record<string, DetectCatalogResult>>({});
  const [scanning, setScanning] = useState(false);
  const [selectedCliId, setSelectedCliId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  // v0.8.8+ peer-review fix: a Set keyed by entry id, not a single string.
  // Two installs clicked in quick succession used to overwrite each other —
  // the second `setInstallingId` would clear the first install's spinner
  // even though the first install was still running (and the 30s safety net
  // would later flap the second install's spinner too).
  const [installingIds, setInstallingIds] = useState<Set<string>>(() => new Set());

  const customAgents = useMemo(
    () => agents.filter((a) => !a.isBuiltin),
    [agents],
  );

  /** Build the detector payload from the catalog, layering in any saved
   *  manual-path overrides so the backend resolves to the pinned binary
   *  instead of (or in preference to) PATH. */
  const buildDetectItems = useCallback(() => {
    return getCliBinaries().map((item) => {
      const manualPath = overrides[item.id]?.manualPath;
      return manualPath ? { ...item, manualPath } : item;
    });
  }, [overrides]);

  // Bulk-scan the catalog via detectCliCatalog (the legacy detectAgent
  // command now routes through the same backend, so a separate fallback
  // path would just duplicate work). On error, log + leave results so
  // the cards render as "not installed" rather than silently lying.
  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      const out = await detectCliCatalog(buildDetectItems());
      const merged: Record<string, DetectCatalogResult> = {};
      for (const r of out) merged[r.id] = r;
      setResults(merged);
      // Keep the legacy agent store in sync for consumers that still read
      // `agentStore.agents[].installed`.
      void detectInstalled();
    } catch (err) {
      console.warn("[cli-catalog] detection failed:", err);
    } finally {
      setScanning(false);
    }
  }, [buildDetectItems, detectInstalled]);

  // Mount: rescan once if results are empty.
  useEffect(() => {
    if (Object.keys(results).length === 0) {
      void rescan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installedCount = useMemo(
    () => CLI_CATALOG.filter((e) => results[e.id]?.installed).length,
    [results],
  );

  const selectedEntry = useMemo(
    () => (selectedCliId ? CLI_CATALOG.find((e) => e.id === selectedCliId) : null) ?? null,
    [selectedCliId],
  );
  const detecting = scanning || storeDetecting;

  function toggleSelect(id: string) {
    setSelectedCliId((prev) => (prev === id ? null : id));
  }

  async function handleTest(): Promise<{ ok: boolean; output: string }> {
    if (!selectedEntry) {
      return { ok: false, output: "No CLI selected." };
    }
    try {
      // Re-probe the selected binary specifically so the user gets fresh
      // installed/version data for the one they care about. Reuses the same
      // detect_cli_catalog command the grid uses for the full sweep — and
      // critically threads any pinned manualPath through, so testing an
      // override-pinned CLI doesn't fall back to PATH.
      const manualPath = overrides[selectedEntry.id]?.manualPath;
      const item = manualPath
        ? { id: selectedEntry.id, binary: selectedEntry.binary, manualPath }
        : { id: selectedEntry.id, binary: selectedEntry.binary };
      const [result] = await detectCliCatalog([item]);
      if (!result) {
        return { ok: false, output: "Detection returned no result." };
      }
      // Update the local results map so the card refreshes immediately.
      setResults((prev) => ({ ...prev, [selectedEntry.id]: result }));
      if (!result.installed) {
        return {
          ok: false,
          output: `${selectedEntry.binary} not found on PATH.`,
        };
      }
      const versionLine = result.version
        ? `${selectedEntry.binary} ${result.version}`
        : `${selectedEntry.binary} responds on PATH (no version string)`;
      const pathLine = result.path ? `\n${result.path}` : "";
      return { ok: true, output: `${versionLine}${pathLine}` };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // === v0.8.7 actions ===

  /** Re-probe a single catalog entry and merge the result into local state.
   *  Used after Browse-for-binary picks a path, and after Reset-override
   *  clears one. Keeps the card snappy without forcing a full grid rescan. */
  const redetectOne = useCallback(
    async (entry: CliCatalogEntry, manualPath: string | null) => {
      try {
        const item = manualPath
          ? { id: entry.id, binary: entry.binary, manualPath }
          : { id: entry.id, binary: entry.binary };
        const [result] = await detectCliCatalog([item]);
        if (result) {
          setResults((prev) => ({ ...prev, [entry.id]: result }));
        }
      } catch (err) {
        console.warn("[cli-catalog] single-entry detect failed:", err);
      }
    },
    [],
  );

  /** Open a file picker scoped to the host OS so the user can pin a binary
   *  on disk. On selection, persist the override + immediately re-probe the
   *  entry so the card flips to "installed" if the binary responds. */
  const handleBrowse = useCallback(
    async (entry: CliCatalogEntry) => {
      try {
        const win = isWindowsHost();
        const selected = await openDialog({
          multiple: false,
          directory: false,
          title: `Locate ${entry.name} binary`,
          filters: win
            ? [{ name: "Executable", extensions: ["exe"] }]
            : undefined,
        });
        if (!selected || typeof selected !== "string") {
          // Cancelled, or returned an array (we passed multiple: false so
          // we treat any non-string as a no-op).
          return;
        }
        setManualPath(entry.id, selected);
        await redetectOne(entry, selected);
      } catch (err) {
        console.warn("[cli-catalog] browse failed:", err);
      }
    },
    [setManualPath, redetectOne],
  );

  /** Clear a manual-path override and re-detect via PATH. */
  const handleClearOverride = useCallback(
    async (entry: CliCatalogEntry) => {
      clearManualPath(entry.id);
      await redetectOne(entry, null);
    },
    [clearManualPath, redetectOne],
  );

  /** Spawn a single-pane terminal workspace that runs the entry's
   *  `installCommand` as its first input, then switch the active view to
   *  the workspace so the user can watch the install run. The pane is a
   *  plain shell (agentId === "terminal"), not a Claude session, so the
   *  install command runs verbatim without an agent wrapping prompt.
   *
   *  Wiring the install command into the pane:
   *    1. createWorkspace with a single "terminal" slot.
   *    2. Subscribe to workspaceStore — when the pane's sessionId flips
   *       from null to a string, writePty the install command + CR.
   *    3. Unsubscribe (and clear the spinner) on first write, or on a
   *       safety timeout if the pane never spawns. */
  const handleInstall = useCallback(
    (entry: CliCatalogEntry) => {
      const cmd = entry.installCommand?.trim();
      if (!cmd) return;

      const projectPath = useLayoutStore.getState().projectPath;
      const wsId = useWorkspaceStore.getState().createWorkspace(
        `Install ${entry.name}`,
        ["terminal"],
        projectPath,
        {
          // Stamped onto the workspace; the terminal pane currently
          // ignores `prompt` (it's only forwarded to CLI agents), so we
          // still need the subscribe-and-write path below. Keeping it
          // here gives downstream surfaces (history, sidebar previews) a
          // reasonable summary of what the workspace was for.
          prompt: cmd,
        },
      );

      setInstallingIds((cur) => {
        const next = new Set(cur);
        next.add(entry.id);
        return next;
      });

      // Watch the workspace until its first pane gets a sessionId. The
      // pane is created synchronously inside createWorkspace, but its
      // sessionId is populated asynchronously by TerminalPane.onSessionCreated.
      // We use a holder + tear-down function so the subscribe callback,
      // the safety timeout, and the cleanup can all share the same
      // single-shot resolution path.
      const teardown = { fn: () => {} };
      let sent = false;
      const finish = (cb?: () => void) => {
        if (sent) return;
        sent = true;
        teardown.fn();
        setInstallingIds((cur) => {
          if (!cur.has(entry.id)) return cur;
          const next = new Set(cur);
          next.delete(entry.id);
          return next;
        });
        cb?.();
      };

      const unsubscribe = useWorkspaceStore.subscribe((state) => {
        if (sent) return;
        const ws = state.workspaces.find((w) => w.id === wsId);
        const sessionId = ws?.panes[0]?.sessionId;
        if (!sessionId) return;
        finish(() => {
          // Trailing CR (not LF) — some Windows ConPTY configs won't
          // fire shells' Enter handler on bare LF. Mirrors the
          // writePty pattern used everywhere else in the workspace
          // pane code.
          void writePty(sessionId, cmd + "\r").catch((err) => {
            console.warn("[cli-catalog] install writePty failed:", err);
          });
        });
      });

      // Safety net: if the pane never produces a sessionId within 30s
      // (no terminal pane mounted, user closed the workspace, etc.) we
      // still drop the spinner so the install button comes back.
      const safety = window.setTimeout(() => finish(), 30_000);

      teardown.fn = () => {
        window.clearTimeout(safety);
        unsubscribe();
      };

      // Flip the active view so the user actually sees the install run.
      useWorkspaceStore.getState().setActiveWorkspace(wsId);
      useAppStore.getState().setActiveView("workspace");
    },
    [],
  );

  // === Custom CLI drawer handlers (preserved) ===

  function startCreate() {
    setDraft(emptyDraft());
    setAdvancedOpen(true);
  }
  function startEdit(agent: AgentConfig) {
    setDraft(agentToDraft(agent));
    setAdvancedOpen(true);
  }
  function cancel() {
    setDraft(null);
  }
  function save() {
    if (!draft) return;
    const command = draft.command.trim();
    const name = draft.name.trim();
    if (!command || (!draft.isBuiltin && !name)) return;
    const defaultArgs = parseArgs(draft.defaultArgsText);
    if (draft.id) {
      updateAgent(draft.id, {
        command,
        defaultArgs,
        ...(!draft.isBuiltin
          ? { name, description: draft.description.trim() }
          : {}),
      });
    } else {
      const id = makeCustomAgentId(name, command);
      addAgent({
        ...createGenericConfig(id, name, command, draft.description.trim()),
        defaultArgs,
      });
    }
    setDraft(null);
  }
  function confirmRemove(agent: AgentConfig) {
    if (agent.isBuiltin) return;
    if (window.confirm(`Delete CLI agent "${agent.name}"? This cannot be undone.`)) {
      removeAgent(agent.id);
      if (draft?.id === agent.id) setDraft(null);
    }
  }
  function handleResetBuiltins() {
    if (
      window.confirm(
        "Reset built-in CLI agents to their default commands and args? Custom CLI agents will be kept.",
      )
    ) {
      resetBuiltins();
      void detectInstalled();
      if (draft?.isBuiltin) setDraft(null);
    }
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <CliCatalogHeader
        installedCount={installedCount}
        selectedEntry={
          selectedEntry
            ? {
                id: selectedEntry.id,
                name: selectedEntry.name,
                binary: selectedEntry.binary,
              }
            : null
        }
        isRescanning={detecting}
        onRescan={rescan}
        onTest={handleTest}
      />


      {/* 2-column responsive grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {CLI_CATALOG.map((entry) => (
          <CliCatalogCard
            key={entry.id}
            entry={entry}
            result={results[entry.id]}
            selected={selectedCliId === entry.id}
            detecting={detecting}
            installing={installingIds.has(entry.id)}
            manualPath={overrides[entry.id]?.manualPath ?? null}
            onSelect={toggleSelect}
            onInstall={handleInstall}
            onBrowse={handleBrowse}
            onClearOverride={handleClearOverride}
          />
        ))}
      </div>

      {/* Advanced: custom CLI management + reset built-ins */}
      <div className="mt-4 border-t border-bg-border pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-text-primary transition-colors"
        >
          {advancedOpen ? (
            <ChevronDown size={10} />
          ) : (
            <ChevronRight size={10} />
          )}
          Advanced — custom CLI agents
          {customAgents.length > 0 && (
            <span className="text-[10px] text-text-faint">
              ({customAgents.length})
            </span>
          )}
        </button>

        {advancedOpen && (
          <div className="mt-3">
            <div className="flex items-center justify-end gap-1 mb-2">
              <button
                type="button"
                onClick={handleResetBuiltins}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                title="Reset built-in command overrides"
              >
                <RotateCcw size={10} />
                Reset built-ins
              </button>
              <button
                type="button"
                onClick={startCreate}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
              >
                <Plus size={10} />
                Custom
              </button>
            </div>

            {customAgents.length === 0 && !draft ? (
              <p className="text-[10px] text-text-faint italic">
                No custom CLI agents yet. Click Custom to add one.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {customAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-start gap-2.5 p-2.5 bg-bg-primary border border-bg-border rounded-md"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11.5px] font-semibold text-text-primary">
                          {agent.name}
                        </span>
                        <span className="text-[9px] px-1 py-px rounded bg-bg-elevated text-text-muted">
                          custom
                        </span>
                        {detecting ? (
                          <span className="inline-flex items-center gap-1 text-[9px] text-text-muted">
                            <RefreshCw size={9} className="animate-spin" />
                            checking
                          </span>
                        ) : agent.installed ? (
                          <span className="inline-flex items-center gap-1 text-[9px] text-accent-green">
                            <Check size={9} />
                            installed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[9px] text-accent-amber">
                            <AlertCircle size={9} />
                            not found
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5 line-clamp-1">
                        {agent.description || "No description"}
                      </div>
                      <div
                        className="text-[10px] text-text-faint mt-1 font-mono truncate"
                        title={commandSummary(agent) || "No command"}
                      >
                        {commandSummary(agent) || "No command"}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(agent)}
                        className="p-1 text-text-faint hover:text-accent-blue rounded"
                        title="Edit command and args"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => confirmRemove(agent)}
                        className="p-1 text-text-faint hover:text-accent-red rounded"
                        title="Delete custom CLI agent"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {draft && (
              <div className="mt-3 p-3 border border-accent-blue/40 rounded-md bg-bg-primary">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-text-primary">
                    {draft.id ? `Edit ${draft.name}` : "New custom CLI agent"}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={save}
                      disabled={
                        !draft.command.trim() ||
                        (!draft.isBuiltin && !draft.name.trim())
                      }
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40"
                    >
                      <Check size={11} />
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancel}
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-bg-border text-text-secondary hover:bg-bg-hover"
                    >
                      <X size={11} />
                      Cancel
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] text-text-muted">Name</span>
                    <input
                      type="text"
                      value={draft.name}
                      disabled={draft.isBuiltin}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                      placeholder="My CLI agent"
                      className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary disabled:text-text-muted disabled:opacity-70 focus:outline-none focus:border-accent-blue/60"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] text-text-muted">Command</span>
                    <input
                      type="text"
                      value={draft.command}
                      onChange={(e) =>
                        setDraft({ ...draft, command: e.target.value })
                      }
                      placeholder="claude, codex, C:\\tools\\agent.cmd"
                      className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono"
                    />
                  </label>
                </div>

                {!draft.isBuiltin && (
                  <label className="flex flex-col gap-1 mb-2">
                    <span className="text-[10px] text-text-muted">
                      Description
                    </span>
                    <input
                      type="text"
                      value={draft.description}
                      onChange={(e) =>
                        setDraft({ ...draft, description: e.target.value })
                      }
                      placeholder="What this CLI is used for"
                      className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60"
                    />
                  </label>
                )}

                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-text-muted">
                    Default args, one per line
                  </span>
                  <textarea
                    value={draft.defaultArgsText}
                    onChange={(e) =>
                      setDraft({ ...draft, defaultArgsText: e.target.value })
                    }
                    rows={4}
                    placeholder={"--model\nsonnet"}
                    className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono resize-y"
                  />
                  <span className="text-[9.5px] text-text-faint">
                    Args are passed before the task prompt. Use a wrapper script
                    for complex shell quoting.
                  </span>
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

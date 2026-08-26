import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, AlertCircle, ChevronDown, RefreshCw, Settings2 } from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import type { AgentCli } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import {
  API_PROVIDERS,
  getModelSpeed,
  MODEL_SPEED_LABEL,
  type ApiModel,
} from "@/lib/api-models";
import type { OllamaModelsState } from "../hooks/useOllamaModels";
import { useCustomModels } from "../hooks/useCustomModels";

/** Compact context-window label, e.g. 200_000 -> "200K ctx", 1_000_000 -> "1M ctx". */
function formatContextWindow(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M ctx`;
  }
  return `${Math.round(tokens / 1000)}K ctx`;
}

/** Compact per-1M-token price label, e.g. { input: 3, output: 15 } -> "$3/$15". */
function formatPricing(
  pricing: { input: number; output: number } | undefined,
): string | null {
  if (!pricing) return null;
  return `$${pricing.input}/$${pricing.output}`;
}

/** One selectable model row, rendered identically by both popover directions. */
interface ModelRow {
  key: string;
  /** Text the search box filters on. */
  searchText: string;
  body: ReactNode;
  onSelect: () => void;
  /** Tool-less Ollama model while the surface needs tool calling: shown but
   * not selectable (backend pre-flight is the real enforcement point). */
  disabled?: boolean;
}

interface ModelSelectorProps {
  selectedAgent: AgentCli;
  selectedModel: string;
  onModelChange: (model: string) => void;
  /**
   * THE rows to offer, from `capabilitiesFor(conversation).models`.
   *
   * The catalog is only a SEED for engine-backed sessions: an ACP session's
   * real choices come from the engine's `_packetcode/models/list`, and the
   * descriptor already prefers that list when the engine advertised it. Pass
   * it and the picker offers exactly what the session can actually run.
   *
   * Omitted (or empty) falls back to the `API_PROVIDERS` row for
   * `selectedAgent`, which is what this component did unconditionally before
   * — so every non-engine caller behaves identically to today. Ollama is
   * unaffected either way: its rows are live-fetched via `ollamaModels`.
   */
  models?: ApiModel[];
  ollamaModels: OllamaModelsState;
  refreshOllamaModels: () => void;
  /** Imperative "open now" channel, e.g. so the `/model` slash command can
   * open whichever surface currently owns the picker. */
  openSignal?: number;
  /**
   * Open the list UPWARD. The composer sits on the bottom edge of the pane, so
   * the shared `Dropdown` (which is hard-coded to `top-full`) would render its
   * menu off-screen there. This flag swaps in an equivalent self-contained
   * popover anchored to `bottom-[calc(100%+8px)]`; the rows, the search box and
   * the `openSignal` behaviour are the same either way.
   */
  dropUp?: boolean;
  /** True when the surface this picker serves runs tool-carrying turns
   * (conversation tiles always do). Ollama models the daemon reports as
   * tool-less are disabled; unknown-capability models stay selectable. */
  requiresTools?: boolean;
}

export function ModelSelector({
  selectedAgent,
  selectedModel,
  onModelChange,
  models,
  ollamaModels,
  refreshOllamaModels,
  openSignal,
  dropUp = false,
  requiresTools = false,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Same imperative channel the shared Dropdown exposes.
  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) {
      setFilter("");
      return;
    }
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  const isOllama = selectedAgent === "api-ollama";
  const isCustom = selectedAgent === "api-custom";
  // LM2: the custom endpoint models are a runtime-managed manual list, so
  // (like Ollama live list) the static catalog carries none.
  const { customModels, refresh: refreshCustomModels } =
    useCustomModels(selectedAgent);
  const openSettings = useAppStore((s) => s.openSettings);

  // Capability first, catalog second. The catalog lookup is what used to gate
  // this whole component (`if (!provider) return null`), which meant a session
  // whose real model list came from somewhere other than `API_PROVIDERS` got
  // no picker at all — and an engine that advertised models had them ignored.
  const catalogModels =
    API_PROVIDERS.find((p) => p.agentCli === selectedAgent)?.models ?? [];
  const modelRows = models && models.length > 0 ? models : catalogModels;
  // Ollama draws its rows from the live daemon probe, so an empty catalog is
  // expected there and must not unmount the picker.
  if (!isOllama && !isCustom && modelRows.length === 0) return null;

  // Trigger label. In Ollama mode the label is the live-fetched model name
  // (just the `name` string; Ollama installs have no separate display label).
  let triggerLabel: string;
  if (isOllama) {
    if (Array.isArray(ollamaModels)) {
      const match = ollamaModels.find((m) => m.name === selectedModel);
      triggerLabel =
        match?.name ?? selectedModel ?? ollamaModels[0]?.name ?? "Select model";
    } else if (ollamaModels === "loading") {
      triggerLabel = selectedModel || "Loading models…";
    } else {
      triggerLabel = selectedModel || "Ollama unreachable";
    }
  } else if (isCustom) {
    triggerLabel = selectedModel || "Select model";
  } else {
    const currentModel =
      modelRows.find((m) => m.value === selectedModel) ?? modelRows[0];
    triggerLabel = currentModel?.label ?? "Select model";
  }

  const speed = getModelSpeed(selectedModel);
  const speedClass =
    speed === "fast"
      ? "text-accent-green bg-accent-green/10"
      : speed === "thorough"
        ? "text-accent-purple bg-accent-purple/10"
        : "text-accent-blue bg-accent-blue/10";

  // ── Rows + notices, computed once and rendered by either direction ──────
  const rows: ModelRow[] = [];
  let header: ReactNode = null;
  let notice: ReactNode = null;

  if (isOllama) {
    header = (
      <div className="flex items-center justify-between px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
        <span>Installed models</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            refreshOllamaModels();
          }}
          className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Refresh installed Ollama models"
        >
          <RefreshCw size={10} />
        </button>
      </div>
    );
    if (ollamaModels === "loading") {
      notice = (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-text-muted">
          <Loader2 size={10} className="animate-spin motion-reduce:animate-none" />
          Loading models…
        </div>
      );
    } else if (!Array.isArray(ollamaModels)) {
      notice = (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-accent-red">
            <AlertCircle size={10} />
            {ollamaModels.error}
          </div>
          <button
            type="button"
            onClick={() => {
              refreshOllamaModels();
              setOpen(false);
            }}
            className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
          >
            <span className="flex items-center gap-1.5 text-text-secondary">
              <RefreshCw size={10} />
              Retry
            </span>
          </button>
        </>
      );
    } else if (ollamaModels.length === 0) {
      notice = (
        <div className="px-3 py-1.5 text-meta text-text-muted">
          No models installed. Run{" "}
          <code className="text-text-secondary">ollama pull &lt;model&gt;</code>{" "}
          in a terminal.
        </div>
      );
    } else {
      for (const m of ollamaModels) {
        const toolless = requiresTools && m.supportsTools === false;
        rows.push({
          key: m.name,
          searchText: m.name,
          disabled: toolless,
          onSelect: toolless ? () => {} : () => onModelChange(m.name),
          body: (
            <span
              className={`flex w-full items-center justify-between gap-2 ${toolless ? "opacity-50" : ""}`}
              title={
                toolless
                  ? "This model has no tools template — agent turns need tool calling"
                  : undefined
              }
            >
              <span className="truncate">{m.name}</span>
              {toolless ? (
                <span className="shrink-0 text-meta text-text-muted">no tools</span>
              ) : (
                typeof m.size === "number" && (
                  <span className="shrink-0 text-meta text-text-muted">
                    {(m.size / 1e9).toFixed(1)} GB
                  </span>
                )
              )}
            </span>
          ),
        });
      }
    }
  } else if (isCustom) {
    header = (
      <div className="flex items-center justify-between px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
        <span>Configured models</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            refreshCustomModels();
          }}
          className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Reload the configured model list"
        >
          <RefreshCw size={10} />
        </button>
      </div>
    );
    if (customModels === "loading") {
      notice = (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-text-muted">
          <Loader2 size={10} className="animate-spin motion-reduce:animate-none" />
          Loading models…
        </div>
      );
    } else if (!Array.isArray(customModels)) {
      notice = (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-accent-red">
          <AlertCircle size={10} />
          {customModels.error}
        </div>
      );
    } else if (customModels.length === 0) {
      notice = (
        <div className="px-3 py-1.5 text-meta text-text-muted">
          No models configured for the custom endpoint yet.
        </div>
      );
    } else {
      for (const name of customModels) {
        rows.push({
          key: name,
          searchText: name,
          onSelect: () => onModelChange(name),
          body: <span className="truncate">{name}</span>,
        });
      }
    }
    rows.push({
      key: "__edit_custom_models__",
      searchText: "edit models settings",
      onSelect: () => openSettings({ section: "providers" }),
      body: (
        <span className="flex items-center gap-1.5 text-text-secondary">
          <Settings2 size={10} />
          Edit models…
        </span>
      ),
    });
  } else {
    for (const m of modelRows) {
      const ctx = formatContextWindow(m.contextWindow);
      const price = formatPricing(m.pricing);
      rows.push({
        key: m.value,
        searchText: m.label,
        onSelect: () => onModelChange(m.value),
        body: (
          <span className="flex w-full items-center justify-between gap-3">
            <span className="truncate">{m.label}</span>
            {(ctx || price) && (
              <span className="flex shrink-0 items-center gap-2 text-meta tabular-nums text-text-muted">
                {ctx && <span>{ctx}</span>}
                {price && <span>{price}</span>}
              </span>
            )}
          </span>
        ),
      });
    }
  }

  const trigger = (
    <span className="flex items-center gap-1.5 text-ui text-text-muted">
      <span>{triggerLabel}</span>
      <span
        className={`rounded px-1 py-px text-meta font-medium ${speedClass}`}
        title={`${MODEL_SPEED_LABEL[speed]} mode (heuristic)`}
      >
        {MODEL_SPEED_LABEL[speed]}
      </span>
    </span>
  );

  // ── Downward (launch card / anywhere with room below) ───────────────────
  if (!dropUp) {
    return (
      <Dropdown
        searchable
        searchPlaceholder="Search models…"
        openSignal={openSignal}
        trigger={trigger}
      >
        {header}
        {notice}
        {rows.map((r) => (
          <DropdownItem
            key={r.key}
            onClick={r.disabled ? () => {} : r.onSelect}
          >
            {r.body}
          </DropdownItem>
        ))}
      </Dropdown>
    );
  }

  // ── Upward (composer row, pinned to the bottom edge) ────────────────────
  const needle = filter.trim().toLowerCase();
  const visible =
    needle === ""
      ? rows
      : rows.filter((r) => r.searchText.toLowerCase().includes(needle));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        {trigger}
        <ChevronDown
          size={10}
          className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute bottom-[calc(100%+8px)] right-0 z-50 min-w-[220px] rounded-lg border border-bg-border bg-bg-elevated py-1 shadow-xl"
        >
          <div className="px-1 pb-1">
            <input
              ref={searchRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                if (filter !== "") setFilter("");
                else setOpen(false);
              }}
              placeholder="Search models…"
              className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
            />
          </div>
          {header}
          {notice}
          {visible.map((r) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected={r.key === selectedModel}
              aria-disabled={r.disabled}
              onClick={() => {
                if (r.disabled) return;
                r.onSelect();
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
            >
              {r.body}
            </button>
          ))}
          {needle !== "" && visible.length === 0 && (
            <div className="px-2 py-1 text-ui text-text-muted">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}

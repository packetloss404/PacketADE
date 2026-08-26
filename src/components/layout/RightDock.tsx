/**
 * D2 — the one right-side dock (audit finding P0-2).
 *
 * Surfaces register the panels they own; the dock decides which single panel
 * is visible, how wide it may be, and whether it can be docked inline at all.
 * Nothing else in the shell is allowed to render a fixed-width right panel.
 *
 * Behaviour:
 *   - exactly ONE panel visible per surface (the tab strip is the switcher);
 *   - width clamped by `dockWidthContract` against the live viewport so the
 *     centre canvas keeps `MIN_CENTER_WIDTH`;
 *   - one resizer (pointer drag + arrow keys), width persisted per surface;
 *   - when the viewport is too narrow to dock inline, the dock collapses to
 *     its icon rail; explicitly expanding from there floats the panel over the
 *     canvas rather than squeezing it to nothing.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useViewportWidth } from "@/hooks/useViewportWidth";
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  dockWidthContract,
  useRightDockStore,
  type DockPanelId,
  type DockSurface,
} from "@/stores/rightDockStore";

export interface RightDockPanel {
  id: DockPanelId;
  label: string;
  icon: LucideIcon;
  /** Rendered but not selectable (D3 idiom: disable, never hide). */
  disabled?: boolean;
  /** Tooltip explaining why the panel is disabled. */
  disabledReason?: string;
  /** Small accent pill on the tab (e.g. unreviewed diff count). */
  badge?: number;
  /** Dot marker on the tab (e.g. the Editor's unsaved-buffer indicator). */
  dot?: boolean;
  render: () => ReactNode;
}

interface RightDockProps {
  surface: DockSurface;
  panels: RightDockPanel[];
  /** Accessible name for the tab strip / icon rail. */
  ariaLabel: string;
}

export function RightDock({ surface, panels, ariaLabel }: RightDockProps) {
  const state = useRightDockStore((s) => s.surfaces[surface]);
  const openPanel = useRightDockStore((s) => s.openPanel);
  const setActivePanel = useRightDockStore((s) => s.setActivePanel);
  const setExpanded = useRightDockStore((s) => s.setExpanded);
  const setWidth = useRightDockStore((s) => s.setWidth);

  const viewportWidth = useViewportWidth();
  const [isDragging, setIsDragging] = useState(false);
  // Explicit expansion while the viewport cannot host an inline dock.
  const [floating, setFloating] = useState(false);

  const contract = useMemo(
    () => dockWidthContract(surface, viewportWidth, state.width),
    [surface, viewportWidth, state.width],
  );
  const fitsInline = !contract.overlay;

  const selectable = useMemo(() => panels.filter((p) => !p.disabled), [panels]);
  const active = useMemo(
    () =>
      selectable.find((p) => p.id === state.activePanel) ?? selectable[0] ?? null,
    [selectable, state.activePanel],
  );

  // Keep the store's active panel honest when the registered set changes
  // (a panel disappearing must not leave the dock pointing at nothing).
  useEffect(() => {
    const next = active?.id ?? null;
    if (state.activePanel !== next) setActivePanel(surface, next);
  }, [active?.id, state.activePanel, setActivePanel, surface]);

  // Re-widening the window drops the floating override.
  useEffect(() => {
    if (fitsInline && floating) setFloating(false);
  }, [fitsInline, floating]);

  const showBody = Boolean(active) && (fitsInline ? state.expanded : floating);
  const overlay = showBody && !fitsInline;

  const selectPanel = useCallback(
    (id: DockPanelId) => {
      openPanel(surface, id);
      if (!fitsInline) setFloating(true);
    },
    [openPanel, surface, fitsInline],
  );

  const collapse = useCallback(() => {
    setExpanded(surface, false);
    setFloating(false);
  }, [setExpanded, surface]);

  const expand = useCallback(() => {
    setExpanded(surface, true);
    if (!fitsInline) setFloating(true);
  }, [setExpanded, surface, fitsInline]);

  // Pointer drag on the left edge.
  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: PointerEvent) => {
      setWidth(surface, window.innerWidth - e.clientX);
    };
    const handleUp = () => setIsDragging(false);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [isDragging, setWidth, surface]);

  if (panels.length === 0) return null;

  // B4 — the rail is not free chrome. A surface that has never opened its dock
  // (Agents, by default) renders NOTHING here, so the shell reads as two panes
  // instead of a three-column IDE with an empty third column. Once the dock has
  // been opened even once — by the user or by an auto-reveal deep link — the
  // rail stays as the way back. While the panel floats it is always kept, since
  // it is the only thing anchoring the overlay to the shell.
  const railVisible = (showBody && overlay) || (!showBody && state.everOpened);

  return (
    <>
      {railVisible && (
        <div
          className="flex w-[30px] shrink-0 flex-col items-center gap-1 border-l border-bg-border bg-bg-secondary py-2"
          data-testid={`right-dock-rail-${surface}`}
        >
          {!showBody && (
            <>
              <Tooltip content="Show right pane" side="left">
                <button
                  type="button"
                  aria-label="Show right pane"
                  onClick={expand}
                  className="grid h-6 w-6 place-items-center rounded text-text-muted transition-colors hover:text-text-primary"
                >
                  <ChevronRight size={12} className="rotate-180" />
                </button>
              </Tooltip>
              <div className="h-2 w-px bg-line-soft" />
            </>
          )}
          <div role="tablist" aria-label={ariaLabel} className="contents">
            {panels.map((panel) => (
              <DockTab
                key={panel.id}
                panel={panel}
                active={active?.id === panel.id && showBody}
                compact
                onSelect={() => selectPanel(panel.id)}
              />
            ))}
          </div>
          <div className="flex-1" />
        </div>
      )}

      {showBody && active && (
        <aside
          aria-label={ariaLabel}
          data-dock-surface={surface}
          data-dock-overlay={overlay ? "true" : "false"}
          className={`flex min-h-0 flex-col border-l border-bg-border bg-bg-secondary ${
            overlay
              ? "absolute bottom-0 right-0 top-0 z-30 shadow-2xl"
              : "relative shrink-0"
          }`}
          style={{ width: contract.width }}
        >
          <div
            onPointerDown={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 32 : 8;
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                setWidth(surface, state.width + step);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                setWidth(surface, state.width - step);
              }
            }}
            className={`absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors ${
              isDragging ? "bg-accent-line" : "hover:bg-accent-line/60 bg-transparent"
            }`}
            title="Drag to resize"
            aria-label="Resize right pane"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(contract.width)}
            aria-valuemin={DOCK_MIN_WIDTH}
            aria-valuemax={Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, contract.available))}
            tabIndex={0}
          />

          <div
            role="tablist"
            aria-label={ariaLabel}
            className="flex h-[33px] items-stretch overflow-x-auto border-b border-bg-border px-1"
          >
            {panels.map((panel) => (
              <DockTab
                key={panel.id}
                panel={panel}
                active={active.id === panel.id}
                onSelect={() => selectPanel(panel.id)}
              />
            ))}
            <div className="flex-1" />
            <button
              type="button"
              onClick={collapse}
              title="Collapse pane"
              className="grid h-[22px] w-6 shrink-0 self-center place-items-center rounded text-text-muted transition-colors hover:text-text-primary"
            >
              <ChevronRight size={12} />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {active.render()}
          </div>
        </aside>
      )}
    </>
  );
}

function DockTab({
  panel,
  active,
  compact = false,
  onSelect,
}: {
  panel: RightDockPanel;
  active: boolean;
  compact?: boolean;
  onSelect: () => void;
}) {
  const Icon = panel.icon;
  const disabled = Boolean(panel.disabled);
  const title = disabled
    ? panel.disabledReason
      ? `${panel.label} — ${panel.disabledReason}`
      : panel.label
    : panel.badge
      ? `${panel.label} (${panel.badge} unreviewed)`
      : panel.label;

  const button = (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={panel.label}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onSelect();
      }}
      title={title}
      className={
        compact
          ? `relative grid h-6 w-6 place-items-center rounded transition-colors ${
              disabled
                ? "cursor-not-allowed text-text-muted opacity-40"
                : active
                  ? "bg-bg-elevated text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
            }`
          : `relative flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-ui transition-colors ${
              disabled
                ? "cursor-not-allowed border-transparent text-text-muted opacity-40"
                : active
                  ? "border-accent-green text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-secondary"
            }`
      }
    >
      <Icon size={compact ? 12 : 11} />
      {/* Only the active tab spells out its label so six panels still fit at
          the dock's minimum width; every tab keeps an aria-label. */}
      {!compact && active && <span>{panel.label}</span>}
      {panel.dot && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-[6px] w-[6px] rounded-full bg-accent-green"
        />
      )}
      {typeof panel.badge === "number" && panel.badge > 0 && (
        <span
          aria-label={`${panel.badge} unreviewed`}
          className={`absolute -right-0.5 -top-0.5 grid place-items-center rounded-full bg-accent-green font-mono text-meta font-semibold leading-none text-bg-primary ${
            compact ? "h-[12px] min-w-[12px] px-[3px]" : "h-[14px] min-w-[14px] px-1"
          }`}
        >
          {panel.badge > 9 ? "9+" : panel.badge}
        </span>
      )}
    </button>
  );

  if (!compact) return button;
  return (
    <Tooltip key={panel.id} side="left" content={title}>
      {button}
    </Tooltip>
  );
}

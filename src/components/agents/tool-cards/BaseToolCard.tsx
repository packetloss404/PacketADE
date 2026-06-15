import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface BaseToolCardProps {
  icon: ReactNode;
  /** Title node — accept a node (not a string) so wrappers can style it
   * differently (font-mono for bash commands, italic for subagent tasks). */
  title: ReactNode;
  /** Tooltip on the title element. */
  titleAttr?: string;
  statusPill: ReactNode;
  /** Optional buttons between the title and the status pill. */
  headerActions?: ReactNode;
  /** Optional row rendered between the header and the body (e.g. cwd / model
   * lines surfaced in verbose mode). */
  subHeader?: ReactNode;
  /** Optional row rendered after the body (e.g. "Sub-agent" footer). */
  footer?: ReactNode;
  /** Chevron renders only when toggleable. Wrapper folds verbosity + content
   * presence into this flag. */
  canToggle: boolean;
  /** Controlled expanded state — wrappers own it so they can also use it to
   * shape the title (e.g. truncate when collapsed). */
  expanded: boolean;
  onToggle: () => void;
  /** Override the chevron aria-labels (default: Expand / Collapse content). */
  toggleLabel?: { expanded: string; collapsed: string };
  /** Body content (rendered when canToggle && expanded). */
  children?: ReactNode;
}

/**
 * Shared shell for in-chat tool-call cards (bash, spawn_subagent, …).
 * Renders the chevron + icon + title + status row, an optional sub-header,
 * the expandable body, and an optional footer. Wrappers own the expanded
 * state plus their content + verbosity-specific logic.
 */
export function BaseToolCard({
  icon,
  title,
  titleAttr,
  statusPill,
  headerActions,
  subHeader,
  footer,
  canToggle,
  expanded,
  onToggle,
  toggleLabel,
  children,
}: BaseToolCardProps) {
  const expandedLabel = toggleLabel?.expanded ?? "Collapse content";
  const collapsedLabel = toggleLabel?.collapsed ?? "Expand content";
  const bodyVisible = canToggle && expanded && children !== undefined;

  return (
    <div className="bg-bg-hover rounded text-[10px] text-text-muted border border-bg-border">
      <div className="flex items-center gap-1.5 px-2 py-1">
        {canToggle ? (
          <button
            type="button"
            onClick={onToggle}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label={expanded ? expandedLabel : collapsedLabel}
          >
            {expanded ? (
              <ChevronDown size={10} />
            ) : (
              <ChevronRight size={10} />
            )}
          </button>
        ) : (
          <span className="w-[10px]" />
        )}
        {icon}
        <span
          className="text-text-primary truncate flex-1 min-w-0"
          title={titleAttr}
        >
          {title}
        </span>
        {headerActions}
        {statusPill}
      </div>
      {subHeader}
      {bodyVisible && children}
      {footer}
    </div>
  );
}

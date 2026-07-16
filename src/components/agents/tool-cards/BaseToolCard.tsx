import { memo } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

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
  /** When true, paint the card with the error chrome so failed calls stand
   * out when scanning a long transcript. */
  isError?: boolean;
  /** Body content (rendered when canToggle && expanded). */
  children?: ReactNode;
}

/**
 * Shared shell for in-chat tool-call cards (bash, spawn_subagent, …).
 * Renders the chevron + icon + title + status row, an optional sub-header,
 * the expandable body, and an optional footer. Wrappers own the expanded
 * state plus their content + verbosity-specific logic.
 */
function BaseToolCardImpl({
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
  isError,
  children,
}: BaseToolCardProps) {
  const expandedLabel = toggleLabel?.expanded ?? "Collapse content";
  const collapsedLabel = toggleLabel?.collapsed ?? "Expand content";
  const bodyVisible = canToggle && expanded && children !== undefined;

  return (
    <div
      className={`rounded text-ui text-text-muted border ${
        isError
          ? "border-accent-red/30 bg-accent-red/5"
          : "border-bg-border bg-bg-hover"
      }`}
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        {canToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? expandedLabel : collapsedLabel}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left hover:text-text-primary transition-colors"
          >
            <ChevronRight
              size={10}
              className={`shrink-0 transition-transform motion-reduce:transition-none ${
                expanded ? "rotate-90" : ""
              }`}
            />
            {icon}
            <span className="text-text-primary truncate min-w-0" title={titleAttr}>
              {title}
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <span className="w-[10px] shrink-0" />
            {icon}
            <span className="text-text-primary truncate min-w-0" title={titleAttr}>
              {title}
            </span>
          </div>
        )}
        {headerActions}
        {statusPill}
      </div>
      {subHeader}
      {bodyVisible && children}
      {footer}
    </div>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const BaseToolCard = memo(BaseToolCardImpl);

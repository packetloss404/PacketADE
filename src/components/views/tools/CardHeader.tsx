import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface CardHeaderProps {
  /** Icon component (e.g. `Key` from lucide-react) or a pre-rendered icon element. */
  icon: LucideIcon | ReactElement;
  /** Tailwind class for the icon color (e.g. "text-accent-amber"). */
  iconColor?: string;
  /** Title text rendered inside the `<h3>`. */
  title: string;
  /** Optional right-aligned content (button, badge, link, …). */
  action?: ReactNode;
  /** Icon size in px; defaults to 12. */
  iconSize?: number;
  /** Override or extend the wrapper class. Defaults to "flex items-center gap-2 mb-3". */
  className?: string;
}

/**
 * Shared header strip for cards in the Tools view. Locks in the canonical
 * pattern: small lucide icon, `text-xs font-semibold` title, optional
 * right-side action. Replaces 6+ near-identical `<div>`/`<h3>` blocks.
 */
export function CardHeader({
  icon,
  iconColor = "text-text-primary",
  title,
  action,
  iconSize = 12,
  className,
}: CardHeaderProps) {
  const iconNode = isValidElement(icon)
    ? icon
    : (() => {
        const IconComp = icon as LucideIcon;
        return <IconComp size={iconSize} className={iconColor} />;
      })();

  const wrapperClass =
    className ??
    (action
      ? "flex items-center justify-between mb-3"
      : "flex items-center gap-2 mb-3");

  if (action) {
    return (
      <div className={wrapperClass}>
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          {iconNode}
          {title}
        </h3>
        {action}
      </div>
    );
  }

  return (
    <div className={wrapperClass}>
      {iconNode}
      <h3 className="text-xs font-semibold text-text-primary">{title}</h3>
    </div>
  );
}

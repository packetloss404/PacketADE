import type { ReactNode } from "react";

type Props = {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ icon, title, description, action, className = "" }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center px-6 py-8 ${className}`}>
      {icon && <div className="opacity-30 mb-2 text-text-secondary">{icon}</div>}
      <div className="text-xs text-text-secondary">{title}</div>
      {description && <div className="text-[11px] text-text-muted mt-1">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

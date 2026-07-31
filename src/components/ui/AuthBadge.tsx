import type { JSX } from "react";
import { AlertCircle, Clock, HelpCircle, Loader2 } from "lucide-react";

export type AuthStatus =
  | "ready"
  | "login_required"
  | "missing_key"
  | "service_down"
  | "coming_soon"
  /** Indeterminate — see `ProviderAuthStatus["unknown"]` in lib/tauri.ts. */
  | "unknown"
  | "loading";

type Props = {
  status: AuthStatus;
  hint?: string;
  className?: string;
};

export function AuthBadge({ status, hint, className = "" }: Props): JSX.Element {
  let icon: JSX.Element;
  let effectiveHint = hint;

  switch (status) {
    case "ready":
      icon = <span className="text-accent-green leading-none">●</span>;
      break;
    case "login_required":
      icon = <span className="text-accent-amber leading-none">○</span>;
      break;
    case "missing_key":
      icon = <AlertCircle size={10} className="text-accent-amber" />;
      break;
    case "service_down":
      icon = <AlertCircle size={10} className="text-accent-red" />;
      break;
    case "coming_soon":
      icon = <Clock size={10} className="text-text-muted" />;
      if (!effectiveHint) effectiveHint = "Coming soon";
      break;
    case "unknown":
      // Neutral, not alarming: we couldn't verify, which is not the same as
      // "logged out". Never render this as a failure.
      icon = <HelpCircle size={10} className="text-text-muted" />;
      if (!effectiveHint) effectiveHint = "Status unverifiable";
      break;
    case "loading":
      icon = <Loader2 size={10} className="text-text-muted animate-spin" />;
      effectiveHint = undefined;
      break;
  }

  return (
    <span className={`inline-flex items-center gap-1 text-[10px] ${className}`}>
      {icon}
      {effectiveHint && <span className="text-text-muted text-[10px]">{effectiveHint}</span>}
    </span>
  );
}

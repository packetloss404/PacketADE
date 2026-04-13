import { Loader2, Check, X, Minus } from "lucide-react";
import type { ConnectionStep } from "@/types/server";

interface ConnectionProgressProps {
  steps: ConnectionStep[];
  onRetry?: () => void;
}

export function ConnectionProgress({ steps, onRetry }: ConnectionProgressProps) {
  const hasError = steps.some((s) => s.status === "error");

  return (
    <div className="space-y-1.5">
      {steps
        .filter((s) => s.status !== "skipped")
        .map((step) => (
          <div key={step.id} className="flex items-start gap-2.5 px-3 py-1.5">
            <div className="mt-0.5 shrink-0">
              {step.status === "pending" && (
                <Minus size={12} className="text-text-muted" />
              )}
              {step.status === "running" && (
                <Loader2 size={12} className="text-accent-blue animate-spin" />
              )}
              {step.status === "success" && (
                <Check size={12} className="text-accent-green" />
              )}
              {step.status === "error" && (
                <X size={12} className="text-accent-red" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <span
                className={`text-[11px] font-medium ${
                  step.status === "error"
                    ? "text-accent-red"
                    : step.status === "success"
                      ? "text-text-primary"
                      : step.status === "running"
                        ? "text-accent-blue"
                        : "text-text-muted"
                }`}
              >
                {step.label}
              </span>
              {step.detail && (
                <p className="text-[10px] text-text-muted mt-0.5 truncate">{step.detail}</p>
              )}
            </div>
          </div>
        ))}

      {hasError && onRetry && (
        <div className="px-3 pt-2">
          <button
            onClick={onRetry}
            className="px-3 py-1.5 text-[11px] text-accent-amber bg-accent-amber/10 border border-accent-amber/30 rounded hover:bg-accent-amber/20 transition-colors"
          >
            Retry Connection
          </button>
        </div>
      )}
    </div>
  );
}

import { X } from "lucide-react";

// v0.8-D — inline feedback descriptor surfaced by the issue / investigation
// action rows when a CTA finishes. `tone` drives color; optional `linkLabel`
// + `onLinkClick` render a small affordance (e.g. "View") that takes the
// user to wherever the action's downstream artefact lives.
export type CtaFeedback = {
  tone: "success" | "error" | "info";
  message: string;
  linkLabel?: string;
  onLinkClick?: () => void;
} | null;

// v0.8-D — slim inline status strip rendered under issue/investigation
// action bars when a CTA completes. Color follows `tone`; the optional
// `linkLabel`/`onLinkClick` render a small View affordance.
export function CtaFeedbackRow({
  feedback,
  onDismiss,
}: {
  feedback: NonNullable<CtaFeedback>;
  onDismiss: () => void;
}) {
  const toneCls =
    feedback.tone === "success"
      ? "bg-accent-green/10 border-accent-green/20 text-accent-green"
      : feedback.tone === "error"
        ? "bg-accent-red/10 border-accent-red/20 text-accent-red"
        : "bg-accent-blue/10 border-accent-blue/20 text-accent-blue";
  return (
    <div
      className={`flex items-center gap-2 px-4 py-1.5 border-b text-[10.5px] ${toneCls}`}
    >
      <span className="flex-1 truncate font-mono">{feedback.message}</span>
      {feedback.linkLabel && feedback.onLinkClick && (
        <button
          type="button"
          onClick={feedback.onLinkClick}
          className="underline hover:opacity-80 px-1 font-medium"
        >
          {feedback.linkLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="opacity-60 hover:opacity-100"
        title="Dismiss"
      >
        <X size={11} />
      </button>
    </div>
  );
}

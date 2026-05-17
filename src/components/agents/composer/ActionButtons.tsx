import { Mic, Send } from "lucide-react";

interface ActionButtonsProps {
  isSupported: boolean;
  isListening: boolean;
  startListening: () => void;
  stopListening: () => void;
  launchReady: boolean;
  launchLabel: string;
  launchTitle: string;
  onLaunch: () => void;
}

export function ActionButtons({
  isSupported,
  isListening,
  startListening,
  stopListening,
  launchReady,
  launchLabel,
  launchTitle,
  onLaunch,
}: ActionButtonsProps) {
  return (
    <div className="flex items-center gap-1">
      {isSupported && (
        <button
          onClick={isListening ? stopListening : startListening}
          className={`p-1.5 rounded-full transition-colors ${
            isListening
              ? "bg-accent-green/20 text-accent-green animate-pulse"
              : "text-text-muted hover:text-text-secondary"
          }`}
          title={isListening ? "Stop listening" : "Voice input"}
        >
          <Mic size={14} />
        </button>
      )}

      {/* Launch button — gated on provider auth status. The submitInFlight
          guard inside `onLaunch` blocks rapid mashing across both Enter and
          click paths. */}
      <button
        onClick={() => {
          if (launchReady) onLaunch();
        }}
        disabled={!launchReady}
        title={launchTitle}
        className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
          launchReady
            ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
            : "bg-bg-hover text-text-muted cursor-not-allowed"
        }`}
      >
        <Send size={10} />
        {launchLabel}
      </button>
    </div>
  );
}

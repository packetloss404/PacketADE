import { useState } from "react";
import { Send } from "lucide-react";
import { writePty } from "@/lib/tauri";
import type { Workspace } from "@/types/workspace";

interface BroadcastBarProps {
  workspace: Workspace;
}

export function BroadcastBar({ workspace }: BroadcastBarProps) {
  const [prompt, setPrompt] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);

  async function handleBroadcast() {
    const text = prompt.trim();
    if (!text) return;

    setBroadcasting(true);
    try {
      const activePanes = workspace.panes.filter((p) => p.sessionId);
      await Promise.all(
        activePanes.map((pane) =>
          writePty(pane.sessionId!, text + "\n").catch(() => {})
        )
      );
      setPrompt("");
    } finally {
      setBroadcasting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleBroadcast();
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-tertiary border-b border-bg-border">
      <span className="text-[10px] text-text-muted whitespace-nowrap">Broadcast:</span>
      <input
        type="text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send prompt to all agents..."
        className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
        disabled={broadcasting}
      />
      <button
        onClick={handleBroadcast}
        disabled={broadcasting || !prompt.trim()}
        className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-40"
        title="Broadcast to all agents"
      >
        <Send size={12} />
      </button>
    </div>
  );
}

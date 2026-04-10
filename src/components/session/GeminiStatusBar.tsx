import { MessageSquare } from "lucide-react";
import { useGeminiStatusLineForCwd } from "@/hooks/useStatusLine";

interface GeminiStatusBarProps {
  projectPath: string;
}

export function GeminiStatusBar({ projectPath }: GeminiStatusBarProps) {
  const data = useGeminiStatusLineForCwd(projectPath);

  if (!data) {
    return (
      <div className="flex items-center gap-3 px-3 text-[10px] bg-bg-secondary border-t border-bg-border select-none" style={{ height: 20, minHeight: 20 }}>
        <span className="text-accent-blue font-medium">Gemini CLI</span>
        <span className="flex items-center gap-1 text-text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
          running
        </span>
      </div>
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const isStale = nowSec - data.timestamp > 30;

  return (
    <div
      className="flex items-center gap-3 px-3 text-[11px] bg-bg-secondary border-t border-bg-border select-none"
      style={{ height: 20, minHeight: 20, opacity: isStale ? 0.5 : 1 }}
    >
      <span style={{ color: "#8ab4f8" }}>{data.model}</span>
      <span className="flex items-center gap-1 text-text-muted">
        <MessageSquare size={10} />
        {data.message_count} msg{data.message_count !== 1 ? "s" : ""}
      </span>
      <span className="text-text-muted">{data.last_role}</span>
    </div>
  );
}

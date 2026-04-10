import { useOpenCodeStatusLineForCwd } from "@/hooks/useStatusLine";

interface OpenCodeStatusBarProps {
  projectPath: string;
}

export function OpenCodeStatusBar({ projectPath }: OpenCodeStatusBarProps) {
  const data = useOpenCodeStatusLineForCwd(projectPath);

  if (!data) {
    return (
      <div className="flex items-center gap-3 px-3 text-[10px] bg-bg-secondary border-t border-bg-border select-none" style={{ height: 20, minHeight: 20 }}>
        <span className="text-accent-green font-medium">OpenCode</span>
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
      <span style={{ color: "#3fb950" }}>{data.model}</span>
      <span className="text-text-muted">{data.provider}</span>
    </div>
  );
}

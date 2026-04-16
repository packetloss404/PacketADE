import { ShieldAlert, Check, X } from "lucide-react";

interface PermissionPromptProps {
  item: { id: string; name: string; arguments: string };
  onAllowOnce: (toolId: string) => void;
  onAllowAlways: (toolId: string) => void;
  onDeny: (toolId: string) => void;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function PermissionPrompt({ item, onAllowOnce, onAllowAlways, onDeny }: PermissionPromptProps) {
  return (
    <div className="bg-bg-secondary border border-accent-amber/40 rounded p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} className="text-accent-amber shrink-0" />
        <span className="text-xs text-text-primary">
          Run <code className="font-mono text-accent-amber">{item.name}</code>?
        </span>
      </div>
      <pre className="text-[10px] font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
        {prettyJson(item.arguments)}
      </pre>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => onAllowOnce(item.id)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          <Check size={12} /> Allow once
        </button>
        <button
          type="button"
          onClick={() => onAllowAlways(item.id)}
          className="text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          Always allow
        </button>
        <button
          type="button"
          onClick={() => onDeny(item.id)}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10"
        >
          <X size={12} /> Deny
        </button>
      </div>
    </div>
  );
}

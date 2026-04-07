import { useEffect, useRef, useState } from "react";
import { Eye, X } from "lucide-react";
import { readPtyTranscript } from "../../lib/tauri";

interface SessionInspectProps {
  sessionId: string;
  onClose?: () => void;
}

export function SessionInspect({ sessionId, onClose }: SessionInspectProps) {
  const [data, setData] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const transcript = await readPtyTranscript(sessionId);
        if (cancelled) return;
        setData(transcript.data);
        setTruncated(transcript.truncated);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(typeof err === "string" ? err : String(err));
      }
    };

    load();
    const interval = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId]);

  useEffect(() => {
    // Auto-scroll to bottom as new data streams in
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [data]);

  const shortId = sessionId.slice(0, 8);

  return (
    <div className="flex flex-col h-full bg-bg-primary border border-border-subtle rounded">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-bg-secondary">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Eye size={14} className="text-accent-green" />
          <span className="font-mono">{shortId}</span>
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-bg-primary text-accent-green border border-accent-green/40">
            Read Only
          </span>
          {truncated && (
            <span className="text-[10px] text-text-tertiary">truncated</span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close inspector"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <pre
        ref={preRef}
        className="flex-1 overflow-auto bg-bg-primary text-text-primary text-xs font-mono p-3 whitespace-pre-wrap break-words"
      >
        {error ? (
          <span className="text-accent-red">Failed to load transcript: {error}</span>
        ) : data.length === 0 ? (
          <span className="text-text-tertiary">No transcript data yet.</span>
        ) : (
          data
        )}
      </pre>
    </div>
  );
}

export default SessionInspect;

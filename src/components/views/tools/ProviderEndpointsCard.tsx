import { useEffect, useState } from "react";
import { Check, RotateCcw, Server } from "lucide-react";
import { getOllamaBaseUrl, setOllamaBaseUrl } from "@/lib/tauri";

export function ProviderEndpointsCard() {
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [draftUrl, setDraftUrl] = useState("http://localhost:11434");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOllamaBaseUrl()
      .then((url) => {
        if (cancelled) return;
        setOllamaUrl(url);
        setDraftUrl(url);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    const next = draftUrl.trim();
    if (!next) return;

    setStatus("saving");
    setError(null);
    try {
      const effective = await setOllamaBaseUrl(next);
      setOllamaUrl(effective);
      setDraftUrl(effective);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  async function handleReset() {
    setStatus("saving");
    setError(null);
    try {
      const effective = await setOllamaBaseUrl(null);
      setOllamaUrl(effective);
      setDraftUrl(effective);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  const hasChanges = draftUrl.trim() !== ollamaUrl;

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Server size={12} className="text-accent-blue" />
        Provider Endpoints
      </h3>

      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="ollama-base-url" className="text-[11px] text-text-secondary">
              Ollama base URL
            </label>
            <span className="text-[10px] text-text-muted">Default: http://localhost:11434</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              id="ollama-base-url"
              type="url"
              value={draftUrl}
              onChange={(e) => {
                setDraftUrl(e.target.value);
                setStatus("idle");
                setError(null);
              }}
              placeholder="http://localhost:11434"
              className="flex-1 min-w-0 bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
            />
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!hasChanges || status === "saving" || !draftUrl.trim()}
              className="p-1.5 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
              title="Save Ollama URL"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={status === "saving"}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded disabled:opacity-40 transition-colors"
              title="Reset Ollama URL"
            >
              <RotateCcw size={12} />
            </button>
          </div>
        </div>

        <div className="text-[10px] text-text-muted bg-bg-primary border border-bg-border rounded px-3 py-2">
          API chat uses <span className="text-text-secondary">{ollamaUrl}/v1</span>; model discovery uses{" "}
          <span className="text-text-secondary">{ollamaUrl}/api/tags</span>.
        </div>

        {status === "saved" && (
          <div className="text-[10px] text-accent-green">Ollama endpoint saved.</div>
        )}
        {error && <div className="text-[10px] text-accent-red">{error}</div>}
      </div>
    </div>
  );
}

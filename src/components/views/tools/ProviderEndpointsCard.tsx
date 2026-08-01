import { useEffect, useState, type ReactNode } from "react";
import { Check, RotateCcw, Server } from "lucide-react";
import {
  getMinimaxBaseUrl,
  getOllamaBaseUrl,
  setMinimaxBaseUrl,
  setOllamaBaseUrl,
} from "@/lib/tauri";

type EndpointRowProps = {
  id: string;
  label: string;
  /** The built-in default, shown as a hint and used as the input placeholder. */
  fallback: string;
  load: () => Promise<string>;
  save: (baseUrl: string | null) => Promise<string>;
  /** Rendered under the input to explain what the saved value is used for. */
  describe: (effective: string) => ReactNode;
};

/**
 * One editable provider base URL. Both rows behave identically — load the
 * effective value on mount, save a backend-normalized override, reset back to
 * the built-in default — so the behaviour lives here once rather than being
 * duplicated per provider.
 */
function EndpointRow({ id, label, fallback, load, save, describe }: EndpointRowProps) {
  const [effective, setEffective] = useState(fallback);
  const [draft, setDraft] = useState(fallback);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((url) => {
        if (cancelled) return;
        setEffective(url);
        setDraft(url);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function apply(next: string | null) {
    setStatus("saving");
    setError(null);
    try {
      const applied = await save(next);
      setEffective(applied);
      setDraft(applied);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  const hasChanges = draft.trim() !== effective;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="text-[11px] text-text-secondary">
          {label}
        </label>
        <span className="text-[10px] text-text-muted">Default: {fallback}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="url"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setStatus("idle");
            setError(null);
          }}
          placeholder={fallback}
          className="flex-1 min-w-0 bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
        />
        <button
          type="button"
          onClick={() => void apply(draft.trim())}
          disabled={!hasChanges || status === "saving" || !draft.trim()}
          className="p-1.5 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          title={`Save ${label}`}
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => void apply(null)}
          disabled={status === "saving"}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded disabled:opacity-40 transition-colors"
          title={`Reset ${label}`}
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <div className="mt-1.5 text-[10px] text-text-muted bg-bg-primary border border-bg-border rounded px-3 py-2">
        {describe(effective)}
      </div>
      {status === "saved" && <div className="mt-1 text-[10px] text-accent-green">Saved.</div>}
      {error && <div className="mt-1 text-[10px] text-accent-red">{error}</div>}
    </div>
  );
}

export function ProviderEndpointsCard() {
  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Server size={12} className="text-accent-blue" />
        Provider Endpoints
      </h3>

      <div className="space-y-4">
        <EndpointRow
          id="ollama-base-url"
          label="Ollama base URL"
          fallback="http://localhost:11434"
          load={getOllamaBaseUrl}
          save={setOllamaBaseUrl}
          describe={(url) => (
            <>
              API chat uses <span className="text-text-secondary">{url}/v1</span>; model discovery
              uses <span className="text-text-secondary">{url}/api/tags</span>.
            </>
          )}
        />

        <EndpointRow
          id="minimax-base-url"
          label="MiniMax base URL"
          fallback="https://api.minimax.io/v1"
          load={getMinimaxBaseUrl}
          save={setMinimaxBaseUrl}
          describe={(url) => (
            <>
              MiniMax chat uses <span className="text-text-secondary">{url}</span>. Mainland-China
              accounts must switch this to{" "}
              <span className="text-text-secondary">https://api.minimaxi.com/v1</span> — a key is
              valid against only one host.
            </>
          )}
        />
      </div>
    </div>
  );
}

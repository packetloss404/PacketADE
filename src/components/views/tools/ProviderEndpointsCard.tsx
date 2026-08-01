import { useEffect, useState, type ReactNode } from "react";
import { Check, RotateCcw, Server } from "lucide-react";
import {
  getMinimaxBaseUrl,
  getOllamaBaseUrl,
  getOllamaRuntimeOptions,
  setMinimaxBaseUrl,
  setOllamaBaseUrl,
  setOllamaRuntimeOptions,
  type OllamaRuntimeOptions,
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

/**
 * Ollama's two local-runtime knobs. They live here rather than in a generic
 * settings slice because they are meaningless for any other provider: only the
 * native `/api/chat` route can carry them, and getting them wrong is invisible
 * — an under-sized context window makes Ollama drop the oldest messages with
 * no error, which reads as model stupidity rather than misconfiguration.
 */
function OllamaRuntimeRow() {
  const [options, setOptions] = useState<OllamaRuntimeOptions | null>(null);
  const [capDraft, setCapDraft] = useState("");
  const [keepAliveDraft, setKeepAliveDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  function adopt(next: OllamaRuntimeOptions) {
    setOptions(next);
    setCapDraft(String(next.numCtxCap));
    setKeepAliveDraft(next.keepAlive);
  }

  useEffect(() => {
    let cancelled = false;
    getOllamaRuntimeOptions()
      .then((next) => {
        if (!cancelled) adopt(next);
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

  async function apply(cap: number | null, keepAlive: string | null) {
    setStatus("saving");
    setError(null);
    try {
      adopt(await setOllamaRuntimeOptions(cap, keepAlive));
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  const parsedCap = Number.parseInt(capDraft, 10);
  const capValid = Number.isFinite(parsedCap) && parsedCap > 0;
  const hasChanges =
    options !== null &&
    (String(options.numCtxCap) !== capDraft.trim() ||
      options.keepAlive !== keepAliveDraft.trim());

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-text-secondary">Ollama local runtime</span>
        <span className="text-[10px] text-text-muted">
          Defaults: {options?.defaultNumCtxCap ?? 16384} tokens,{" "}
          {options?.defaultKeepAlive ?? "30m"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor="ollama-num-ctx-cap" className="sr-only">
          Ollama context cap
        </label>
        <input
          id="ollama-num-ctx-cap"
          type="number"
          min={2048}
          step={1024}
          value={capDraft}
          onChange={(e) => {
            setCapDraft(e.target.value);
            setStatus("idle");
            setError(null);
          }}
          placeholder="16384"
          className="flex-1 min-w-0 bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
        />
        <label htmlFor="ollama-keep-alive" className="sr-only">
          Ollama keep-alive
        </label>
        <input
          id="ollama-keep-alive"
          type="text"
          value={keepAliveDraft}
          onChange={(e) => {
            setKeepAliveDraft(e.target.value);
            setStatus("idle");
            setError(null);
          }}
          placeholder="30m"
          className="w-20 shrink-0 bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
        />
        <button
          type="button"
          onClick={() => void apply(parsedCap, keepAliveDraft.trim())}
          disabled={!hasChanges || !capValid || status === "saving" || !keepAliveDraft.trim()}
          className="p-1.5 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          title="Save Ollama runtime options"
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => void apply(null, null)}
          disabled={status === "saving"}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded disabled:opacity-40 transition-colors"
          title="Reset Ollama runtime options"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <div className="mt-1.5 text-[10px] text-text-muted bg-bg-primary border border-bg-border rounded px-3 py-2">
        Context cap (tokens) and keep-alive, sent as{" "}
        <span className="text-text-secondary">options.num_ctx</span> and{" "}
        <span className="text-text-secondary">keep_alive</span> on every request. The cap is a
        ceiling — a model with a smaller trained window uses its own. Ollama&apos;s default window
        is 4096 tokens and it drops older messages <em>silently</em> when a prompt exceeds it, so
        too low is worse than too high. Raising the cap costs VRAM (roughly 128 KiB per token on a
        7–8B model).
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
              API chat uses the native <span className="text-text-secondary">{url}/api/chat</span>{" "}
              (the only route that accepts num_ctx / keep_alive); model discovery uses{" "}
              <span className="text-text-secondary">{url}/api/tags</span>. Endpoints without{" "}
              <span className="text-text-secondary">/api/chat</span> fall back to{" "}
              <span className="text-text-secondary">{url}/v1</span>, where the context window
              cannot be set.
            </>
          )}
        />

        <OllamaRuntimeRow />

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

import { useState, useEffect } from "react";
import { Key, Check, X, Eye, EyeOff, Trash2 } from "lucide-react";
import { setApiKey, getApiKeyExists, deleteApiKey } from "@/lib/tauri";
import { CardHeader } from "./CardHeader";

interface ProviderEntry {
  id: string;
  name: string;
  description: string;
  needsKey: boolean;
}

const PROVIDERS: ProviderEntry[] = [
  { id: "anthropic", name: "Anthropic", description: "Claude Opus, Sonnet, Haiku", needsKey: true },
  { id: "openai", name: "OpenAI", description: "GPT-5.5, GPT-4o, o3", needsKey: true },
  { id: "minimax", name: "MiniMax (Token Plan)", description: "Coding/Token Plan key · M3, M2.5, M2", needsKey: true },
  { id: "openrouter", name: "OpenRouter", description: "100+ models, one key", needsKey: true },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Used for dictation post-processing and other Gemini-powered features.",
    needsKey: true,
  },
  { id: "ollama", name: "Ollama", description: "Local models, no key needed", needsKey: false },
];

export function ApiKeysCard() {
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadStatus();
  }, []);

  async function loadStatus() {
    const status: Record<string, boolean> = {};
    for (const p of PROVIDERS) {
      try {
        status[p.id] = await getApiKeyExists(p.id);
      } catch {
        status[p.id] = false;
      }
    }
    setKeyStatus(status);
  }

  async function handleSave(providerId: string) {
    if (!inputValue.trim()) return;
    setSaving(true);
    try {
      await setApiKey(providerId, inputValue.trim());
      setKeyStatus((s) => ({ ...s, [providerId]: true }));
      setEditing(null);
      setInputValue("");
    } catch (err) {
      console.error("Failed to save API key:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(providerId: string) {
    try {
      await deleteApiKey(providerId);
      setKeyStatus((s) => ({ ...s, [providerId]: false }));
    } catch (err) {
      console.error("Failed to delete API key:", err);
    }
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <CardHeader
        icon={Key}
        iconColor="text-accent-amber"
        title="API Keys"
        className="flex items-center gap-2 mb-4"
      />

      <p className="text-[10px] text-text-muted mb-4">
        Configure API keys for each provider. Keys are stored securely in your OS credential store.
      </p>

      <div className="flex flex-col gap-2">
        {PROVIDERS.map((provider) => (
          <div
            key={provider.id}
            className="flex items-center gap-3 bg-bg-primary border border-bg-border rounded-lg px-3 py-2.5"
          >
            {/* Status dot */}
            <div
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                keyStatus[provider.id] ? "bg-accent-green" : "bg-text-muted/30"
              }`}
            />

            {/* Provider info */}
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-medium text-text-primary">{provider.name}</div>
              <div className="text-[10px] text-text-muted">{provider.description}</div>
            </div>

            {/* Actions */}
            {editing === provider.id ? (
              <div className="flex items-center gap-1.5">
                <div className="relative">
                  <input
                    type={showValue ? "text" : "password"}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="sk-..."
                    className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green w-48 pr-7"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSave(provider.id);
                      if (e.key === "Escape") {
                        setEditing(null);
                        setInputValue("");
                      }
                    }}
                    autoFocus
                  />
                  <button
                    onClick={() => setShowValue(!showValue)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                  >
                    {showValue ? <EyeOff size={10} /> : <Eye size={10} />}
                  </button>
                </div>
                <button
                  onClick={() => void handleSave(provider.id)}
                  disabled={saving || !inputValue.trim()}
                  className="p-1 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-50"
                >
                  <Check size={11} />
                </button>
                <button
                  onClick={() => {
                    setEditing(null);
                    setInputValue("");
                  }}
                  className="p-1 text-text-muted hover:text-text-primary"
                >
                  <X size={11} />
                </button>
              </div>
            ) : provider.needsKey ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    setEditing(provider.id);
                    setInputValue("");
                    setShowValue(false);
                  }}
                  className="px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
                >
                  {keyStatus[provider.id] ? "Update" : "Set Key"}
                </button>
                {keyStatus[provider.id] && (
                  <button
                    onClick={() => void handleDelete(provider.id)}
                    className="p-1 text-text-muted hover:text-accent-red transition-colors"
                  >
                    <Trash2 size={10} />
                  </button>
                )}
              </div>
            ) : (
              <span className="text-[10px] text-accent-green">Ready</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

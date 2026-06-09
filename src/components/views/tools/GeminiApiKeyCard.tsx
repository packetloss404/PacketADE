import { useState, useEffect } from "react";
import { Key, ArrowRight } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { getApiKeyExists, setApiKey } from "@/lib/tauri";
import { LEGACY_STORAGE_PREFIX, storageKey } from "@/lib/brand";

const GEMINI_PROVIDER = "gemini";
const GEMINI_API_KEY_STORAGE_KEY = storageKey("gemini-api-key");
const LEGACY_GEMINI_API_KEY_STORAGE_KEY = `${LEGACY_STORAGE_PREFIX}gemini-api-key`;

export function GeminiApiKeyCard() {
  const setActiveView = useAppStore((s) => s.setActiveView);
  const [geminiKeySaved, setGeminiKeySaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadGeminiKeyStatus = async () => {
      // One-shot migration from legacy localStorage to the OS keyring.
      const legacySaved =
        localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY)?.trim() ||
        localStorage.getItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY)?.trim() ||
        "";

      if (legacySaved) {
        try {
          if (await getApiKeyExists(GEMINI_PROVIDER)) {
            localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
            localStorage.removeItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY);
            if (!cancelled) setGeminiKeySaved(true);
            return;
          }

          await setApiKey(GEMINI_PROVIDER, legacySaved);
          localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
          localStorage.removeItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY);
        } catch (error) {
          console.warn("Failed to migrate Gemini API key to keyring", error);
        }
      }

      try {
        const exists = await getApiKeyExists(GEMINI_PROVIDER);
        if (!cancelled) setGeminiKeySaved(exists);
      } catch (error) {
        console.warn("Failed to check Gemini API key status", error);
      }
    };
    void loadGeminiKeyStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2 mb-3">
        <Key size={12} className="text-accent-amber" />
        Gemini API (Enhanced Transcription)
      </h3>
      <p className="text-[10px] text-text-muted mb-3">
        Optionally use Google Gemini to post-process Whisper transcriptions for better accuracy
        with code terms, formatting, and punctuation.
      </p>
      <div className="flex items-center gap-2">
        <div
          className={`w-2 h-2 rounded-full shrink-0 ${
            geminiKeySaved ? "bg-accent-green" : "bg-text-muted/30"
          }`}
        />
        <span className="text-[11px] text-text-secondary flex-1">
          {geminiKeySaved ? "Configured" : "Not configured"}
        </span>
        <button
          onClick={() => setActiveView("tools")}
          className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
        >
          Manage in Settings &gt; API Keys
          <ArrowRight size={10} />
        </button>
      </div>
    </div>
  );
}

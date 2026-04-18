import { useState, useEffect } from "react";
import { Mic, Download, Check, X, Plus, ExternalLink, Keyboard, Key } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import { useAppStore } from "@/stores/appStore";
import { listAudioDevices } from "@/lib/tauri";
import type { AudioDevice } from "@/types/dictation";

export function DictationCard() {
  const models = useDictationStore((s) => s.models);
  const settings = useDictationStore((s) => s.settings);
  const loadModels = useDictationStore((s) => s.loadModels);
  const loadSettings = useDictationStore((s) => s.loadSettings);
  const updateSettings = useDictationStore((s) => s.updateSettings);
  const downloadModel = useDictationStore((s) => s.downloadModel);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [newWord, setNewWord] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [geminiKeySaved, setGeminiKeySaved] = useState(false);

  useEffect(() => {
    loadModels();
    loadSettings();
    listAudioDevices()
      .then((raw) => {
        const parsed: AudioDevice[] = typeof raw === "string" ? JSON.parse(raw) : raw;
        setDevices(parsed);
      })
      .catch(() => {});
    // Load saved Gemini key indicator
    const saved = localStorage.getItem("packetade:gemini-api-key");
    if (saved) setGeminiKeySaved(true);
  }, [loadModels, loadSettings]);

  const handleDeviceChange = (idx: number) => {
    if (!settings) return;
    updateSettings({ ...settings, deviceIndex: idx });
  };

  const handleAutoPasteToggle = () => {
    if (!settings) return;
    updateSettings({ ...settings, autoPaste: !settings.autoPaste });
  };

  const handleAddWord = () => {
    if (!newWord.trim() || !settings) return;
    updateSettings({
      ...settings,
      customDictionary: [...(settings.customDictionary ?? []), newWord.trim()],
    });
    setNewWord("");
  };

  const handleRemoveWord = (word: string) => {
    if (!settings) return;
    updateSettings({
      ...settings,
      customDictionary: (settings.customDictionary ?? []).filter((w) => w !== word),
    });
  };

  const handleSaveGeminiKey = () => {
    if (!geminiKey.trim()) return;
    localStorage.setItem("packetade:gemini-api-key", geminiKey.trim());
    setGeminiKeySaved(true);
    setGeminiKey("");
  };

  const handleClearGeminiKey = () => {
    localStorage.removeItem("packetade:gemini-api-key");
    setGeminiKeySaved(false);
  };

  return (
    <div className="space-y-4">
      {/* Main settings card */}
      <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
            <Mic size={12} className="text-accent-purple" />
            VibeToText
          </h3>
          <button
            onClick={() => setActiveView("dictation")}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-purple hover:bg-accent-purple/10 rounded transition-colors"
          >
            <ExternalLink size={11} />
            Open VT
          </button>
        </div>

        {/* Models */}
        <div className="mb-4">
          <div className="text-[10px] text-text-muted mb-2 uppercase tracking-wider">Whisper Models</div>
          <div className="flex flex-col gap-1.5">
            {models.map((m) => (
              <div
                key={m.size}
                className="flex items-center justify-between bg-bg-primary border border-bg-border rounded-lg px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-text-primary font-medium capitalize">{m.size}</span>
                  <span className="text-[9px] text-text-muted">{m.fileSizeMb} MB</span>
                </div>
                {m.downloaded ? (
                  <span className="flex items-center gap-1 text-[10px] text-accent-green">
                    <Check size={10} />
                    Ready
                  </span>
                ) : (
                  <button
                    onClick={() => downloadModel(m.size)}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-accent-purple hover:bg-accent-purple/10 rounded transition-colors"
                  >
                    <Download size={10} />
                    Download
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Microphone selector */}
        <div className="mb-4">
          <div className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">Microphone</div>
          <select
            value={settings?.deviceIndex ?? ""}
            onChange={(e) => handleDeviceChange(Number(e.target.value))}
            className="w-full bg-bg-primary border border-bg-border rounded-lg px-3 py-1.5 text-[11px] text-text-primary focus:outline-none focus:border-accent-green"
          >
            <option value="">Default</option>
            {devices.map((d) => (
              <option key={d.index} value={d.index}>
                {d.name}{d.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Auto-paste toggle */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-[11px] text-text-secondary">Auto-paste after transcription</span>
          <button
            onClick={handleAutoPasteToggle}
            className={`w-8 h-4 rounded-full transition-colors relative ${
              settings?.autoPaste ? "bg-accent-green" : "bg-bg-border"
            }`}
          >
            <div
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                settings?.autoPaste ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        {/* Custom dictionary */}
        <div>
          <div className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">Custom Dictionary</div>
          <div className="flex items-center gap-1.5 mb-2">
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddWord()}
              placeholder="Add word..."
              className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
            />
            <button
              onClick={handleAddWord}
              className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors"
            >
              <Plus size={12} />
            </button>
          </div>
          {settings && settings.customDictionary && settings.customDictionary.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {settings.customDictionary.map((word) => (
                <span
                  key={word}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-bg-elevated text-text-secondary rounded"
                >
                  {word}
                  <button
                    onClick={() => handleRemoveWord(word)}
                    className="text-text-muted hover:text-accent-red transition-colors"
                  >
                    <X size={8} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Keyboard Shortcuts card */}
      <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2 mb-3">
          <Keyboard size={12} className="text-accent-blue" />
          Keyboard Shortcuts
        </h3>
        <div className="space-y-2">
          <ShortcutRow label="Push to Talk (hold)" shortcut="Ctrl+Shift+V" />
          <ShortcutRow label="Toggle Recording" shortcut="Ctrl+Shift+R" />
          <ShortcutRow label="Cancel Recording" shortcut="Escape" />
          <ShortcutRow label="Open VibeToText" shortcut="Ctrl+Shift+D" />
        </div>
        <p className="text-[9px] text-text-muted mt-3">
          Push-to-talk: hold the key to record, release to transcribe and auto-paste.
        </p>
      </div>

      {/* Gemini API Settings card */}
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
          <div className={`w-2 h-2 rounded-full shrink-0 ${geminiKeySaved ? "bg-accent-green" : "bg-text-muted/30"}`} />
          <span className="text-[11px] text-text-secondary flex-1">
            {geminiKeySaved ? "API key configured" : "No API key set"}
          </span>
          {geminiKeySaved ? (
            <button
              onClick={handleClearGeminiKey}
              className="px-2 py-1 text-[10px] text-text-muted hover:text-accent-red transition-colors"
            >
              Clear
            </button>
          ) : null}
        </div>
        {!geminiKeySaved && (
          <div className="flex items-center gap-1.5 mt-2">
            <input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="AIza..."
              className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
              onKeyDown={(e) => e.key === "Enter" && handleSaveGeminiKey()}
            />
            <button
              onClick={handleSaveGeminiKey}
              disabled={!geminiKey.trim()}
              className="px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-50"
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ShortcutRow({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-text-secondary">{label}</span>
      <kbd className="px-1.5 py-0.5 text-[9px] font-mono bg-bg-primary border border-bg-border rounded text-text-muted">
        {shortcut}
      </kbd>
    </div>
  );
}

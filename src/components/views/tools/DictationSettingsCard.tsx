import { useState, useEffect } from "react";
import { Mic, Download, Check, X, Plus, ExternalLink } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import { useAppStore } from "@/stores/appStore";
import { listAudioDevices } from "@/lib/tauri";
import type { AudioDevice } from "@/types/dictation";

export function DictationSettingsCard() {
  const models = useDictationStore((s) => s.models);
  const settings = useDictationStore((s) => s.settings);
  const error = useDictationStore((s) => s.error);
  const modelProgress = useDictationStore((s) => s.modelProgress);
  const loadModels = useDictationStore((s) => s.loadModels);
  const loadSettings = useDictationStore((s) => s.loadSettings);
  const updateSettings = useDictationStore((s) => s.updateSettings);
  const downloadModel = useDictationStore((s) => s.downloadModel);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [newWord, setNewWord] = useState("");

  useEffect(() => {
    loadModels();
    loadSettings();
    listAudioDevices()
      .then((raw) => {
        const parsed: AudioDevice[] = typeof raw === "string" ? JSON.parse(raw) : raw;
        setDevices(parsed);
        setDeviceError(
          parsed.length === 0
            ? "No active microphone is available. Connect or enable an input device in Windows Sound settings."
            : null,
        );
      })
      .catch((err) => setDeviceError(String(err)));
  }, [loadModels, loadSettings]);

  const handleDeviceChange = (idx: number | null) => {
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

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <Mic size={12} className="text-accent-purple" />
          Dictation
        </h3>
        <button
          onClick={() => setActiveView("dictation")}
          className="hover:bg-accent-purple/10 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-purple transition-colors"
        >
          <ExternalLink size={11} />
          Open Dictation
        </button>
      </div>

      {/* Models */}
      <div className="mb-4">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">
          Whisper Models
        </div>
        <div className="flex flex-col gap-1.5">
          {models.map((m) => (
            <div
              key={m.size}
              className={`flex items-center justify-between rounded-lg border bg-bg-primary px-3 py-2 ${
                settings?.modelSize === m.size ? "border-accent-green/60" : "border-bg-border"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium capitalize text-text-primary">
                  {m.size}
                </span>
                <span className="text-[9px] text-text-muted">{m.fileSizeMb} MB</span>
              </div>
              {m.downloaded ? (
                <button
                  onClick={() => settings && updateSettings({ ...settings, modelSize: m.size })}
                  className="flex items-center gap-1 text-[10px] text-accent-green"
                  title={`Use the ${m.size} model`}
                >
                  <Check size={10} />
                  {settings?.modelSize === m.size ? "Selected" : "Use"}
                </button>
              ) : (
                <button
                  onClick={() => downloadModel(m.size)}
                  disabled={modelProgress[m.size] != null && modelProgress[m.size] < 100}
                  className="hover:bg-accent-purple/10 flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-accent-purple transition-colors"
                >
                  <Download size={10} />
                  {modelProgress[m.size] != null && modelProgress[m.size] < 100
                    ? `${modelProgress[m.size]}%`
                    : m.installed
                      ? "Verify"
                      : "Download"}
                </button>
              )}
            </div>
          ))}
        </div>
        {error && <p className="mt-2 text-[10px] text-accent-red">{error}</p>}
      </div>

      {/* Microphone selector */}
      <div className="mb-4">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          Microphone
        </div>
        <select
          value={settings?.deviceIndex ?? ""}
          onChange={(e) =>
            handleDeviceChange(e.target.value === "" ? null : Number(e.target.value))
          }
          className="w-full rounded-lg border border-bg-border bg-bg-primary px-3 py-1.5 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
        >
          <option value="">Default</option>
          {devices.map((d) => (
            <option key={d.index} value={d.index}>
              {d.name}
              {d.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
        {deviceError && <p className="mt-1.5 text-[10px] text-accent-red">{deviceError}</p>}
      </div>

      {/* Language */}
      <div className="mb-4">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">Language</div>
        <select
          value={settings?.language ?? "auto"}
          onChange={(event) =>
            settings && updateSettings({ ...settings, language: event.target.value })
          }
          className="w-full rounded-lg border border-bg-border bg-bg-primary px-3 py-1.5 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
        >
          <option value="auto">Auto-detect</option>
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="it">Italian</option>
          <option value="pt">Portuguese</option>
          <option value="ja">Japanese</option>
          <option value="zh">Chinese</option>
        </select>
      </div>

      {/* Auto-paste toggle */}
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[11px] text-text-secondary">Auto-paste after transcription</span>
        <button
          onClick={handleAutoPasteToggle}
          className={`relative h-4 w-8 rounded-full transition-colors ${
            settings?.autoPaste ? "bg-accent-green" : "bg-bg-border"
          }`}
        >
          <div
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
              settings?.autoPaste ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[11px] text-text-secondary">Paste into other Windows apps</div>
          <div className="text-[9px] text-text-muted">
            Opt-in; otherwise dictation is copied to the clipboard.
          </div>
        </div>
        <button
          onClick={() =>
            settings &&
            updateSettings({
              ...settings,
              systemWidePaste: !settings.systemWidePaste,
            })
          }
          disabled={!settings?.autoPaste}
          className={`relative h-4 w-8 rounded-full transition-colors ${
            settings?.systemWidePaste && settings.autoPaste ? "bg-accent-green" : "bg-bg-border"
          } disabled:opacity-40`}
        >
          <div
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
              settings?.systemWidePaste && settings.autoPaste ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Custom dictionary */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          Custom Dictionary
        </div>
        <div className="mb-2 flex items-center gap-1.5">
          <input
            type="text"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddWord()}
            placeholder="Add word..."
            className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
          />
          <button
            onClick={handleAddWord}
            className="hover:bg-accent-green/10 rounded p-1 text-accent-green transition-colors"
          >
            <Plus size={12} />
          </button>
        </div>
        {settings && settings.customDictionary && settings.customDictionary.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {settings.customDictionary.map((word) => (
              <span
                key={word}
                className="flex items-center gap-1 rounded bg-bg-elevated px-2 py-0.5 text-[10px] text-text-secondary"
              >
                {word}
                <button
                  onClick={() => handleRemoveWord(word)}
                  className="text-text-muted transition-colors hover:text-accent-red"
                >
                  <X size={8} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

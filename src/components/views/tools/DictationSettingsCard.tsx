import { useState, useEffect, useCallback, useRef } from "react";
import {
  Mic,
  Download,
  Check,
  X,
  Plus,
  ExternalLink,
  Stethoscope,
  RotateCw,
  AlertTriangle,
} from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import { useAppStore } from "@/stores/appStore";
import { listAudioDevices, testAudioDevice } from "@/lib/tauri";
import { isWindows } from "@/lib/platform";
import { MAX_WORD_GOAL, type AudioDevice, type AudioDeviceTestResult } from "@/types/dictation";

/** Mirrors `normalize_config` in `src-tauri/src/commands/dictation/config.rs`,
 *  which clamps `max_duration_seconds` to this range. Keep in sync. */
const MIN_CAPTURE_SECONDS = 10;
const MAX_CAPTURE_SECONDS = 1_800;
const CAPTURE_PRESETS = [30, 60, 300, 600, 1_800];

/** Ceiling for the microphone probe round-trip. The backend clamps its own
 *  listen window to 3 s, but opening a stale Bluetooth endpoint can block for
 *  far longer — without this the Test button says "Listening…" forever. */
const DEVICE_TEST_TIMEOUT_MS = 20_000;

function formatCaptureLimit(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Bluetooth headsets enumerate several times under near-identical names
 *  ("Headset (PLT Focus)" / "Headset (PLT Focus Hands-Free)"). Drop exact
 *  duplicate identities and disambiguate the rest by their capture format so
 *  the picker cannot present two indistinguishable rows. */
function buildDeviceOptions(devices: AudioDevice[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const unique = devices.filter((device) => {
    const key = device.id ?? `index:${device.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const nameCounts = new Map<string, number>();
  for (const device of unique) {
    nameCounts.set(device.name, (nameCounts.get(device.name) ?? 0) + 1);
  }

  return unique.map((device) => {
    const parts: string[] = [device.name];
    if (device.isDefault) parts.push("(default)");
    const format: string[] = [];
    if (device.sampleRate) format.push(`${device.sampleRate / 1000} kHz`);
    if (device.channels) format.push(`${device.channels} ch`);
    // Only spend label width on the format when it is needed to tell two
    // same-named endpoints apart, or when it is the sole distinguishing detail.
    const ambiguous = (nameCounts.get(device.name) ?? 0) > 1;
    if (format.length > 0) parts.push(`— ${format.join(", ")}`);
    if (ambiguous) parts.push(`#${device.index}`);
    return { value: device.id ?? `index:${device.index}`, label: parts.join(" ") };
  });
}

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
  const [deviceTest, setDeviceTest] = useState<AudioDeviceTestResult | null>(null);
  const [testingDevice, setTestingDevice] = useState(false);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [newWord, setNewWord] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshDevices = useCallback(async () => {
    setRefreshingDevices(true);
    try {
      const raw = await listAudioDevices();
      const parsed: AudioDevice[] = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!mountedRef.current) return;
      setDevices(parsed);
      setDeviceError(
        parsed.length === 0
          ? "No active microphone is available. Connect or enable an input device in Windows Sound settings."
          : null,
      );
    } catch (err) {
      if (mountedRef.current) setDeviceError(String(err));
    } finally {
      if (mountedRef.current) setRefreshingDevices(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
    loadSettings();
    void refreshDevices();
  }, [loadModels, loadSettings, refreshDevices]);

  const handleDeviceChange = (value: string) => {
    if (!settings) return;
    setDeviceTest(null);
    setDeviceError(null);
    if (!value) {
      void updateSettings({ ...settings, deviceId: null, deviceIndex: null });
      return;
    }
    if (value.startsWith("index:")) {
      void updateSettings({
        ...settings,
        deviceId: null,
        deviceIndex: Number(value.slice("index:".length)),
      });
      return;
    }
    void updateSettings({ ...settings, deviceId: value, deviceIndex: null });
  };

  const handleDeviceTest = async () => {
    setTestingDevice(true);
    setDeviceError(null);
    setDeviceTest(null);
    // Watchdog: a probe that never returns must not leave the button stuck.
    let timedOut = false;
    const watchdog = window.setTimeout(() => {
      timedOut = true;
      if (!mountedRef.current) return;
      setTestingDevice(false);
      setDeviceError(
        `The microphone test did not respond within ${DEVICE_TEST_TIMEOUT_MS / 1000} seconds. The device may be disconnected, out of range, or held exclusively by another application.`,
      );
    }, DEVICE_TEST_TIMEOUT_MS);
    try {
      const result = await testAudioDevice(settings?.deviceId, settings?.deviceIndex, 1_500);
      if (!mountedRef.current) return;
      setDeviceTest(result);
      if (timedOut) setDeviceError(null);
      // The probe reports the identity it actually opened; re-read the device
      // list so a headset that just (dis)appeared is reflected in the picker.
      void refreshDevices();
    } catch (err) {
      if (mountedRef.current) setDeviceError(String(err));
    } finally {
      window.clearTimeout(watchdog);
      if (mountedRef.current) setTestingDevice(false);
    }
  };

  const handleAutoPasteToggle = () => {
    if (!settings) return;
    updateSettings({ ...settings, autoPaste: !settings.autoPaste });
  };

  /** Commit a word goal. Blank and non-numeric input is ignored rather than
   *  written as 0 — 0 is the "no goal" value and must be typed deliberately,
   *  not produced by clearing the field mid-edit. */
  const handleWordGoalChange = (
    key: "dailyWordGoal" | "weeklyWordGoal",
    raw: string,
  ) => {
    if (!settings) return;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || value < 0) return;
    updateSettings({
      ...settings,
      [key]: Math.min(MAX_WORD_GOAL, Math.floor(value)),
    });
  };

  const handleAddWord = () => {
    const word = newWord.trim();
    if (!word || !settings) return;
    const existing = settings.customDictionary ?? [];
    // Duplicates collide on the React key and would be removed in pairs.
    if (existing.some((entry) => entry.toLowerCase() === word.toLowerCase())) {
      setNewWord("");
      return;
    }
    updateSettings({ ...settings, customDictionary: [...existing, word] });
    setNewWord("");
  };

  const handleRemoveWord = (word: string) => {
    if (!settings) return;
    updateSettings({
      ...settings,
      customDictionary: (settings.customDictionary ?? []).filter((w) => w !== word),
    });
  };

  const deviceOptions = buildDeviceOptions(devices);
  const selectedDeviceValue =
    settings?.deviceId ??
    (settings?.deviceIndex != null ? `index:${settings.deviceIndex}` : "");
  // A `<select>` whose value matches no option silently falls back to the first
  // one — the picker would claim "Default" while the saved headset is gone.
  const savedDeviceMissing =
    selectedDeviceValue !== "" &&
    !deviceOptions.some((option) => option.value === selectedDeviceValue);
  // `deliver_dictation_text` only has a native implementation on Windows; on
  // macOS/Linux it returns a typed error and `useDictationTarget` falls back to
  // the webview clipboard. Clipboard delivery therefore still works, but the
  // synthetic Ctrl+V into another application cannot, so the toggle for it is
  // disabled rather than left as a switch that silently never fires.
  const nativePasteSupported = isWindows();
  const captureSeconds = settings?.maxDurationSeconds ?? 300;
  const captureOptions = CAPTURE_PRESETS.includes(captureSeconds)
    ? CAPTURE_PRESETS
    : [...CAPTURE_PRESETS, captureSeconds].sort((a, b) => a - b);
  // The backend falls back to the default input when the saved identity is
  // unavailable, so a green "it works" here can be about a different device.
  const testedFallbackDevice =
    deviceTest != null &&
    settings?.deviceId != null &&
    deviceTest.deviceId !== settings.deviceId;

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <Mic size={12} className="text-accent-purple" aria-hidden="true" />
          Dictation
        </h3>
        <button
          type="button"
          onClick={() => setActiveView("dictation")}
          className="hover:bg-accent-purple/10 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-purple transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-purple"
        >
          <ExternalLink size={11} aria-hidden="true" />
          Open Dictation
        </button>
      </div>

      {/* Dictation-wide errors. These arrive from capture and transcription as
          well as model management, so they do not belong under one section. */}
      {error && (
        <div
          className="mb-4 rounded-lg border border-accent-red/20 bg-accent-red/5 px-3 py-2"
          role="alert"
        >
          <p className="whitespace-pre-wrap break-words text-[10px] text-accent-red">{error}</p>
        </div>
      )}

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
                  type="button"
                  onClick={() => settings && updateSettings({ ...settings, modelSize: m.size })}
                  aria-pressed={settings?.modelSize === m.size}
                  className="flex items-center gap-1 text-[10px] text-accent-green"
                  title={`Use the ${m.size} model`}
                >
                  <Check size={10} aria-hidden="true" />
                  {settings?.modelSize === m.size ? "Selected" : "Use"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => downloadModel(m.size)}
                  disabled={modelProgress[m.size] != null && modelProgress[m.size] < 100}
                  aria-busy={modelProgress[m.size] != null && modelProgress[m.size] < 100}
                  aria-label={`${m.installed ? "Verify" : "Download"} the ${m.size} Whisper model`}
                  className="hover:bg-accent-purple/10 flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-accent-purple transition-colors disabled:opacity-40"
                >
                  <Download size={10} aria-hidden="true" />
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
      </div>

      {/* Microphone selector */}
      <div className="mb-4">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          Microphone
        </div>
        <div className="flex gap-2">
          <select
            value={savedDeviceMissing ? "__missing__" : selectedDeviceValue}
            onChange={(event) => handleDeviceChange(event.target.value)}
            aria-label="Dictation microphone"
            className="min-w-0 flex-1 rounded-lg border border-bg-border bg-bg-primary px-3 py-1.5 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
          >
            <option value="">Default</option>
            {savedDeviceMissing && (
              <option value="__missing__" disabled>
                Saved microphone — not currently present
              </option>
            )}
            {deviceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void refreshDevices()}
            disabled={refreshingDevices}
            aria-label="Re-scan audio input devices"
            title="Re-scan audio input devices"
            className="flex items-center rounded-lg border border-bg-border px-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
          >
            <RotateCw
              size={11}
              className={refreshingDevices ? "animate-spin" : undefined}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            onClick={() => void handleDeviceTest()}
            disabled={testingDevice}
            aria-busy={testingDevice}
            aria-label="Open the selected microphone and report what it delivers"
            className="flex items-center gap-1 rounded-lg border border-bg-border px-2.5 text-[10px] text-accent-purple transition-colors hover:bg-accent-purple/10 disabled:opacity-40"
          >
            <Stethoscope size={11} aria-hidden="true" />
            {testingDevice ? "Listening…" : "Test"}
          </button>
        </div>
        {savedDeviceMissing && (
          <p className="mt-1.5 flex items-start gap-1 text-[10px] text-accent-amber">
            <AlertTriangle size={11} className="mt-[1px] shrink-0" aria-hidden="true" />
            <span>
              The saved microphone is not in the current device list. Recording will fall back to
              the system default. Reconnect it and press re-scan, or pick another device.
            </span>
          </p>
        )}
        {deviceError && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[10px] text-accent-red" role="alert">
            {deviceError}
          </p>
        )}
        {deviceTest && (
          <div className="mt-1.5" role="status" aria-live="polite">
            <p
              className={`text-[10px] ${
                deviceTest.warning || testedFallbackDevice
                  ? "text-accent-amber"
                  : "text-accent-green"
              }`}
            >
              {deviceTest.name}: {deviceTest.sampleRate / 1000} kHz, {deviceTest.channels} ch,{" "}
              {deviceTest.sampleFormat}, peak {Math.round(deviceTest.peakLevel * 100)}%,{" "}
              {deviceTest.capturedFrames.toLocaleString()} frames in {deviceTest.durationMs} ms
              {deviceTest.warning
                ? ` — ${deviceTest.warning}`
                : " — the device opened and delivered audio."}
            </p>
            {testedFallbackDevice && (
              <p className="mt-1 text-[10px] text-accent-amber">
                This result is for a different device than the one saved in settings, so it does not
                confirm the saved microphone works.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mb-4">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          Maximum recording
        </div>
        <select
          value={captureSeconds}
          onChange={(event) =>
            settings &&
            updateSettings({
              ...settings,
              maxDurationSeconds: Number(event.target.value),
            })
          }
          aria-label="Maximum recording length"
          className="w-full rounded-lg border border-bg-border bg-bg-primary px-3 py-1.5 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
        >
          {/* A saved value outside the presets must be shown, not silently
              re-labelled as the first option. */}
          {captureOptions.map((seconds) => (
            <option key={seconds} value={seconds}>
              {formatCaptureLimit(seconds)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[9px] text-text-muted">
          Recording stops and transcribes automatically at this limit. The capture backend clamps
          it to {MIN_CAPTURE_SECONDS} seconds – {MAX_CAPTURE_SECONDS / 60} minutes.
        </p>
      </div>

      {/* Language */}
      <div className="mb-4">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">Language</div>
        <select
          value={settings?.language ?? "auto"}
          onChange={(event) =>
            settings && updateSettings({ ...settings, language: event.target.value })
          }
          aria-label="Transcription language"
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
        <span className="text-[11px] text-text-secondary" id="dictation-auto-paste-label">
          Auto-paste after transcription
        </span>
        <button
          type="button"
          onClick={handleAutoPasteToggle}
          aria-pressed={settings?.autoPaste ?? false}
          aria-labelledby="dictation-auto-paste-label"
          className={`relative h-4 w-8 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green ${
            settings?.autoPaste ? "bg-accent-green" : "bg-bg-border"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-text-primary transition-transform ${
              settings?.autoPaste ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[11px] text-text-secondary" id="dictation-system-paste-label">
            Paste into other apps
          </div>
          <div className="text-[9px] text-text-muted">
            {nativePasteSupported ? (
              <>
                Opt-in; otherwise dictation is copied to the clipboard.
                {!settings?.autoPaste && " Requires auto-paste."}
              </>
            ) : (
              "Windows only. On this system the transcript is copied to the clipboard instead — everything else about dictation works."
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            settings &&
            updateSettings({
              ...settings,
              systemWidePaste: !settings.systemWidePaste,
            })
          }
          disabled={!nativePasteSupported || !settings?.autoPaste}
          title={
            nativePasteSupported
              ? undefined
              : "Native paste into another application is implemented for Windows only."
          }
          aria-pressed={
            (nativePasteSupported && settings?.systemWidePaste && settings.autoPaste) ?? false
          }
          aria-labelledby="dictation-system-paste-label"
          className={`relative h-4 w-8 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green ${
            nativePasteSupported && settings?.systemWidePaste && settings.autoPaste
              ? "bg-accent-green"
              : "bg-bg-border"
          } disabled:opacity-40`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-text-primary transition-transform ${
              nativePasteSupported && settings?.systemWidePaste && settings.autoPaste
                ? "translate-x-4"
                : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Word goals. Previously hardcoded in the backend at 500 / 2500 with no
          control anywhere — a target the user cannot move is not a goal. */}
      <div className="mb-4">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          Word goals
        </div>
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center justify-between gap-2">
            <span className="text-[11px] text-text-secondary">Daily</span>
            <input
              type="number"
              min={0}
              max={MAX_WORD_GOAL}
              step={50}
              value={settings?.dailyWordGoal ?? 0}
              onChange={(event) => handleWordGoalChange("dailyWordGoal", event.target.value)}
              aria-label="Daily word goal"
              className="w-24 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
            />
          </label>
          <label className="flex flex-1 items-center justify-between gap-2">
            <span className="text-[11px] text-text-secondary">Weekly</span>
            <input
              type="number"
              min={0}
              max={MAX_WORD_GOAL}
              step={100}
              value={settings?.weeklyWordGoal ?? 0}
              onChange={(event) => handleWordGoalChange("weeklyWordGoal", event.target.value)}
              aria-label="Weekly word goal"
              className="w-24 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary focus:border-accent-green focus:outline-none"
            />
          </label>
        </div>
        <p className="mt-1 text-[9px] text-text-muted">
          Charted in Dictation → Analytics → Consistency. Set either to 0 to drop
          that goal from the tab.
        </p>
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
            aria-label="Add a word to the custom dictionary"
            className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
          />
          <button
            type="button"
            onClick={handleAddWord}
            aria-label="Add word to custom dictionary"
            className="hover:bg-accent-green/10 rounded p-1 text-accent-green transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green"
          >
            <Plus size={12} aria-hidden="true" />
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
                  type="button"
                  onClick={() => handleRemoveWord(word)}
                  aria-label={`Remove ${word} from the custom dictionary`}
                  className="text-text-muted transition-colors hover:text-accent-red focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-red"
                >
                  <X size={8} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

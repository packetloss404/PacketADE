import { useState, useEffect, useRef, useCallback } from "react";
import { Keyboard, X, RotateCcw, Edit3 } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  DEFAULT_TOGGLE_SHORTCUT,
} from "@/types/dictation";

export function KeyboardShortcutsCard() {
  const settings = useDictationStore((s) => s.settings);
  const loadSettings = useDictationStore((s) => s.loadSettings);
  const updateSettings = useDictationStore((s) => s.updateSettings);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2 mb-3">
        <Keyboard size={12} className="text-accent-blue" />
        Keyboard Shortcuts
      </h3>
      <div className="space-y-2">
        <EditableShortcutRow
          label="Push to Talk (hold)"
          value={settings?.pushToTalkShortcut ?? DEFAULT_PUSH_TO_TALK_SHORTCUT}
          defaultValue={DEFAULT_PUSH_TO_TALK_SHORTCUT}
          onChange={(next) => {
            if (!settings) return;
            void updateSettings({ ...settings, pushToTalkShortcut: next });
          }}
        />
        <EditableShortcutRow
          label="Toggle Recording"
          value={settings?.toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT}
          defaultValue={DEFAULT_TOGGLE_SHORTCUT}
          onChange={(next) => {
            if (!settings) return;
            void updateSettings({ ...settings, toggleShortcut: next });
          }}
        />
        <ShortcutRow label="Cancel Recording" shortcut="Escape" />
        <ShortcutRow label="Open VibeToText" shortcut="Ctrl+Shift+D" />
      </div>
      <p className="text-[9px] text-text-muted mt-3">
        Push-to-talk: hold the key to record, release to transcribe and auto-paste.
        Edit a shortcut and press the new combo (must include a modifier).
      </p>
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

/**
 * Editable global-shortcut row. Displays a human-friendly version of the
 * current accelerator and lets the user re-capture it. Capture mode swallows
 * every keydown until a valid combo (≥ 1 modifier + 1 non-modifier key) is
 * pressed, then commits via `onChange`. Escape cancels capture.
 *
 * `onChange` should persist the new accelerator (the parent does this via
 * `dictationStore.updateSettings`). The store value is observed by
 * `useDictationGlobalShortcuts`, which re-registers automatically — no manual
 * unregister/register needed here.
 */
function EditableShortcutRow({
  label,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  value: string;
  defaultValue: string;
  onChange: (next: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const stopCapture = useCallback(() => {
    setCapturing(false);
    setError(null);
  }, []);

  // Capture handler: intercept the next valid combo. We listen on the row's
  // DOM node (focused on entry to capture) rather than window-level so
  // simultaneous Settings interactions don't accidentally rebind.
  useEffect(() => {
    if (!capturing) return;
    const node = rowRef.current;
    if (!node) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Ignore modifier-only presses; wait for a real key.
      if (
        e.key === "Control" ||
        e.key === "Shift" ||
        e.key === "Alt" ||
        e.key === "Meta"
      ) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        stopCapture();
        return;
      }

      const accelerator = buildAccelerator(e);
      if (!accelerator) {
        setError("Shortcut must include at least one modifier (Ctrl/Alt/Shift/Cmd).");
        return;
      }
      onChange(accelerator);
      stopCapture();
    }

    node.addEventListener("keydown", handleKeyDown, true);
    node.focus();
    return () => {
      node.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [capturing, onChange, stopCapture]);

  const display = capturing ? "Press a key combo…" : formatAccelerator(value);
  const isDefault = value === defaultValue;

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-text-secondary flex-1">{label}</span>
      <div
        ref={rowRef}
        tabIndex={-1}
        onBlur={() => {
          // Cancel capture if the user clicks elsewhere.
          if (capturing) stopCapture();
        }}
        className="flex items-center gap-1.5 outline-none"
      >
        <kbd
          className={`px-1.5 py-0.5 text-[9px] font-mono rounded border ${
            capturing
              ? "bg-accent-purple/10 border-accent-purple/40 text-accent-purple animate-pulse"
              : "bg-bg-primary border-bg-border text-text-muted"
          }`}
        >
          {display}
        </kbd>
        {!capturing && (
          <>
            <button
              onClick={() => {
                setError(null);
                setCapturing(true);
              }}
              className="p-1 text-text-muted hover:text-accent-purple hover:bg-accent-purple/10 rounded transition-colors"
              title="Edit shortcut"
              aria-label={`Edit ${label} shortcut`}
            >
              <Edit3 size={10} />
            </button>
            {!isDefault && (
              <button
                onClick={() => onChange(defaultValue)}
                className="p-1 text-text-muted hover:text-accent-amber hover:bg-accent-amber/10 rounded transition-colors"
                title="Reset to default"
                aria-label={`Reset ${label} shortcut`}
              >
                <RotateCcw size={10} />
              </button>
            )}
          </>
        )}
        {capturing && (
          <button
            onClick={stopCapture}
            className="p-1 text-text-muted hover:text-accent-red hover:bg-accent-red/10 rounded transition-colors"
            title="Cancel"
            aria-label="Cancel capture"
          >
            <X size={10} />
          </button>
        )}
      </div>
      {error && (
        <span className="text-[9px] text-accent-red ml-2">{error}</span>
      )}
    </div>
  );
}

/**
 * Build a tauri-plugin-global-shortcut accelerator string from a KeyboardEvent.
 * Returns null if no modifier is held — bare keys are rejected to prevent
 * accidentally rebinding "a" to push-to-talk.
 *
 * The accelerator grammar accepted by the plugin is `Modifier+Modifier+Key`,
 * where `Modifier` ∈ {CommandOrControl, Control, Shift, Alt, Super} and `Key`
 * is a single character or a named key (`F1`, `Space`, `ArrowUp`, …). We emit
 * `CommandOrControl` for Ctrl/Cmd so the same binding works cross-platform.
 */
function buildAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (parts.length === 0) return null;

  // Normalize the key into something the plugin understands.
  let key = e.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else {
    // Pass through named keys; the plugin recognizes most of the standard
    // KeyboardEvent.key values (F1-F24, ArrowUp/Down/Left/Right, Space, etc.).
    if (key === " ") key = "Space";
  }
  parts.push(key);
  return parts.join("+");
}

/** Human-friendly rendering of an accelerator: "CommandOrControl+Shift+V" → "Ctrl+Shift+V" on Win/Linux. */
function formatAccelerator(acc: string): string {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  return acc
    .split("+")
    .map((part) => {
      if (part === "CommandOrControl") return isMac ? "Cmd" : "Ctrl";
      if (part === "Control") return "Ctrl";
      if (part === "Super") return isMac ? "Cmd" : "Win";
      return part;
    })
    .join("+");
}

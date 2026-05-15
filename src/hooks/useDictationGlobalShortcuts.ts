import { useEffect } from "react";
import {
  register,
  unregister,
  isRegistered,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { useDictationStore } from "@/stores/dictationStore";
import { useAppStore } from "@/stores/appStore";
import {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  DEFAULT_TOGGLE_SHORTCUT,
} from "@/types/dictation";

const SHORTCUT_OPEN = "CommandOrControl+Shift+D"; // open Dictation view (not user-rebindable)

type Handler = (event: ShortcutEvent) => void;

async function safeRegister(shortcut: string, handler: Handler) {
  try {
    if (await isRegistered(shortcut)) {
      await unregister(shortcut);
    }
    await register(shortcut, handler);
    return true;
  } catch (err) {
    // OS-level registration can fail (already taken, no accessibility permission, etc.) —
    // the in-window listeners in App.tsx remain as a fallback.
    console.warn(`[dictation] global shortcut ${shortcut} not registered:`, err);
    return false;
  }
}

async function safeUnregister(shortcut: string) {
  try {
    if (await isRegistered(shortcut)) await unregister(shortcut);
  } catch (err) {
    console.warn(`[dictation] global shortcut ${shortcut} not unregistered:`, err);
  }
}

/**
 * Registers OS-level global shortcuts for dictation so the hotkeys fire even
 * when PacketADE is not the focused application. Mount once at the App root.
 *
 * The push-to-talk and toggle accelerators are user-rebindable via the
 * Dictation settings card; they are read from the persisted DictationSettings
 * (falling back to the hardcoded defaults) and re-registered whenever those
 * values change. The "open Dictation" accelerator stays fixed.
 *
 * Double-fire safety: the in-window keyboard handler in App.tsx may also fire
 * for these same key combinations when PacketADE is focused. The dictation
 * store guards `start`/`stopRecording` against re-entry, so simultaneous
 * triggers collapse to a single action.
 */
export function useDictationGlobalShortcuts() {
  const pttShortcut = useDictationStore(
    (s) => s.settings?.pushToTalkShortcut ?? DEFAULT_PUSH_TO_TALK_SHORTCUT,
  );
  const toggleShortcut = useDictationStore(
    (s) => s.settings?.toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT,
  );

  useEffect(() => {
    let cancelled = false;

    const pttHandler: Handler = (event) => {
      const ds = useDictationStore.getState();
      if (event.state === "Pressed") {
        if (!ds.isRecording && !ds.isTranscribing) void ds.startRecording();
      } else if (event.state === "Released") {
        if (ds.isRecording) void ds.stopRecording();
      }
    };

    const toggleHandler: Handler = (event) => {
      if (event.state !== "Pressed") return;
      const ds = useDictationStore.getState();
      if (ds.isRecording) void ds.stopRecording();
      else void ds.startRecording();
    };

    const openHandler: Handler = (event) => {
      if (event.state !== "Pressed") return;
      useAppStore.getState().setActiveView("dictation");
    };

    void (async () => {
      const ok1 = await safeRegister(pttShortcut, pttHandler);
      if (cancelled) return;
      const ok2 = await safeRegister(toggleShortcut, toggleHandler);
      if (cancelled) return;
      const ok3 = await safeRegister(SHORTCUT_OPEN, openHandler);
      if (cancelled) return;
      console.info(
        `[dictation] global shortcuts: PTT=${ok1} toggle=${ok2} open=${ok3}`,
      );
    })();

    return () => {
      cancelled = true;
      // Best-effort cleanup; failures are non-fatal
      void safeUnregister(pttShortcut);
      void safeUnregister(toggleShortcut);
      void safeUnregister(SHORTCUT_OPEN);
    };
  }, [pttShortcut, toggleShortcut]);
}

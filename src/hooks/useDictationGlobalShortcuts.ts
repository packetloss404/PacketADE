import { useEffect } from "react";
import {
  register,
  unregister,
  isRegistered,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { useDictationStore } from "@/stores/dictationStore";
import { useAppStore } from "@/stores/appStore";

const SHORTCUT_PTT = "CommandOrControl+Shift+V"; // push-to-talk (hold)
const SHORTCUT_TOGGLE = "CommandOrControl+Shift+R"; // toggle recording
const SHORTCUT_OPEN = "CommandOrControl+Shift+D"; // open Dictation view

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

/**
 * Registers OS-level global shortcuts for dictation so the hotkeys fire even
 * when PacketADE is not the focused application. Mount once at the App root.
 *
 * Double-fire safety: the in-window keyboard handler in App.tsx may also fire
 * for these same key combinations when PacketADE is focused. The dictation
 * store guards `start`/`stopRecording` against re-entry, so simultaneous
 * triggers collapse to a single action.
 */
export function useDictationGlobalShortcuts() {
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
      const ok1 = await safeRegister(SHORTCUT_PTT, pttHandler);
      if (cancelled) return;
      const ok2 = await safeRegister(SHORTCUT_TOGGLE, toggleHandler);
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
      void unregister(SHORTCUT_PTT).catch(() => {});
      void unregister(SHORTCUT_TOGGLE).catch(() => {});
      void unregister(SHORTCUT_OPEN).catch(() => {});
    };
  }, []);
}

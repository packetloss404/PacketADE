import { useEffect } from "react";
import {
  register,
  unregister,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { useDictationStore } from "@/stores/dictationStore";
import { useAppStore } from "@/stores/appStore";
import {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  DEFAULT_TOGGLE_SHORTCUT,
  DICTATION_OPEN_SHORTCUT,
  validateDictationShortcuts,
} from "@/types/dictation";

type Handler = (event: ShortcutEvent) => void;

// Effect teardown and settings updates can overlap. A single queue guarantees
// that an older cleanup cannot unregister a freshly rebound shortcut.
let registrationQueue = Promise.resolve();
let generation = 0;
const ownedShortcuts = new Set<string>();

function enqueue(task: () => Promise<void>) {
  registrationQueue = registrationQueue.then(task, task);
}

async function unregisterOwned() {
  for (const shortcut of [...ownedShortcuts]) {
    try {
      await unregister(shortcut);
    } catch (error) {
      console.warn(`[dictation] global shortcut ${shortcut} was not released:`, error);
    } finally {
      ownedShortcuts.delete(shortcut);
    }
  }
}

/**
 * Registers opt-in OS-global dictation shortcuts. PacketADE only unregisters
 * accelerators it successfully registered itself; an existing OS/app binding
 * is reported as a conflict and is never taken over.
 */
export function useDictationGlobalShortcuts() {
  const enabled = useDictationStore(
    (state) => state.settings?.globalShortcutsEnabled ?? false,
  );
  const pttShortcut = useDictationStore(
    (state) => state.settings?.pushToTalkShortcut ?? DEFAULT_PUSH_TO_TALK_SHORTCUT,
  );
  const toggleShortcut = useDictationStore(
    (state) => state.settings?.toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT,
  );

  useEffect(() => {
    let disposed = false;
    const activeGeneration = ++generation;

    const pttHandler: Handler = (event) => {
      const state = useDictationStore.getState();
      if (event.state === "Pressed") {
        if (!state.isStarting && !state.isRecording && !state.isTranscribing) {
          void state.startRecording();
        }
      } else if (event.state === "Released" && (state.isStarting || state.isRecording)) {
        void state.stopRecording();
      }
    };

    const toggleHandler: Handler = (event) => {
      if (event.state !== "Pressed") return;
      const state = useDictationStore.getState();
      if (state.isStarting || state.isRecording) void state.stopRecording();
      else if (!state.isTranscribing) void state.startRecording();
    };

    const openHandler: Handler = (event) => {
      if (event.state === "Pressed") {
        useAppStore.getState().setActiveView("dictation");
      }
    };

    enqueue(async () => {
      await unregisterOwned();
      if (disposed || activeGeneration !== generation) return;

      if (!enabled) {
        useDictationStore.getState().setShortcutStatus({
          state: "disabled",
          message: "Global dictation shortcuts are off. In-app controls still work.",
        });
        return;
      }

      const validationError = validateDictationShortcuts(pttShortcut, toggleShortcut);
      if (validationError) {
        useDictationStore.getState().setShortcutStatus({
          state: "error",
          message: validationError,
        });
        return;
      }

      useDictationStore.getState().setShortcutStatus({
        state: "registering",
        message: "Registering global dictation shortcuts…",
      });

      try {
        const bindings: Array<[string, Handler]> = [
          [pttShortcut, pttHandler],
          [toggleShortcut, toggleHandler],
          [DICTATION_OPEN_SHORTCUT, openHandler],
        ];
        for (const [shortcut, handler] of bindings) {
          await register(shortcut, handler);
          ownedShortcuts.add(shortcut);
        }
        if (disposed || activeGeneration !== generation) {
          await unregisterOwned();
          return;
        }
        useDictationStore.getState().setShortcutStatus({
          state: "ready",
          message: "Global dictation shortcuts are active.",
        });
      } catch (error) {
        await unregisterOwned();
        useDictationStore.getState().setShortcutStatus({
          state: "error",
          message: `Shortcut registration failed or conflicts with another app: ${String(error)}`,
        });
      }
    });

    return () => {
      disposed = true;
      if (generation === activeGeneration) generation += 1;
      enqueue(unregisterOwned);
    };
  }, [enabled, pttShortcut, toggleShortcut]);
}

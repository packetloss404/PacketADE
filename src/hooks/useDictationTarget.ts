import { useEffect, useRef } from "react";
import { useDictationStore } from "@/stores/dictationStore";
import { deliverDictationText, writePty } from "@/lib/tauri";
import {
  findDictationTarget,
  insertDictationText,
  isDictationTargetUsable,
  type DictationTarget,
} from "@/lib/dictationTarget";

/**
 * Tracks the last safe PacketADE editing target and inserts a completed local
 * transcript. Password/OTP/sensitive regions are denied, terminals use the
 * PTY contract, and OS-global use falls back to explicit clipboard/paste rules.
 */
export function useDictationTarget() {
  const targetRef = useRef<DictationTarget | null>(null);

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const target = findDictationTarget(element);
      if (target) targetRef.current = target;
    };
    const handleWindowBlur = () => {
      targetRef.current = null;
    };
    document.addEventListener("focusin", handleFocusIn, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("focusin", handleFocusIn, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    if (!useDictationStore.getState().settings) {
      void useDictationStore.getState().loadSettings();
    }
  }, []);

  useEffect(() => {
    let previous = useDictationStore.getState().lastResult;
    return useDictationStore.subscribe((state) => {
      const result = state.lastResult;
      if (result === previous) return;
      previous = result;
      if (!result || !state.settings?.autoPaste) return;

      const target = targetRef.current;
      if (target && isDictationTargetUsable(target)) {
        if (target.kind === "dom") {
          target.element.focus();
          insertDictationText(target.element, result);
          state.setDeliveryNotice(null);
        } else {
          void writePty(target.sessionId, result)
            .then(() => useDictationStore.getState().setDeliveryNotice(null))
            .catch((error) =>
              useDictationStore
                .getState()
                .setDeliveryNotice(`Terminal insertion failed: ${String(error)}`),
            );
        }
        return;
      }

      targetRef.current = null;
      const paste = state.settings.systemWidePaste;
      void deliverDictationText(result, paste)
        .then(() => {
          useDictationStore
            .getState()
            .setDeliveryNotice(
              paste
                ? "Inserted into the foreground app. The transcript remains on the clipboard."
                : "Copied to the clipboard.",
            );
        })
        .catch(async (nativeError) => {
          try {
            if (!navigator.clipboard?.writeText) throw nativeError;
            await navigator.clipboard.writeText(result);
            useDictationStore.getState().setDeliveryNotice("Copied to the clipboard.");
          } catch (clipboardError) {
            useDictationStore
              .getState()
              .setDeliveryNotice(
                `Transcription is ready, but delivery failed: ${String(clipboardError)}`,
              );
          }
        });
    });
  }, []);
}

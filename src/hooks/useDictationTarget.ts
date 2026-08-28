import { useEffect, useRef } from "react";
import { useDictationStore } from "@/stores/dictationStore";
import { deliverDictationText, writePty } from "@/lib/tauri";
import {
  findDictationTarget,
  insertDictationText,
  isDictationCaptureClaimed,
  isDictationTargetUsable,
  isSecureDictationTarget,
  type DictationTarget,
} from "@/lib/dictationTarget";

/**
 * Tracks the last safe PacketBench editing target and inserts a completed local
 * transcript. Password/OTP/sensitive regions are denied, terminals use the
 * PTY contract, and OS-global use falls back to explicit clipboard/paste rules.
 *
 * The destination is frozen when the capture *starts*, not when the transcript
 * returns. Transcription takes seconds; the user routinely clicks elsewhere
 * while it runs, and delivering into whatever happens to be focused at that
 * moment types their words into an unrelated field — or, for a terminal pane,
 * into a live shell.
 */
export function useDictationTarget() {
  const targetRef = useRef<DictationTarget | null>(null);

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const target = findDictationTarget(element);
      if (target) {
        targetRef.current = target;
        return;
      }
      // Focus landed on something ineligible. Buttons, tabs, and the mic
      // control itself must NOT clear the remembered field — clicking the mic
      // button is the normal way to start dictating. A secure region is the
      // exception: keeping the previous field there would let a transcript
      // spoken at a password prompt land in the form behind it.
      if (element && isSecureDictationTarget(element)) targetRef.current = null;
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
    const initial = useDictationStore.getState();
    let armedCaptureId = initial.captureId;
    let armedTarget: DictationTarget | null = null;
    // Correlate on the capture id, not on the transcript string: dictating the
    // same word twice in a row produced an identical `lastResult` and the
    // second delivery was silently skipped.
    let deliveredCaptureId = initial.lastResultCaptureId;

    return useDictationStore.subscribe((state) => {
      if (state.captureId !== armedCaptureId) {
        // A capture just began. Freeze the destination while the user is still
        // looking at the field they mean to dictate into.
        armedCaptureId = state.captureId;
        armedTarget = targetRef.current;
      }

      const resultCaptureId = state.lastResultCaptureId;
      if (resultCaptureId === null || resultCaptureId === deliveredCaptureId) return;
      deliveredCaptureId = resultCaptureId;

      const result = state.lastResult;
      if (!result || !state.settings?.autoPaste) return;
      // The surface that started this capture inserts the text itself; a second
      // insertion here duplicated the utterance in the composer.
      if (isDictationCaptureClaimed(resultCaptureId)) {
        armedTarget = null;
        return;
      }

      // Only the target armed for *this* capture is eligible. Anything else
      // (including a field focused during transcription) falls through to the
      // explicit clipboard/paste path rather than being typed into blind.
      const target = resultCaptureId === armedCaptureId ? armedTarget : null;
      armedTarget = null;

      if (target && isDictationTargetUsable(target)) {
        if (target.kind === "dom") {
          target.element.focus();
          insertDictationText(target.element, result);
          state.setDeliveryNotice(null);
        } else {
          // A PTY write is keystrokes into a live shell: a newline submits.
          // Whisper emits multi-line output for multi-segment audio, so strip
          // line breaks — dictation must never execute a command on its own.
          const ptyText = result.replace(/[\r\n]+/g, " ").trim();
          if (!ptyText) {
            useDictationStore.getState().setDeliveryNotice(null);
            return;
          }
          void writePty(target.sessionId, ptyText)
            .then(() => useDictationStore.getState().setDeliveryNotice(null))
            .catch((error) =>
              useDictationStore
                .getState()
                .setDeliveryNotice(`Terminal insertion failed: ${String(error)}`),
            );
        }
        return;
      }

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

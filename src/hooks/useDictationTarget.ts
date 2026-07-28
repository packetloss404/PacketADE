import { useEffect, useRef } from "react";
import { useDictationStore } from "@/stores/dictationStore";
import { deliverDictationText } from "@/lib/tauri";

type TextEditable = HTMLInputElement | HTMLTextAreaElement;

function isTextEditable(el: Element | null): el is TextEditable {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") {
    const ta = el as HTMLTextAreaElement;
    return !ta.readOnly && !ta.disabled;
  }
  if (el.tagName === "INPUT") {
    const inp = el as HTMLInputElement;
    if (inp.readOnly || inp.disabled) return false;
    const t = inp.type;
    return (
      t === "" || t === "text" || t === "search" || t === "url" || t === "email" || t === "tel"
    );
  }
  return false;
}

function shouldTrack(el: Element): boolean {
  // Skip xterm.js terminal internals — terminals expect keypress streams, not value mutation
  if (el.classList.contains("xterm-helper-textarea")) return false;
  if (el.closest(".xterm")) return false;
  // Explicit opt-out for inputs that should never receive dictated text (e.g., search box inside the Dictation view itself)
  if (el.closest('[data-dictation="off"]')) return false;
  return true;
}

function insertAtCursor(el: TextEditable, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  // Use the native setter so React's controlled-input handlers see the change
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const cursor = start + text.length;
  try {
    el.setSelectionRange(cursor, cursor);
  } catch {
    // Some input types (email, url) don't support setSelectionRange — ignore
  }
}

/**
 * Tracks the most recently focused text input across the app and inserts
 * the transcribed dictation result at its cursor when transcription finishes.
 * Respects the `autoPaste` setting (defaults to off if settings are unloaded).
 * Mount once at the App root.
 */
export function useDictationTarget() {
  const targetRef = useRef<TextEditable | null>(null);

  // Track most-recently-focused valid text input
  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!isTextEditable(t)) return;
      if (!shouldTrack(t)) return;
      targetRef.current = t;
    };
    document.addEventListener("focusin", handleFocusIn, true);
    const handleWindowBlur = () => {
      // An OS-global recording started in another app must not deliver to a
      // stale PacketADE field that happened to be focused previously.
      targetRef.current = null;
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("focusin", handleFocusIn, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  // Ensure settings are loaded so autoPaste can be honoured
  useEffect(() => {
    if (!useDictationStore.getState().settings) {
      void useDictationStore.getState().loadSettings();
    }
  }, []);

  // Insert transcribed text when a new result lands
  useEffect(() => {
    let prev: string | null = useDictationStore.getState().lastResult;
    const unsub = useDictationStore.subscribe((state) => {
      const result = state.lastResult;
      if (result === prev) return;
      prev = result;
      if (!result) return;
      const autoPaste = state.settings?.autoPaste ?? false;
      if (!autoPaste) return;
      const el = targetRef.current;
      if (el && document.body.contains(el)) {
        el.focus();
        insertAtCursor(el, result);
        state.setDeliveryNotice(null);
        return;
      }
      // No tracked PacketADE input (for example, an OS-global shortcut in
      // another app). Native delivery is opt-in; clipboard-only is the default.
      targetRef.current = null;
      const paste = state.settings?.systemWidePaste ?? false;
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
    return unsub;
  }, []);
}

import { useEffect, useRef } from "react";
import { useDictationStore } from "@/stores/dictationStore";

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
    return t === "" || t === "text" || t === "search" || t === "url" || t === "email" || t === "tel";
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
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
 * Respects the `autoPaste` setting (defaults to true if settings unloaded).
 * Mount once at the App root.
 */
export function useDictationTarget() {
  const targetRef = useRef<TextEditable | null>(null);
  const lastInsertedRef = useRef<string | null>(null);

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
    return () => document.removeEventListener("focusin", handleFocusIn, true);
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
      if (result === lastInsertedRef.current) return;
      const autoPaste = state.settings?.autoPaste ?? true;
      if (!autoPaste) return;
      lastInsertedRef.current = result;
      const el = targetRef.current;
      if (el && document.body.contains(el)) {
        el.focus();
        insertAtCursor(el, result);
        return;
      }
      // No tracked PacketADE input (e.g., recorded via OS-global hotkey while another
      // app was focused). Fall back to clipboard so the user can paste anywhere.
      targetRef.current = null;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(result).catch(() => {});
      }
    });
    return unsub;
  }, []);
}

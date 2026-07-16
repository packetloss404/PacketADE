import { useEffect, useRef } from "react";
import { useVoiceInput } from "@/hooks/useVoiceInput";

/**
 * Bridges `useVoiceInput` into a setter callback: only the newly-added suffix
 * of the transcript is appended (web-speech emits the full cumulative string on
 * every interim result). Returns the underlying voice controls so callers can
 * render mic UI.
 */
export function useVoiceTranscript(appendText: (chunk: string) => void) {
  const voice = useVoiceInput();
  const prevTranscriptRef = useRef("");
  const appendRef = useRef(appendText);
  appendRef.current = appendText;

  useEffect(() => {
    const cur = voice.transcript;
    const prev = prevTranscriptRef.current;
    if (cur && cur !== prev) {
      // Web-speech mode emits the FULL cumulative transcript on every interim
      // result ("h" -> "he" -> "hello"). Append only the newly-added suffix;
      // on a reset/new utterance (no longer a prefix) append the whole value.
      const delta = cur.startsWith(prev) ? cur.slice(prev.length) : cur;
      prevTranscriptRef.current = cur;
      if (delta) appendRef.current(delta);
    }
  }, [voice.transcript]);

  return voice;
}

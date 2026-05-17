import { useEffect, useRef } from "react";
import { useVoiceInput } from "@/hooks/useVoiceInput";

/**
 * Bridges `useVoiceInput` into a setter callback: each fresh transcript chunk
 * is appended exactly once. Returns the underlying voice controls so callers
 * can render mic UI.
 */
export function useVoiceTranscript(appendText: (chunk: string) => void) {
  const voice = useVoiceInput();
  const prevTranscriptRef = useRef("");
  const appendRef = useRef(appendText);
  appendRef.current = appendText;

  useEffect(() => {
    if (voice.transcript && voice.transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = voice.transcript;
      appendRef.current(voice.transcript);
    }
  }, [voice.transcript]);

  return voice;
}

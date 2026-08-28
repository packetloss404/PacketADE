import { useState, useCallback, useRef, useEffect } from "react";
import { listAudioDevices, listWhisperModels } from "@/lib/tauri";
import { useDictationStore } from "@/stores/dictationStore";
import { claimDictationCapture, releaseDictationCapture } from "@/lib/dictationTarget";

type VoiceMode = "web" | "native";

interface UseVoiceInputReturn {
  isListening: boolean;
  transcript: string;
  startListening: () => void;
  stopListening: () => void;
  isSupported: boolean;
  mode: VoiceMode;
}

// Web Speech API types — not in all TS libs
interface SpeechRecognitionEvent {
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

async function checkNativeAvailable(): Promise<boolean> {
  try {
    const [modelRaw, deviceRaw] = await Promise.all([listWhisperModels(), listAudioDevices()]);
    const models = (typeof modelRaw === "string" ? JSON.parse(modelRaw) : modelRaw) as {
      downloaded: boolean;
    }[];
    const devices = (
      typeof deviceRaw === "string" ? JSON.parse(deviceRaw) : deviceRaw
    ) as unknown[];
    return models.some((model) => model.downloaded) && devices.length > 0;
  } catch {
    return false;
  }
}

const webSpeechSupported =
  typeof window !== "undefined" &&
  ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

/**
 * Voice input hook with automatic native Whisper detection.
 * If a Whisper model is downloaded, uses native mode; otherwise falls back to Web Speech API.
 * Pass an explicit mode to override auto-detection.
 */
export function useVoiceInput(explicitMode?: VoiceMode): UseVoiceInputReturn {
  const modelReadinessKey = useDictationStore((state) =>
    state.models.map((model) => `${model.size}:${model.downloaded}`).join("|"),
  );
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [detectedMode, setDetectedMode] = useState<VoiceMode>("web");
  const [nativeReady, setNativeReady] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  /**
   * `captureId` of the native capture this hook started, or null. Several
   * surfaces mount this hook and a global push-to-talk can also drive the
   * store, so ownership has to be explicit: without it, one composer would
   * claim (and later stop, or cancel on unmount) another surface's recording.
   */
  const ownedCaptureRef = useRef<number | null>(null);

  // Re-check native readiness after model installs as well as on mount.
  useEffect(() => {
    let cancelled = false;
    void checkNativeAvailable().then((available) => {
      if (cancelled) return;
      setNativeReady(available);
      if (!explicitMode) setDetectedMode(available ? "native" : "web");
    });
    return () => {
      cancelled = true;
    };
  }, [explicitMode, modelReadinessKey]);

  const mode = explicitMode ?? detectedMode;

  // Native mode requires both a verified model and an active capture device.
  const isSupported = mode === "native" ? nativeReady : webSpeechSupported;

  // Mirror the latest mode into a ref so the unmount cleanup can stop the right
  // backend without re-subscribing on every state change.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Relay the native transcript out of the store. `stopRecording()`'s return
  // value is not enough: a push-to-talk release that lands while the microphone
  // is still opening is queued by the store and returns "" immediately, which
  // used to blank the composer instead of inserting the eventual text.
  useEffect(() => {
    return useDictationStore.subscribe((state) => {
      const owned = ownedCaptureRef.current;
      if (owned === null) return;
      if (state.lastResultCaptureId === owned) {
        ownedCaptureRef.current = null;
        setIsListening(false);
        if (state.lastResult) setTranscript(state.lastResult);
        return;
      }
      // The capture was cancelled, superseded, or torn down by a device error
      // (the store retires the generation in all three cases). Release the mic
      // indicator instead of leaving a composer that listens forever.
      if (state.captureId !== owned || state.status === "error") {
        ownedCaptureRef.current = null;
        setIsListening(false);
      }
    });
  }, []);

  // F38: stop any in-flight recording/recognition when the hook unmounts so a
  // dangling Web Speech listener or native Whisper capture can't outlive the
  // component — leaking the microphone and firing setState after unmount.
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        // Detach handlers first so onend/onerror can't setState post-unmount.
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        try {
          recognitionRef.current.stop();
        } catch {
          // already stopped / not started — nothing to release
        }
        recognitionRef.current = null;
      }
      const owned = ownedCaptureRef.current;
      ownedCaptureRef.current = null;
      if (owned !== null) {
        // This surface is gone and can no longer insert the text; hand the
        // capture back so `useDictationTarget` can deliver or fall back.
        releaseDictationCapture(owned);
      }
      if (modeRef.current !== "native" || owned === null) return;
      const state = useDictationStore.getState();
      // Discard an abandoned composer recording instead of transcribing it —
      // but only this hook's own capture, and only while the microphone is
      // still open. A transcription already running belongs to whoever
      // receives it next (useDictationTarget), not to an unmounting composer.
      if (state.captureId === owned && (state.isStarting || state.isRecording)) {
        void state.cancelRecording();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (mode === "native") {
      const before = useDictationStore.getState().captureId;
      void useDictationStore.getState().startRecording();
      // `startRecording` bumps `captureId` synchronously, before its first
      // await. An unchanged id means its re-entrancy guard rejected us because
      // a capture is already in flight — showing a live mic here would promise
      // a transcript this surface will never receive.
      const after = useDictationStore.getState().captureId;
      if (after === before) return;
      ownedCaptureRef.current = after;
      // This surface delivers the transcript itself (see `useVoiceTranscript`),
      // so `useDictationTarget` must not auto-paste the same text on top of it.
      claimDictationCapture(after);
      setIsListening(true);
      setTranscript("");
      return;
    }

    // Web Speech API path
    if (!webSpeechSupported) return;

    const w = window as unknown as Record<string, new () => SpeechRecognitionInstance>;
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      for (let i = 0; i < event.results.length; i++) {
        finalTranscript += event.results[i][0].transcript;
      }
      setTranscript(finalTranscript);
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setTranscript("");
  }, [mode]);

  const stopListening = useCallback(() => {
    if (mode === "native") {
      setIsListening(false);
      // The transcript arrives through the store subscription above; the
      // resolved value is deliberately ignored so a queued (fast press/release)
      // stop cannot overwrite it with an empty string.
      void useDictationStore
        .getState()
        .stopRecording()
        .catch((error) => console.warn("[useVoiceInput.stopListening] failed:", error));
      return;
    }

    // Web Speech API path
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [mode]);

  return {
    isListening,
    transcript,
    startListening,
    stopListening,
    isSupported,
    mode,
  };
}
